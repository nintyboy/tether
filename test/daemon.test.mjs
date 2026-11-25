import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startBridge } from '../mod/bridge/daemon.mjs';
import { STALE_AFTER_MS } from '../mod/bridge/core.mjs';

// Unix socket paths are limited to ~104 bytes, so keep the dir short.
const tempDir = () => mkdtempSync(join(tmpdir(), 'fc-'));

function call({ port, socketPath, method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: port ? '127.0.0.1' : undefined, port, socketPath, method, path, headers }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: text && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const payload = {
  fileKey: 'AbCdEfGhIj0123456789xy',
  fileName: 'Acme Design System',
  page: { id: '4486:9625', name: 'CR: Onboarding' },
  selection: [{ id: '6057:5219', name: 'Frame 17', type: 'FRAME' }],
  selectionCount: 1,
};

async function withBridge(fn, options = {}) {
  const dir = tempDir();
  let clock = 1_000_000;
  const bridge = await startBridge({ dir, port: 0, now: () => clock, ...options });
  try {
    await fn({ bridge, dir, tick: ms => { clock += ms; } });
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a paired write is readable over the socket', () => withBridge(async ({ bridge }) => {
  const write = await call({
    port: bridge.port, method: 'POST', path: '/selection',
    headers: { 'Content-Type': 'application/json', 'X-Tether-Token': bridge.token },
    body: payload,
  });
  assert.equal(write.status, 200);

  const read = await call({ socketPath: bridge.socketPath, path: '/selection' });
  assert.equal(read.status, 200);
  assert.equal(read.json.selection.nodes[0].id, '6057:5219');
  assert.equal(read.json.selection.fileKey, 'AbCdEfGhIj0123456789xy');
}));

test('a write without the right token is refused and changes nothing', () => withBridge(async ({ bridge }) => {
  for (const headers of [{}, { 'X-Tether-Token': 'wrong' }, { 'X-Tether-Token': `${bridge.token}x` }]) {
    const res = await call({ port: bridge.port, method: 'POST', path: '/selection', headers, body: payload });
    assert.equal(res.status, 401);
  }
  const read = await call({ socketPath: bridge.socketPath, path: '/selection' });
  assert.equal(read.json.selection, null);
}));

test('the selection cannot be read over TCP', () => withBridge(async ({ bridge }) => {
  const res = await call({ port: bridge.port, path: '/selection' });
  assert.equal(res.status, 404);
}));

test('CORS preflight is answered for the plugin iframe', () => withBridge(async ({ bridge }) => {
  const res = await call({ port: bridge.port, method: 'OPTIONS', path: '/selection', headers: { Origin: 'null' } });
  assert.equal(res.status, 204);
  assert.match(res.headers['access-control-allow-headers'], /X-Tether-Token/);
  assert.equal(res.headers['access-control-allow-private-network'], 'true');
}));

test('bad bodies get a 400 and leave the last good selection', () => withBridge(async ({ bridge }) => {
  const headers = { 'X-Tether-Token': bridge.token };
  await call({ port: bridge.port, method: 'POST', path: '/selection', headers, body: payload });
  assert.equal((await call({ port: bridge.port, method: 'POST', path: '/selection', headers, body: '{nope' })).status, 400);
  assert.equal((await call({ port: bridge.port, method: 'POST', path: '/selection', headers, body: { ...payload, fileKey: '../x' } })).status, 400);
  const read = await call({ socketPath: bridge.socketPath, path: '/selection' });
  assert.equal(read.json.selection.nodes[0].name, 'Frame 17');
}));

test('an oversized body is refused', () => withBridge(async ({ bridge }) => {
  const res = await call({
    port: bridge.port, method: 'POST', path: '/selection',
    headers: { 'X-Tether-Token': bridge.token },
    body: 'x'.repeat(70 * 1024),
  }).catch(err => ({ status: err.code }));
  assert.ok(res.status === 413 || res.status === 'ECONNRESET' || res.status === 'EPIPE', `got ${res.status}`);
}));

test('the selection goes stale when the plugin stops sending', () => withBridge(async ({ bridge, tick }) => {
  await call({ port: bridge.port, method: 'POST', path: '/selection', headers: { 'X-Tether-Token': bridge.token }, body: payload });
  tick(STALE_AFTER_MS + 1);
  const read = await call({ socketPath: bridge.socketPath, path: '/selection' });
  assert.equal(read.json.selection, null);
}));

test('the token is stable, private, and the socket owner-only', () => withBridge(async ({ bridge, dir }) => {
  assert.match(bridge.token, /^[0-9a-f]{32}$/);
  assert.equal(readFileSync(join(dir, 'token'), 'utf8').trim(), bridge.token);
  assert.equal(statSync(join(dir, 'token')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(bridge.socketPath).mode & 0o777, 0o600);
}));

test('a second bridge on the same dir refuses to start', () => withBridge(async ({ bridge, dir }) => {
  await assert.rejects(startBridge({ dir, port: 0 }), err => err.code === 'EADDRINUSE');
  // The first one still answers.
  assert.equal((await call({ socketPath: bridge.socketPath, path: '/health' })).status, 200);
}));

test('a second bridge on the same port refuses to start', () => withBridge(async ({ bridge }) => {
  const other = tempDir();
  try {
    await assert.rejects(startBridge({ dir: other, port: bridge.port }), err => err.code === 'EADDRINUSE');
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
}));

test('it reports idle once nobody reads for long enough', async () => {
  let idled = false;
  const dir = tempDir();
  let clock = 0;
  const bridge = await startBridge({ dir, port: 0, now: () => clock, idleExitMs: 20, onIdle: () => { idled = true; } });
  try {
    clock = 1_000;
    await new Promise(r => setTimeout(r, 60));
    assert.ok(idled);
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/status serves one plain line, empty when nothing is selected or stale', () => withBridge(async ({ bridge, tick }) => {
  const empty = await call({ socketPath: bridge.socketPath, path: '/status' });
  assert.equal(empty.status, 200);
  assert.equal(empty.text, '');

  await call({ port: bridge.port, method: 'POST', path: '/selection', headers: { 'X-Tether-Token': bridge.token }, body: payload });
  const shown = await call({ socketPath: bridge.socketPath, path: '/status' });
  assert.match(shown.headers['content-type'], /^text\/plain/);
  assert.ok(shown.text.endsWith(' Frame 17'));

  tick(STALE_AFTER_MS + 1);
  assert.equal((await call({ socketPath: bridge.socketPath, path: '/status' })).text, '');
}));

test('/status is not served over TCP', () => withBridge(async ({ bridge }) => {
  assert.equal((await call({ port: bridge.port, path: '/status' })).status, 404);
}));

test('health reports the version and update status; the plugin hears about updates too', async () => {
  const updates = { status: () => ({ current: '0.1.0', latest: '0.2.0', available: true }) };
  await withBridge(async ({ bridge }) => {
    const health = await call({ socketPath: bridge.socketPath, path: '/health' });
    assert.deepEqual(health.json, { ok: true, version: '0.1.0', update: { current: '0.1.0', latest: '0.2.0', available: true } });
    const write = await call({ port: bridge.port, method: 'POST', path: '/selection', headers: { 'X-Tether-Token': bridge.token }, body: payload });
    assert.equal(write.json.update.latest, '0.2.0');
  }, { version: '0.1.0', updates });
});

test('without an update checker, health still answers', () => withBridge(async ({ bridge }) => {
  const health = await call({ socketPath: bridge.socketPath, path: '/health' });
  assert.deepEqual(health.json, { ok: true, version: null, update: null });
}));

test('the socket owner can ask the bridge to make way; TCP cannot', async () => {
  let asked = 0;
  await withBridge(async ({ bridge }) => {
    const viaTcp = await call({ port: bridge.port, method: 'POST', path: '/shutdown', headers: { 'X-Tether-Token': bridge.token } });
    assert.equal(viaTcp.status, 404);
    const viaSocket = await call({ socketPath: bridge.socketPath, method: 'POST', path: '/shutdown' });
    assert.equal(viaSocket.status, 200);
    await new Promise(r => setImmediate(r));
    assert.equal(asked, 1);
  }, { onShutdown: () => { asked++; } });
});

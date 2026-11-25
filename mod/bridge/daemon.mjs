#!/usr/bin/env node
// Tether bridge. One per machine, shared by every Claude Code session.
//
//   Figma plugin --POST, token--> http://localhost:47821/selection   (write only)
//   Claude Code mod --GET-------> ~/.tether/bridge.sock         (read only)
//
// Reads never go over TCP, so a web page cannot read your selection; writes
// need the pairing token, so a web page cannot inject a fake one.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MAX_BODY_BYTES, sanitize, statusLine, view } from './core.mjs';

export const DEFAULT_PORT = 47821;
const IDLE_EXIT_MS = 10 * 60_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Tether-Token',
  'Access-Control-Allow-Private-Network': 'true',
};

export function loadToken(dir) {
  const file = join(dir, 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(16).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function tokenMatches(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function socketIsLive(path) {
  return new Promise(resolve => {
    const probe = connect(path);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => { server.off('error', reject); resolve(); });
  });
}

export async function startBridge({
  dir = join(homedir(), '.tether'),
  port = DEFAULT_PORT,
  now = () => Date.now(),
  idleExitMs = IDLE_EXIT_MS,
  onIdle = () => {},
  log = () => {},
} = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const token = loadToken(dir);
  const socketPath = join(dir, 'bridge.sock');
  let latest = null;
  let lastRead = now();

  const writer = (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }
    if (req.method !== 'POST' || req.url !== '/selection') { send(res, 404, { error: 'not found' }, CORS); return; }
    if (!tokenMatches(req.headers['x-tether-token'], token)) { send(res, 401, { error: 'bad or missing token' }, CORS); return; }

    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { send(res, 413, { error: 'body too large' }, CORS); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(res, 400, { error: 'invalid JSON' }, CORS); return; }
      const { snapshot, error } = sanitize(payload);
      if (error) { send(res, 400, { error }, CORS); return; }
      latest = { snapshot, receivedAt: now() };
      send(res, 200, { ok: true }, CORS);
    });
  };

  const reader = (req, res) => {
    lastRead = now();
    if (req.method === 'GET' && req.url === '/health') { send(res, 200, { ok: true }); return; }
    if (req.method === 'GET' && req.url === '/selection') { send(res, 200, view(latest, now())); return; }
    // Plain text for status bars (ccstatusline and the like): "" when nothing is selected.
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(statusLine(view(latest, now()).selection));
      return;
    }
    send(res, 404, { error: 'not found' });
  };

  // The TCP port doubles as the one-per-machine lock: whoever binds it first
  // owns the socket file too.
  const tcp4 = createServer(writer);
  const tcp6 = createServer(writer);
  await listen(tcp4, port, '127.0.0.1');
  port = tcp4.address().port;
  try {
    await listen(tcp6, port, '::1');
  } catch (err) {
    if (err.code !== 'EADDRNOTAVAIL') { tcp4.close(); throw err; }
  }

  if (existsSync(socketPath)) {
    if (await socketIsLive(socketPath)) { tcp4.close(); tcp6.close(); throw Object.assign(new Error('another bridge owns the socket'), { code: 'EADDRINUSE' }); }
    unlinkSync(socketPath);
  }
  const unix = createServer(reader);
  await listen(unix, socketPath);
  chmodSync(socketPath, 0o600);
  log(`bridge up: http://localhost:${port} (write), ${socketPath} (read)`);

  const idle = setInterval(() => { if (now() - lastRead > idleExitMs) onIdle(); }, Math.min(idleExitMs, 30_000));
  idle.unref();

  async function close() {
    clearInterval(idle);
    await Promise.all([tcp4, tcp6, unix].map(s => new Promise(r => (s.listening ? s.close(() => r()) : r()))));
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }

  return { token, socketPath, port, close };
}

// Run directly (not imported by a test)? Compare real paths: the mod launches
// this file through a symlink, while import.meta.url is always the real path.
function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
}

if (isMain()) {
  const log = msg => console.log(`${new Date().toISOString()} ${msg}`);
  try {
    const bridge = await startBridge({
      port: process.env.TETHER_PORT ? Number(process.env.TETHER_PORT) : DEFAULT_PORT,
      log,
      onIdle: async () => { log('no readers for 10 min, exiting'); await bridge.close(); process.exit(0); },
    });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await bridge.close(); process.exit(0); });
  } catch (err) {
    if (err.code === 'EADDRINUSE') { log('a bridge is already running'); process.exit(0); }
    throw err;
  }
}

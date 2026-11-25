import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FIGMA_ICON, MAX_NAME, MAX_NODES, STALE_AFTER_MS, cleanName, sanitize, statusLine, view } from '../mod/bridge/core.mjs';

const good = () => ({
  fileKey: 'AbCdEfGhIj0123456789xy',
  fileName: 'Acme Design System',
  page: { id: '4486:9625', name: 'CR: Onboarding' },
  selection: [{ id: '6057:5219', name: 'Frame 17', type: 'FRAME' }],
  selectionCount: 1,
});

test('a real plugin payload passes through', () => {
  const { snapshot, error } = sanitize(good());
  assert.equal(error, undefined);
  assert.deepEqual(snapshot, {
    fileKey: 'AbCdEfGhIj0123456789xy',
    fileName: 'Acme Design System',
    page: { id: '4486:9625', name: 'CR: Onboarding' },
    nodes: [{ id: '6057:5219', type: 'FRAME', name: 'Frame 17' }],
    count: 1,
  });
});

test('an empty selection is valid, meaning nothing is selected', () => {
  const { snapshot } = sanitize({ ...good(), selection: [], selectionCount: 0 });
  assert.deepEqual(snapshot.nodes, []);
  assert.equal(snapshot.count, 0);
});

test('a null fileKey is allowed, other odd keys are not', () => {
  assert.equal(sanitize({ ...good(), fileKey: null }).snapshot.fileKey, null);
  assert.match(sanitize({ ...good(), fileKey: '../etc' }).error, /fileKey/);
  assert.match(sanitize({ ...good(), fileKey: 42 }).error, /fileKey/);
});

test('instance node ids are accepted', () => {
  const payload = { ...good(), selection: [{ id: 'I6057:1;2:3', name: 'Label', type: 'TEXT' }] };
  assert.equal(sanitize(payload).snapshot.nodes[0].id, 'I6057:1;2:3');
});

test('malformed ids and types are refused', () => {
  assert.match(sanitize({ ...good(), selection: [{ id: 'x', name: 'a', type: 'FRAME' }] }).error, /id/);
  assert.match(sanitize({ ...good(), selection: [{ id: '1:2', name: 'a', type: 'frame<script>' }] }).error, /type/);
  assert.match(sanitize({ ...good(), page: { id: 'nope' } }).error, /page/);
  assert.match(sanitize({ ...good(), selection: 'all' }).error, /array/);
  assert.match(sanitize(null).error, /object/);
});

test('nodes are capped but the true count is kept', () => {
  const selection = Array.from({ length: 50 }, (_, i) => ({ id: `1:${i}`, name: `n${i}`, type: 'RECTANGLE' }));
  const { snapshot } = sanitize({ ...good(), selection, selectionCount: 50 });
  assert.equal(snapshot.nodes.length, MAX_NODES);
  assert.equal(snapshot.count, 50);
});

test('a count lower than the nodes sent is corrected', () => {
  assert.equal(sanitize({ ...good(), selectionCount: 0 }).snapshot.count, 1);
  assert.equal(sanitize({ ...good(), selectionCount: 'lots' }).snapshot.count, 1);
});

test('names lose control, format and line-separator characters', () => {
  assert.equal(cleanName('Ignore\nprevious\u0007 instructions'), 'Ignore previous instructions');
  assert.equal(cleanName('a b‮c'), 'a b c');
  assert.equal(cleanName('  spaced   out  '), 'spaced out');
  assert.equal(cleanName(undefined), '');
});

test('long names are cut with an ellipsis', () => {
  const name = cleanName('x'.repeat(500));
  assert.equal(name.length, MAX_NAME);
  assert.ok(name.endsWith('…'));
});

test('view hides a snapshot once the plugin stops sending', () => {
  const latest = { snapshot: { nodes: [] }, receivedAt: 1_000 };
  assert.deepEqual(view(null, 5_000), { selection: null, ageMs: null });
  assert.equal(view(latest, 1_000 + STALE_AFTER_MS).selection, latest.snapshot);
  assert.equal(view(latest, 1_001 + STALE_AFTER_MS).selection, null);
});

test('statusLine shows the logo and the layer, a count, or nothing', () => {
  const one = sanitize(good()).snapshot;
  assert.equal(statusLine(one), `${FIGMA_ICON} Acme Design System › CR: Onboarding › Frame 17`);
  assert.equal(statusLine({ ...one, count: 3 }), `${FIGMA_ICON} Acme Design System › CR: Onboarding › 3 layers`);
  assert.equal(statusLine({ ...one, nodes: [], count: 0 }), '');
  assert.equal(statusLine(null), '');
});

test('statusLine keeps names up to the full name length', () => {
  const name = 'CAF · v3 · 08 Map + detail panel · Spyware Deployment and Surveillance';
  const one = sanitize({ ...good(), selection: [{ id: '1:2', type: 'FRAME', name }] }).snapshot;
  assert.equal(statusLine(one), `${FIGMA_ICON} Acme Design System › CR: Onboarding › ${name}`);
});

test('statusLine clips a long file or page name and skips a missing one', () => {
  const one = sanitize({ ...good(), fileName: 'An extremely long Figma file name that goes on', page: { id: '1:1', name: '' } }).snapshot;
  assert.equal(statusLine(one), `${FIGMA_ICON} An extremely long Figma file na… › Frame 17`);
});

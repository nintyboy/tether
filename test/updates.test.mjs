import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateChecker, isNewer, parseVersion, readManifest, syncFigmaPlugin } from '../mod/bridge/updates.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-updates-'));

test('versions compare numerically, with or without a v', () => {
  assert.deepEqual(parseVersion('v1.10.0'), [1, 10, 0]);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('v0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('nightly', '0.1.0'), false);
  assert.equal(isNewer(null, '0.1.0'), false);
});

test('the manifest gives the version and the GitHub repo', () => {
  const root = tmp();
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.3.1', repository: 'https://github.com/someone/tether' }));
  assert.deepEqual(readManifest(root), { version: '0.3.1', repo: 'someone/tether' });
});

test('the Figma plugin is copied to a folder that does not move, replacing old files', () => {
  const root = tmp();
  const dir = tmp();
  mkdirSync(join(root, 'figma-plugin'));
  writeFileSync(join(root, 'figma-plugin', 'manifest.json'), '{"v":2}');
  mkdirSync(join(dir, 'figma-plugin'));
  writeFileSync(join(dir, 'figma-plugin', 'manifest.json'), '{"v":1}');
  assert.equal(syncFigmaPlugin(root, dir), join(dir, 'figma-plugin', 'manifest.json'));
  assert.equal(readFileSync(join(dir, 'figma-plugin', 'manifest.json'), 'utf8'), '{"v":2}');
  assert.equal(syncFigmaPlugin(tmp(), dir), null);
});

test('a newer release is reported, and the answer is cached for 12 hours', async () => {
  const dir = tmp();
  let calls = 0;
  let clock = 1_000_000;
  const checker = createUpdateChecker({ dir, current: '0.1.0', repo: 'someone/tether', now: () => clock, fetchLatest: async () => { calls++; return '0.2.0'; } });
  assert.deepEqual(checker.status(), { current: '0.1.0', latest: null, available: false });
  await checker.check();
  assert.deepEqual(checker.status(), { current: '0.1.0', latest: '0.2.0', available: true });
  await checker.check();
  assert.equal(calls, 1);
  clock += 13 * 60 * 60_000;
  await checker.check();
  assert.equal(calls, 2);
  // A restarted bridge reads the cached answer without asking again.
  const again = createUpdateChecker({ dir, current: '0.1.0', repo: 'someone/tether', now: () => clock, fetchLatest: async () => { throw new Error('should not be called'); } });
  assert.equal(again.status().available, true);
});

test('writing off to update-check stops checks and hides the notice', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'update.json'), JSON.stringify({ checkedAt: 0, latest: '9.9.9' }));
  writeFileSync(join(dir, 'update-check'), 'off\n');
  let calls = 0;
  const checker = createUpdateChecker({ dir, current: '0.1.0', repo: 'someone/tether', fetchLatest: async () => { calls++; return '9.9.9'; } });
  await checker.check();
  assert.equal(calls, 0);
  assert.equal(checker.status().available, false);
});

test('a failed check keeps quiet and tries again later', async () => {
  const dir = tmp();
  const checker = createUpdateChecker({ dir, current: '0.1.0', repo: 'someone/tether', fetchLatest: async () => { throw new Error('offline'); } });
  await checker.check();
  assert.equal(checker.status().available, false);
  assert.equal(existsSync(join(dir, 'update.json')), false);
});

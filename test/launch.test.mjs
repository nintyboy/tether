// The mod starts the bridge as `node <mods folder>/tether/bridge/daemon.mjs`,
// where tether is a symlink. Launch it the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the daemon starts when run through a symlinked folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fc-'));
  symlinkSync(resolve('mod'), join(home, 'linked-mod'));
  const child = spawn(process.execPath, [join(home, 'linked-mod/bridge/daemon.mjs')], {
    env: { ...process.env, HOME: home, TETHER_PORT: '0' },
  });
  try {
    const line = await new Promise((ok, fail) => {
      let out = '';
      child.stdout.on('data', c => { out += c; if (out.includes('bridge up')) ok(out); });
      child.on('exit', code => fail(new Error(`daemon exited (${code}) before starting: ${out}`)));
      setTimeout(() => fail(new Error(`no "bridge up" within 3s: ${out}`)), 3000);
    });
    assert.match(line, /bridge up: http:\/\/localhost:\d+ \(write\), .*bridge\.sock \(read\)/);
  } finally {
    child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
});

// npm run release 0.2.0
// Bumps the version in the plugin manifest and package.json, runs the tests,
// commits, tags v0.2.0 and pushes. The tag starts .github/workflows/release.yml,
// which publishes the GitHub Release that running copies of Tether look for.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { isNewer, parseVersion } from '../mod/bridge/updates.mjs';

const MANIFEST = 'mod/.claude-plugin/plugin.json';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit' });
const fail = msg => { console.error(msg); process.exit(1); };

const next = (process.argv[2] ?? '').replace(/^v/, '');
if (!parseVersion(next)) fail('Usage: npm run release <major.minor.patch>');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (!isNewer(next, manifest.version)) fail(`${next} is not newer than the current ${manifest.version}.`);
if (run('git', ['status', '--porcelain'], { quiet: true }).trim()) fail('Commit or stash your changes first.');
if (run('git', ['branch', '--show-current'], { quiet: true }).trim() !== 'main') fail('Release from main.');

for (const file of [MANIFEST, 'package.json']) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = next;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

run('npm', ['test']);
run('git', ['commit', '-am', `Release v${next}`]);
run('git', ['tag', '-a', `v${next}`, '-m', `Tether ${next}`]);
run('git', ['push', '--follow-tags']);
console.log(`\nPushed v${next}. GitHub Actions will publish the release.`);

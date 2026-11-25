// Update awareness for the bridge: which version is running, whether GitHub
// has a newer release, and keeping the Figma plugin in a folder that does not
// move between versions.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHECK_EVERY_MS = 12 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 5000;

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// The mod folder: the bridge lives in <root>/bridge, the manifest in
// <root>/.claude-plugin/plugin.json.
export function readManifest(root) {
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const repo = /github\.com\/([^/]+\/[^/.]+)/.exec(manifest.repository ?? '')?.[1] ?? null;
  return { version: manifest.version ?? '0.0.0', repo };
}

// Installs put each version in its own folder, which is removed after an
// update. Figma remembers the manifest path, so serve it from one that stays.
export function syncFigmaPlugin(root, dir) {
  const from = join(root, 'figma-plugin');
  const to = join(dir, 'figma-plugin');
  if (!existsSync(from)) return null;
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
  return join(to, 'manifest.json');
}

async function latestFromGitHub(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tether-bridge' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const { tag_name: tag } = await res.json();
  return parseVersion(tag) ? tag.replace(/^v/, '') : null;
}

// Checks at most every 12 h, remembering the answer in <dir>/update.json so a
// restarted bridge does not ask again. Writing "off" to <dir>/update-check
// turns the check off.
export function createUpdateChecker({ dir, current, repo, now = () => Date.now(), fetchLatest = latestFromGitHub }) {
  const cacheFile = join(dir, 'update.json');
  const switchFile = join(dir, 'update-check');
  function readCache() {
    try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { return {}; }
  }
  let latest = readCache().latest ?? null;

  const isOff = () => existsSync(switchFile) && readFileSync(switchFile, 'utf8').trim() === 'off';

  async function check() {
    if (!repo || isOff()) return;
    const { checkedAt = -Infinity } = readCache();
    if (now() - checkedAt < CHECK_EVERY_MS) return;
    try {
      const found = await fetchLatest(repo);
      if (found) latest = found;
      writeFileSync(cacheFile, JSON.stringify({ checkedAt: now(), latest }));
    } catch {
      // Offline or rate-limited: try again at the next interval.
    }
  }

  function status() {
    const available = !isOff() && isNewer(latest, current);
    return { current, latest: available ? latest : null, available };
  }

  return { check, status, intervalMs: CHECK_EVERY_MS };
}

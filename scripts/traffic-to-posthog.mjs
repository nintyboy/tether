// Copies GitHub's repo traffic (which GitHub keeps for only 14 days) into
// PostHog, one event per finished day. Event ids are derived from the day and
// metric, so a re-run sends the same ids and PostHog folds them together.
//
// Env: GH_TOKEN (needs the repo's Administration: read), GITHUB_REPOSITORY
// (owner/repo), POSTHOG_KEY (the project's public phc_ key), POSTHOG_HOST.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function stableUuid(...parts) {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  // Shape it as a v4-style UUID; PostHog only needs a valid, repeatable id.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const day = iso => iso.slice(0, 10);

// Turns GitHub's responses into PostHog events. Today is skipped: its counts
// are still moving, and an event per finished day keeps re-runs identical.
export function toEvents({ repo, clones, views, referrers, info, today }) {
  const distinct_id = `repo:${repo}`;
  const base = { $process_person_profile: false, repo };
  const byDay = new Map();
  for (const c of clones.clones ?? []) {
    byDay.set(day(c.timestamp), { clones: c.count, unique_cloners: c.uniques });
  }
  for (const v of views.views ?? []) {
    const date = day(v.timestamp);
    byDay.set(date, { ...byDay.get(date), views: v.count, unique_visitors: v.uniques });
  }

  const events = [];
  for (const [date, counts] of [...byDay].sort()) {
    if (date >= today) continue;
    events.push({
      event: 'github_traffic_day', distinct_id, uuid: stableUuid(repo, 'traffic', date),
      timestamp: `${date}T12:00:00Z`,
      properties: { ...base, date, clones: 0, unique_cloners: 0, views: 0, unique_visitors: 0, ...counts },
    });
  }
  // Referrers and stars are snapshots, so they are stamped with the run's day.
  for (const r of referrers ?? []) {
    events.push({
      event: 'github_referrers_14d', distinct_id, uuid: stableUuid(repo, 'referrer', today, r.referrer),
      timestamp: `${today}T00:00:00Z`,
      properties: { ...base, date: today, referrer: r.referrer, views: r.count, unique_visitors: r.uniques },
    });
  }
  events.push({
    event: 'github_repo_stats', distinct_id, uuid: stableUuid(repo, 'stats', today),
    timestamp: `${today}T00:00:00Z`,
    properties: { ...base, date: today, stars: info.stargazers_count, forks: info.forks_count, watchers: info.subscribers_count },
  });
  return events;
}

async function gh(path, token) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY: repo, POSTHOG_KEY, POSTHOG_HOST = 'https://us.i.posthog.com' } = process.env;
  if (!GH_TOKEN || !repo || !POSTHOG_KEY) throw new Error('GH_TOKEN, GITHUB_REPOSITORY and POSTHOG_KEY are required');
  const [clones, views, referrers, info] = await Promise.all([
    gh(`repos/${repo}/traffic/clones?per=day`, GH_TOKEN),
    gh(`repos/${repo}/traffic/views?per=day`, GH_TOKEN),
    gh(`repos/${repo}/traffic/popular/referrers`, GH_TOKEN),
    gh(`repos/${repo}`, GH_TOKEN),
  ]);
  const events = toEvents({ repo, clones, views, referrers, info, today: new Date().toISOString().slice(0, 10) });
  const res = await fetch(`${POSTHOG_HOST}/batch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: POSTHOG_KEY, batch: events }),
  });
  if (!res.ok) throw new Error(`PostHog: ${res.status} ${await res.text()}`);
  console.log(`Sent ${events.length} events for ${repo}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}

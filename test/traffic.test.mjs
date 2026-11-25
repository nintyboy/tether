import test from 'node:test';
import assert from 'node:assert/strict';
import { stableUuid, toEvents } from '../scripts/traffic-to-posthog.mjs';

const input = {
  repo: 'someone/tether',
  today: '2026-11-25',
  clones: { clones: [
    { timestamp: '2026-11-23T00:00:00Z', count: 5, uniques: 3 },
    { timestamp: '2026-11-25T00:00:00Z', count: 9, uniques: 9 },
  ] },
  views: { views: [
    { timestamp: '2026-11-23T00:00:00Z', count: 40, uniques: 12 },
    { timestamp: '2026-11-24T00:00:00Z', count: 7, uniques: 4 },
  ] },
  referrers: [{ referrer: 'github.com', count: 30, uniques: 10 }],
  info: { stargazers_count: 2, forks_count: 1, subscribers_count: 1 },
};

test('one event per finished day, merging clones and views, skipping today', () => {
  const days = toEvents(input).filter(e => e.event === 'github_traffic_day');
  assert.deepEqual(days.map(e => e.properties.date), ['2026-11-23', '2026-11-24']);
  assert.deepEqual(
    (({ clones, unique_cloners, views, unique_visitors }) => ({ clones, unique_cloners, views, unique_visitors }))(days[0].properties),
    { clones: 5, unique_cloners: 3, views: 40, unique_visitors: 12 },
  );
  // A day with views but no clones reports zero clones, not a missing field.
  assert.equal(days[1].properties.clones, 0);
});

test('re-running the same day produces the same ids', () => {
  const a = toEvents(input).map(e => e.uuid);
  const b = toEvents(input).map(e => e.uuid);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  assert.match(stableUuid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('snapshots carry referrers and stars, and no person profiles', () => {
  const events = toEvents(input);
  const ref = events.find(e => e.event === 'github_referrers_14d');
  assert.equal(ref.properties.referrer, 'github.com');
  const stats = events.find(e => e.event === 'github_repo_stats');
  assert.equal(stats.properties.stars, 2);
  assert.ok(events.every(e => e.properties.$process_person_profile === false));
});

test('empty traffic still sends the stats snapshot', () => {
  const events = toEvents({ ...input, clones: {}, views: {}, referrers: [] });
  assert.deepEqual(events.map(e => e.event), ['github_repo_stats']);
});

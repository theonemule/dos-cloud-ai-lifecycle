const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectorURL } = require('../scripts/build-faro.cjs');

test('Faro uses only scoped HTTPS collector URL', () => {
  assert.match(collectorURL(), /^https:\/\/telemetry\.blaize\.net\/faro\/paladin-chronicles\/[A-Za-z0-9_-]{16,128}$/);
  for (const url of [
    'http://telemetry.blaize.net/faro/doscloud/testpublishableidentifierabc',
    'https://evil.example/faro/doscloud/testpublishableidentifierabc',
    'https://telemetry.blaize.net/faro/doscloud/not-long',
    'https://telemetry.blaize.net/faro/doscloud/testpublishableidentifierabc?secret=x',
  ]) assert.throws(() => collectorURL(url));
});

test('session-linked Google/Quora journey omits search queries and outgoing URL tokens', async () => {
  const { entryAttribution, installJourneyTracking } = await import('../public/journey.mjs');
  const g = entryAttribution('https://doscloud.net/catalog?private=secret', 'https://www.google.com/search?q=private+phrase');
  assert.equal(g.source_type, 'organic_search');
  assert.equal(g.referrer_domain, 'google.com');
  assert.equal(g.landing_path, '/catalog');
  assert.ok(!JSON.stringify(g).includes('private+phrase'));

  const map = new Map();
  const storage = { getItem: (k) => map.get(k) || null, setItem: (k, v) => map.set(k, v) };
  const events = [];
  const api = { pushEvent: (name, attrs) => events.push({ name, attrs }) };
  const rng = { randomUUID: () => '11111111-2222-4333-8444-555555555555' };
  const doc = { referrer: 'https://www.quora.com/Some-Topic?private=x', addEventListener() {}, removeEventListener() {} };
  const first = installJourneyTracking({ api }, { location: { href: 'https://doscloud.net/catalog?token=secret' }, sessionStorage: storage, crypto: rng }, doc, () => 1000000);
  installJourneyTracking({ api }, { location: { href: 'https://doscloud.net/about' }, sessionStorage: storage, crypto: rng }, { ...doc, referrer: 'https://doscloud.net/catalog?token=secret' }, () => 1001000);
  assert.equal(first.visit.source, 'quora.com');
  assert.equal(events[0].attrs.visit_id, events[1].attrs.visit_id);
  assert.equal(events[1].attrs.previous_path, '/catalog');
  assert.equal(events[1].attrs.page_number, '2');
  assert.ok(!JSON.stringify(events).includes('token=secret'));
});
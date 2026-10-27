import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDiscovercarsLocations } from '../server/location-search.mjs';

const point = (patch = {}) => ({ placeID: 6144, place: 'Rzeszow Airport (RZE)', city: 'Rzeszow', countryID: 75,
  country: 'Poland', location: 'airport', ...patch });
const response = result => new Response(JSON.stringify({ success: true, result }));

test('search returns exact Polish points, not all-locations or highlighted HTML', async () => {
  let endpoint;
  const found = await searchDiscovercarsLocations('Rzeszow', async (url, options) => {
    endpoint = new URL(url);
    assert.equal(options.redirect, 'error');
    return response([point(), point({ placeID: 392, place: 'Rzeszow (all locations)', location: 'downtown' }),
      point({ placeID: 355145, place: 'Rzeszow Train Station', location: 'railway', placeHlt: '<script>bad</script>' }),
      point({ placeID: 9, countryID: 10, country: 'Other' })]);
  });
  assert.ok(endpoint);
  assert.equal(endpoint.origin, 'https://www.discovercars.com');
  assert.equal(endpoint.pathname, '/api/v2/autocomplete');
  assert.equal(endpoint.searchParams.get('location'), 'Rzeszow');
  assert.deepEqual(found, [
    { placeId: 6144, label: 'Rzeszow Airport (RZE)', city: 'Rzeszow', kind: 'airport' },
    { placeId: 355145, label: 'Rzeszow Train Station', city: 'Rzeszow', kind: 'city' },
  ]);
});

test('invalid queries do not issue a network request', async () => {
  for (const query of ['', 'x', 'x'.repeat(101), 42, 'bad\nquery']) {
    await assert.rejects(searchDiscovercarsLocations(query, () => { throw new Error('Network was called'); }),
      error => error.status === 422);
  }
});

test('failed, oversized and ambiguous search responses cannot verify a point', async () => {
  for (const fetcher of [
    async () => new Response('blocked', { status: 403 }),
    async () => new Response('x'.repeat(512 * 1024 + 1)),
    async () => new Response('not json'),
    async () => response([point(), point({ place: 'Different Airport' })]),
    async () => new Response(JSON.stringify({ success: false, result: [point()] })),
  ]) await assert.rejects(searchDiscovercarsLocations('Rzeszow', fetcher), error => error.status === 502);
});

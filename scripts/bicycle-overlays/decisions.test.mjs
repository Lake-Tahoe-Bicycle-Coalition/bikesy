import assert from 'node:assert/strict';
import test from 'node:test';
import { googleMapsUrl, isRecurring, josmUrl, parseTags } from './decisions.mjs';

test('only an exclude from an earlier run recurs', () => {
  assert.equal(isRecurring({ decision: 'exclude', run: '/old' }, '/new'), true);
  assert.equal(isRecurring({ decision: 'exclude', run: '/new' }, '/new'), false);
  assert.equal(isRecurring({ decision: 'exclude' }, '/new'), false); // saved before `run`
  assert.equal(isRecurring({ decision: 'include', run: '/old' }, '/new'), false);
  assert.equal(isRecurring(undefined, '/new'), false);
});

test('tags are set or removed, separated by spaces, commas or semicolons', () => {
  assert.deepEqual(parseTags('cycleway:both=lane;-cycleway surface=dirt, -foo').tags, [
    ['cycleway:both', 'lane'],
    ['cycleway', null],
    ['surface', 'dirt'],
    ['foo', null],
  ]);
  assert.deepEqual(parseTags('').tags, []);
  for (const bad of ['surface', 'a=', '=b', '-', 'a=1 a=2', '--a'])
    assert.ok(parseTags(bad).error, bad);
});

test('JOSM link selects the ways and encodes the tags; removal is an empty value', () => {
  const url = new URL(josmUrl({ tags: 'surface=dirt;-cycleway', ways: [1, 2] }));
  assert.equal(url.origin, 'http://127.0.0.1:8111');
  assert.equal(url.pathname, '/load_object');
  assert.equal(url.searchParams.get('objects'), 'w1,w2');
  assert.equal(url.searchParams.get('new_layer'), 'false');
  assert.equal(url.searchParams.get('addtags'), 'surface=dirt|cycleway=');
  assert.equal(josmUrl({ tags: 'bad', ways: [1] }), null);
  assert.equal(josmUrl({ tags: 'a=b', ways: [] }), null);
  assert.equal(josmUrl({ tags: '', ways: [1] }), null);
});

test('Google Maps link centres on the bounding box and zooms to fit within 13-19', () => {
  const at = (coords) => new URL(googleMapsUrl(coords)).searchParams;
  const small = at([
    [-120.0, 39.0],
    [-120.004, 39.003],
  ]);
  assert.equal(small.get('center'), '39.001500,-120.002000');
  assert.equal(small.get('basemap'), 'satellite');
  assert.equal(small.get('zoom'), '17');
  assert.equal(at([[-120, 39]]).get('zoom'), '19');
  assert.equal(
    at([
      [-120.4, 38.8],
      [-119.9, 39.4],
    ]).get('zoom'),
    '13',
  );
});

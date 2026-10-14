import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLayers, summarize } from './diff.mjs';

// East-west lines about 500 m long near Lake Tahoe; 0.0005° of latitude is about 55 m.
const line = (lat, props = {}) => ({
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [-120.0, lat],
      [-119.994, lat],
    ],
  },
  properties: props,
});
const fc = (...features) => ({ type: 'FeatureCollection', features });

test('reports added, removed and changed stretches, once each', () => {
  const before = {
    I: fc(line(39.0, { name: 'Kept path' }), line(39.001, { name: 'Gone path' })),
    II: fc(line(39.002, { name: 'Lane to route' })),
  };
  const after = {
    I: fc(
      line(39.0, { osm_way_id: 1, name: 'Kept path' }),
      line(39.003, { osm_way_id: 2, name: 'New path' }),
    ),
    III: fc(line(39.002, { osm_way_id: 3, name: 'Lane to route' })),
  };
  const changes = diffLayers(before, after);
  assert.deepEqual(changes.map((c) => [c.type, c.before, c.after, c.name]).sort(), [
    ['added', null, 'I', 'New path'],
    ['changed', 'II', 'III', 'Lane to route'],
    ['removed', 'I', null, 'Gone path'],
  ]);
  const added = changes.find((c) => c.type === 'added');
  assert.deepEqual(added.ways, [{ id: 2, name: 'New path', highway: null }]);
  assert.ok(added.metres > 450 && added.metres < 550);
  const summary = summarize(changes);
  assert.deepEqual(Object.keys(summary).sort(), ['added', 'changed', 'removed']);
  assert.equal(summary.changed.III.count, 1);
  assert.ok(summary.changed.III.km > 0.45 && summary.changed.III.km < 0.55);
});

test('a new facility beside one that still exists is added, not changed', () => {
  // Path stays; a bike lane appears on the road 10 m away.
  const before = { I: fc(line(39.0, { name: 'Path' })) };
  const after = {
    I: fc(line(39.0, { osm_way_id: 1, name: 'Path' })),
    II: fc(line(39.00009, { osm_way_id: 2, name: 'Road' })),
  };
  const changes = diffLayers(before, after);
  assert.deepEqual(
    changes.map((c) => [c.type, c.after]),
    [['added', 'II']],
  );
});

test('identical layers and short differences produce no changes', () => {
  const layers = { I: fc(line(39.0, { name: 'Path' })) };
  assert.deepEqual(diffLayers(layers, layers), []);
  const short = {
    I: fc({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-120.0, 39.01],
          [-119.9997, 39.01],
        ],
      },
      properties: {},
    }),
  };
  assert.deepEqual(diffLayers({}, short, { minLength: 50 }), []);
});

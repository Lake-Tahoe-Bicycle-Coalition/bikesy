import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChanges, tally } from './apply.mjs';
import { diffLayers } from './diff.mjs';

const line = (lat, props = {}, [west, east] = [-120.0, -119.994]) => ({
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [west, lat],
      [east, lat],
    ],
  },
  properties: props,
});
const fc = (...features) => ({ type: 'FeatureCollection', features });
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
const decide = (type, decision = 'include') =>
  Object.fromEntries(
    changes.filter((c) => c.type === type).map((c) => [c.id, { decision }]),
  );
const names = (layer) => (layer?.features ?? []).map((f) => f.properties.name).sort();

test('without included changes the before layers are kept as they were', () => {
  for (const decisions of [
    {},
    { ...decide('added', 'exclude'), ...decide('removed', 'exclude') },
  ]) {
    const { layers, included } = applyChanges(before, after, changes, decisions);
    assert.equal(included.length, 0);
    assert.deepEqual(names(layers.I), ['Gone path', 'Kept path']);
    assert.deepEqual(names(layers.II), ['Lane to route']);
    assert.deepEqual(layers.I.features[0].geometry, before.I.features[0].geometry);
    assert.equal(layers.III, undefined);
  }
});

test('included additions, removals and class changes are applied', () => {
  const { layers } = applyChanges(before, after, changes, {
    ...decide('added'),
    ...decide('removed'),
    ...decide('changed'),
  });
  assert.deepEqual(names(layers.I), ['Kept path', 'New path']);
  assert.deepEqual(names(layers.II), []);
  assert.deepEqual(names(layers.III), ['Lane to route']);
  const added = layers.I.features.find((f) => f.properties.name === 'New path');
  assert.equal(added.properties.osm_way_id, 2);
  assert.equal(added.properties.overlay_source, 'after');
  // The added stretch follows the original line exactly.
  assert.deepEqual(added.geometry.coordinates, after.I.features[1].geometry.coordinates);
});

test('removing the middle of a longer line keeps both ends', () => {
  const long = { I: fc(line(39.01, { name: 'Long path' }, [-120.0, -119.988])) }; // about 1 km
  const ends = {
    I: fc(
      line(39.01, { osm_way_id: 5, name: 'Long path' }, [-120.0, -119.9965]),
      line(39.01, { osm_way_id: 6, name: 'Long path' }, [-119.9915, -119.988]),
    ),
  };
  const diff = diffLayers(long, ends);
  assert.deepEqual(
    diff.map((c) => c.type),
    ['removed'],
  );
  const { layers } = applyChanges(long, ends, diff, {
    [diff[0].id]: { decision: 'include' },
  });
  const [kept] = layers.I.features;
  assert.equal(kept.geometry.type, 'MultiLineString');
  assert.equal(kept.geometry.coordinates.length, 2);
  assert.deepEqual(kept.geometry.coordinates[0][0], [-120.0, 39.01]);
  assert.deepEqual(kept.geometry.coordinates[1].at(-1), [-119.988, 39.01]);
});

test('an exclude from an earlier run counts as undecided and is reported separately', () => {
  const [a, b, c] = changes;
  const decisions = {
    [a.id]: { decision: 'exclude', run: '/old' },
    [b.id]: { decision: 'exclude', run: '/new' },
    [c.id]: { decision: 'exclude' }, // saved before `run` existed: this run
  };
  const t = tally(changes, decisions, '/new');
  assert.equal(t.recurring_excluded, 1);
  assert.equal(t.excluded, 2);
  assert.equal(t.undecided, changes.length - 2);
  const { included } = applyChanges(before, after, changes, {
    ...decisions,
    [a.id]: { decision: 'include', run: '/old' }, // includes carry over
  });
  assert.deepEqual(
    included.map((x) => x.id),
    [a.id],
  );
});

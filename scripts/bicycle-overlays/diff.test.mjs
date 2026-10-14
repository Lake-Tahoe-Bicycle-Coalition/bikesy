import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffLayers, STEP, summarize } from './diff.mjs';

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
  assert.equal(summary.changed['II>III'].count, 1);
  assert.ok(summary.changed['II>III'].km > 0.45 && summary.changed['II>III'].km < 0.55);
  assert.equal(summary.added.I.count, 1);
  assert.equal(summary.removed.I.count, 1);
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

test('ways_near.py keeps ways along the stretch and ranks them by coverage', async (t) => {
  const python = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '.venv/bin/python',
  );
  if (!existsSync(python)) return t.skip('no tool venv');
  const dir = await mkdtemp(path.join(tmpdir(), 'ways-near-'));
  try {
    const kx = 111320 * Math.cos((39 * Math.PI) / 180);
    const lng = (m) => (-120 + m / kx).toFixed(7);
    const node = (id, m, lat) => `<node id="${id}" lat="${lat}" lon="${lng(m)}"/>`;
    const way = (id, refs, name) =>
      `<way id="${id}">${refs.map((r) => `<nd ref="${r}"/>`).join('')}<tag k="highway" v="residential"/><tag k="name" v="${name}"/></way>`;
    const xml = `<?xml version="1.0"?><osm version="0.6">
${node(1, 0, 39)}${node(2, 400, 39)}${node(3, 800, 39)}${node(4, 600, 39)}${node(5, 600, 39.0005)}${node(6, 100, 39)}${node(7, 100, 39.0005)}${node(8, 405, 39)}${node(9, 470, 39)}
${way(10, [1, 2], 'Long A')}${way(11, [2, 3], 'Long B')}${way(12, [4, 5], 'Cross')}${way(13, [6, 7], 'Other cross')}
${way(14, [8, 9], 'Short A')}
</osm>`;
    const coords = Array.from({ length: 81 }, (_, i) => [-120 + (i * STEP) / kx, 39]);
    await writeFile(path.join(dir, 'x.osm'), xml);
    await writeFile(path.join(dir, 'in.json'), JSON.stringify({ s: coords }));
    const run = spawnSync(
      python,
      [
        '-I',
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'ways_near.py'),
        path.join(dir, 'x.osm'),
        path.join(dir, 'in.json'),
        path.join(dir, 'out.json'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const ways = JSON.parse(await readFile(path.join(dir, 'out.json'), 'utf8')).s;
    assert.deepEqual(
      ways.map((w) => w.id),
      [10, 11, 14],
    );
    assert.ok(ways[0].metres >= 380 && ways[0].metres <= 460);
    assert.ok(ways[1].metres >= 380 && ways[1].metres <= 460);
    assert.equal(ways[0].name, 'Long A');
    assert.ok(ways[2].metres >= 60 && ways[2].metres <= 130);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

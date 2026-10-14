import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const layer = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-120, 39],
          [-119.99, 39],
        ],
      },
      properties: { osm_way_id: 1 },
    },
  ],
};
const change = {
  id: 'c1',
  type: 'added',
  before: null,
  after: 'I',
  source: { side: 'after', layer: 'I', index: 0 },
  name: 'Trail',
  metres: 800,
  mid: [-119.995, 39],
  coords: layer.features[0].geometry.coordinates,
  ways: [{ id: 1 }, { id: 2 }],
};

async function server(initial = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-test-'));
  for (const side of ['before', 'after']) {
    await mkdir(path.join(dir, side));
    await writeFile(path.join(dir, side, 'class-I.geojson'), JSON.stringify(layer));
  }
  const changes = path.join(dir, 'changes.json');
  const file = path.join(dir, 'decisions.json');
  await writeFile(
    changes,
    JSON.stringify({
      before: path.join(dir, 'before'),
      after: path.join(dir, 'after'),
      changes: [change],
    }),
  );
  await writeFile(file, JSON.stringify({ decisions: initial }));
  const child = spawn(
    process.execPath,
    [
      path.join(HERE, 'review.mjs'),
      '--changes',
      changes,
      '--decisions',
      file,
      '--port',
      '0',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const base = await new Promise((resolve) =>
    child.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) resolve(m[0]);
    }),
  );
  const put = async (body) => {
    const res = await fetch(`${base}/decisions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', ...body }),
    });
    return { status: res.status, body: await res.json() };
  };
  const saved = async () => JSON.parse(await readFile(file, 'utf8')).decisions.c1;
  return { put, saved, after: path.join(dir, 'after'), stop: () => child.kill() };
}

test('decisions record their run; notes and fixes merge without losing it', async () => {
  const s = await server();
  try {
    let r = await s.put({ decision: 'exclude', note: 'wrong surface' });
    assert.equal(r.body.run, s.after);
    r = await s.put({
      decision: 'exclude',
      osm_fix: { tags: 'surface=dirt', ways: [1], status: 'todo' },
    });
    assert.equal(r.body.note, 'wrong surface');
    r = await s.put({ decision: 'exclude', osm_fix: { status: 'uploaded' } });
    assert.deepEqual((await s.saved()).osm_fix, {
      tags: 'surface=dirt',
      ways: [1],
      status: 'uploaded',
    });
    assert.equal((await s.put({ osm_fix: { ways: [99] } })).status, 400);
    assert.equal(
      (await s.put({ decision: 'exclude', osm_fix: { status: 'done' } })).status,
      400,
    );
    r = await s.put({ decision: 'exclude', osm_fix: null });
    assert.equal(r.body.osm_fix, undefined);
    assert.equal(r.body.note, 'wrong surface');
    // Without a decision it is cleared, as before, but the note and fix remain.
    r = await s.put({ note: 'x' });
    assert.equal(r.body.decision, undefined);
    assert.equal(r.body.run, undefined);
  } finally {
    s.stop();
  }
});

test('a recurring exclude keeps its old run until it is decided again', async () => {
  const s = await server({ c1: { decision: 'exclude', run: '/old', note: 'old note' } });
  try {
    let r = await s.put({ decision: 'exclude', note: 'old note + more' });
    assert.equal(r.body.run, '/old'); // a note edit is not a new decision
    r = await s.put({ decision: 'exclude', confirm: true });
    assert.equal(r.body.run, s.after);
    assert.equal(r.body.note, 'old note + more');
  } finally {
    s.stop();
  }
  const t = await server({ c1: { decision: 'exclude' } }); // no run: current
  try {
    assert.equal((await t.put({ decision: 'exclude', note: 'n' })).body.run, undefined);
  } finally {
    t.stop();
  }
});

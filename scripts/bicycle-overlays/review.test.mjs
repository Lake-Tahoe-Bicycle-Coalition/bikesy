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
const change2 = { ...change, id: 'c2', ways: [{ id: 2 }, { id: 3 }] };

async function server(initial = {}, legacy = false) {
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
      changes: [change, change2],
    }),
  );
  await writeFile(
    file,
    JSON.stringify(legacy ? { decisions: initial } : { version: 2, decisions: initial }),
  );
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
  const send = async (body) => {
    const res = await fetch(`${base}/decisions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const put = async (body) => {
    const r = await send({ id: 'c1', ...body });
    return r.status === 200 ? { status: 200, body: r.body.c1 } : r;
  };
  const file_ = async () => JSON.parse(await readFile(file, 'utf8'));
  const saved = async () => (await file_()).decisions.c1;
  return {
    put,
    send,
    saved,
    file: file_,
    get: async () => (await fetch(`${base}/decisions`)).json(),
    after: path.join(dir, 'after'),
    stop: () => child.kill(),
  };
}

test('decisions record their run; notes and fixes merge without losing it', async () => {
  const s = await server();
  try {
    assert.equal((await s.put({ decision: 'reject' })).status, 400); // needs a reason
    assert.equal((await s.put({ decision: 'reject', reason: 'x' })).status, 400);
    assert.equal((await s.put({ decision: 'ignore' })).status, 400);
    let r = await s.put({ decision: 'reject', reason: 'osm', note: 'wrong surface' });
    assert.equal(r.body.run, s.after);
    assert.equal((await s.file()).version, 2);
    r = await s.put({ osm_fix: { tags: 'surface=dirt', ways: [1], status: 'todo' } });
    assert.equal(r.body.note, 'wrong surface');
    assert.equal(r.body.decision, 'reject'); // absent decision = unchanged
    r = await s.put({ osm_fix: { status: 'uploaded' } });
    assert.deepEqual((await s.saved()).osm_fix, {
      tags: 'surface=dirt',
      ways: [1],
      status: 'uploaded',
    });
    assert.equal((await s.put({ osm_fix: { ways: [99] } })).status, 400);
    assert.equal((await s.put({ osm_fix: { status: 'done' } })).status, 400);
    r = await s.put({ osm_fix: null });
    assert.equal(r.body.osm_fix, undefined);
    assert.equal(r.body.note, 'wrong surface');
    // A null decision clears it, with its reason and run; the note remains.
    r = await s.put({ decision: null });
    assert.deepEqual(
      [r.body.decision, r.body.reason, r.body.run],
      [undefined, undefined, undefined],
    );
    assert.equal(r.body.note, 'wrong surface');
    // Accept drops the reason.
    r = await s.put({ decision: 'accept', reason: 'osm' });
    assert.equal(r.body.reason, undefined);
  } finally {
    s.stop();
  }
});

test('a recurring reject keeps its old run until it is decided again', async () => {
  const old = { decision: 'reject', reason: 'generator', run: '/old', note: 'old note' };
  const s = await server({ c1: old });
  try {
    let r = await s.put({ note: 'old note + more' });
    assert.equal(r.body.run, '/old'); // a note edit is not a new decision
    r = await s.put({ decision: 'reject', reason: 'generator' });
    assert.equal(r.body.run, '/old'); // nor is repeating it without confirming
    r = await s.put({ decision: 'reject', reason: 'generator', confirm: true });
    assert.equal(r.body.run, s.after);
    assert.equal(r.body.note, 'old note + more');
    await s.put({ decision: 'reject', reason: 'generator', run: '/old' });
    assert.equal((await s.put({ decision: 'reject', reason: 'osm' })).body.run, s.after);
  } finally {
    s.stop();
  }
  const t = await server({ c1: { decision: 'reject', reason: 'osm' } }, true); // no run: current
  try {
    assert.equal(
      (await t.put({ decision: 'reject', reason: 'osm', note: 'n' })).body.run,
      undefined,
    );
  } finally {
    t.stop();
  }
});

test('a version 1 file is converted on load and written as version 2 on save', async () => {
  const fix = { tags: 'a=b', ways: [1], status: 'todo' };
  const s = await server(
    {
      c1: { decision: 'exclude', run: '/old', note: 'keep', osm_fix: fix, at: 't' },
      c2: { decision: 'include', run: '/old' },
    },
    true,
  );
  try {
    const loaded = await s.get();
    assert.deepEqual(loaded.c1, {
      decision: 'reject',
      reason: 'osm',
      run: '/old',
      note: 'keep',
      osm_fix: fix,
      at: 't',
    });
    assert.equal(loaded.c2.decision, 'accept');
    await s.put({ note: 'keep more' });
    const file = await s.file();
    assert.equal(file.version, 2);
    assert.equal(file.decisions.c1.reason, 'osm');
    assert.deepEqual(file.decisions.c1.osm_fix, fix);
    assert.deepEqual(file.decisions.c2, { decision: 'accept', run: '/old' });
  } finally {
    s.stop();
  }
});

test('a batch decides, notes and fixes every member in one request', async () => {
  const s = await server({ c2: { decision: 'accept', run: '/old' } });
  try {
    let r = await s.send({
      ids: ['c1', 'c2'],
      decision: 'reject',
      reason: 'osm',
      note: 'group note',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ['c1', 'c2']);
    const file = (await s.file()).decisions;
    for (const id of ['c1', 'c2']) {
      assert.deepEqual(
        [file[id].decision, file[id].reason, file[id].note, file[id].run],
        ['reject', 'osm', 'group note', s.after],
      );
    }
    // Ways from the union of members; each member keeps its own.
    r = await s.send({
      ids: ['c1', 'c2'],
      osm_fix: { tags: 'surface=dirt', ways: [1, 2, 3], status: 'todo' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.c1.osm_fix.ways, [1, 2]);
    assert.deepEqual(r.body.c2.osm_fix.ways, [2, 3]);
    assert.equal(r.body.c2.osm_fix.tags, 'surface=dirt');
    // One bad member rejects the whole batch and changes nothing.
    const before = await s.file();
    for (const bad of [
      { ids: ['c1', 'nope'], decision: 'accept' },
      { ids: ['c1', 'c2'], decision: 'reject' },
      { ids: ['c1', 'c2'], osm_fix: { ways: [1, 4] } },
    ])
      assert.ok((await s.send(bad)).status >= 400);
    assert.deepEqual((await s.file()).decisions, before.decisions);
    // Clearing the group removes the decision but keeps notes.
    r = await s.send({ ids: ['c1', 'c2'], decision: null, osm_fix: null });
    assert.deepEqual(
      [r.body.c1.decision, r.body.c1.osm_fix, r.body.c1.note],
      [undefined, undefined, 'group note'],
    );
  } finally {
    s.stop();
  }
});

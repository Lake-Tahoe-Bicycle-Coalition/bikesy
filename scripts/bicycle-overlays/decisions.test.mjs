import assert from 'node:assert/strict';
import test from 'node:test';
import {
  googleMapsUrl,
  groupChanges,
  isRecurring,
  josmUrl,
  parseTags,
  readDecisions,
  unionWays,
} from './decisions.mjs';

test('only a reject from an earlier run recurs', () => {
  const reject = { decision: 'reject', reason: 'generator' };
  assert.equal(isRecurring({ ...reject, run: '/old' }, '/new'), true);
  assert.equal(isRecurring({ ...reject, run: '/new' }, '/new'), false);
  assert.equal(isRecurring(reject, '/new'), false); // saved before `run`
  assert.equal(isRecurring({ decision: 'accept', run: '/old' }, '/new'), false);
  assert.equal(isRecurring(undefined, '/new'), false);
});

test('version 1 decisions convert in memory and keep every field', () => {
  const v1 = {
    decisions: {
      a: { decision: 'include', note: 'n', run: '/r', at: 't' },
      b: {
        decision: 'exclude',
        note: 'm',
        osm_fix: { tags: 'x=y', ways: [1], status: 'uploaded' },
        run: '/r',
        at: 't',
      },
      c: { note: 'only a note', at: 't' },
    },
  };
  const copy = structuredClone(v1);
  const out = readDecisions(v1);
  assert.deepEqual(v1, copy);
  assert.deepEqual(out.a, { decision: 'accept', note: 'n', run: '/r', at: 't' });
  assert.deepEqual(out.b, { ...copy.decisions.b, decision: 'reject', reason: 'osm' });
  assert.deepEqual(out.c, copy.decisions.c);
  // Version 2 passes through unchanged, as does an empty or missing file.
  const v2 = { version: 2, decisions: out };
  assert.deepEqual(readDecisions(v2), out);
  assert.deepEqual(readDecisions({ version: 2, decisions: {} }), {});
  assert.deepEqual(readDecisions({}), {});
  assert.throws(() => readDecisions({ version: 3, decisions: {} }));
});

const metresLng = 1 / (111320 * Math.cos((39 * Math.PI) / 180));
const piece = (id, name, [x0, y0], [x1, y1], extra = {}) => ({
  id,
  name,
  type: 'removed',
  metres: 100,
  coords: [
    [-120 + x0 * metresLng, 39 + y0 / 111320],
    [-120 + x1 * metresLng, 39 + y1 / 111320],
  ],
  ways: [],
  ...extra,
});
const ids = (groups) => groups.map((g) => g.members.map((c) => c.id));

test('changes whose endpoints meet group transitively, even across types', () => {
  const chain = [
    piece('a', 'Pioneer Trail', [0, 0], [100, 0]),
    piece('b', 'Pioneer Trail', [110, 0], [300, 0], { type: 'changed' }),
    piece('c', 'Pioneer Trail', [315, 0], [500, 0]),
    piece('far', 'Pioneer Trail', [1200, 0], [1300, 0]), // 700 m past the chain
  ];
  const groups = groupChanges(chain);
  assert.deepEqual(ids(groups), [['a', 'b', 'c'], ['far']]);
  assert.equal(groups[0].metres, 300);
  assert.equal(groups[0].name, 'Pioneer Trail');
  assert.deepEqual(
    groups[0].bbox.map((x) => Number(x.toFixed(4))),
    [-120, 39, -120 + 500 * metresLng, 39].map((x) => Number(x.toFixed(4))),
  );
  assert.deepEqual(ids(groupChanges(chain, 20, 5)), [['a'], ['b'], ['c'], ['far']]);
});

test('same-named changes join across a gap up to the group gap, case-insensitively', () => {
  const pieces = [
    piece('a', 'Pioneer Trail', [0, 0], [100, 0]),
    piece('b', 'pioneer trail', [450, 0], [600, 0]), // 350 m gap
    piece('c', 'Pioneer Trail', [1300, 0], [1400, 0]), // 700 m gap
    piece('d', 'Other Road', [100, 5], [300, 5]), // near a, different name
  ];
  assert.deepEqual(ids(groupChanges(pieces)), [['a', 'b'], ['c'], ['d']]);
  assert.deepEqual(ids(groupChanges(pieces, 20, 1000)), [['a', 'b', 'c'], ['d']]);
  // Unnamed changes only get the tolerance, never the gap.
  const lone = [piece('a', 'X', [0, 0], [100, 0]), piece('u', null, [450, 0], [600, 0])];
  assert.deepEqual(ids(groupChanges(lone)), [['a'], ['u']]);
});

test('null names join one named group; different names and mid-line crossings do not', () => {
  const groups = groupChanges([
    piece('a', 'Pioneer Trail', [0, 0], [100, 0]),
    piece('n', null, [105, 0], [200, 0]),
    piece('b', 'Pioneer Trail', [205, 0], [300, 0]),
    piece('other', 'Elm Street', [0, 5], [0, 100]),
    piece('x', 'Cross Street', [50, -80], [50, 80]),
  ]);
  assert.deepEqual(ids(groups), [['a', 'n', 'b'], ['other'], ['x']]);
  // An unnamed change between two names joins neither, but can group with other unnamed ones.
  const bridge = groupChanges([
    piece('p', 'Alpha', [0, 0], [100, 0]),
    piece('u', null, [105, 0], [200, 0]),
    piece('q', 'Beta', [205, 0], [300, 0]),
    piece('v', null, [105, 5], [200, 5]),
  ]);
  assert.deepEqual(ids(bridge).sort(), [['p'], ['q'], ['u', 'v']]);
  assert.deepEqual(
    ids(
      groupChanges([
        piece('u', null, [0, 0], [10, 0]),
        piece('v', null, [12, 0], [90, 0]),
      ]),
    ),
    [['u', 'v']],
  );
});

test('grouping does not depend on the order of the changes', () => {
  const input = [
    piece('p', 'Alpha', [0, 0], [100, 0]),
    piece('u', null, [105, 0], [200, 0]),
    piece('q', 'Beta', [205, 0], [300, 0]),
    piece('v', null, [105, 5], [200, 5]),
    piece('a2', 'alpha', [600, 0], [700, 0]),
    piece('w', null, [705, 0], [800, 0]),
    piece('z', null, [3000, 0], [3100, 0]),
  ];
  const canon = (cs) =>
    groupChanges(cs)
      .map((g) => `${g.id}|${g.name}|${g.members.map((c) => c.id).sort()}`)
      .sort();
  const expected = canon(input);
  assert.equal(expected.length, 4);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < 50; n++) {
    const shuffled = [...input].sort(() => rand() - 0.5);
    assert.deepEqual(canon(shuffled), expected);
  }
});

test('union of member ways is deduplicated and ranked by total metres', () => {
  const ways = unionWays([
    {
      ways: [
        { id: 1, metres: 50 },
        { id: 2, metres: 120 },
      ],
    },
    { ways: [{ id: 1, metres: 90 }, { id: 3 }] },
  ]);
  assert.deepEqual(
    ways.map((w) => [w.id, w.metres]),
    [
      [1, 140],
      [2, 120],
      [3, 0],
    ],
  );
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

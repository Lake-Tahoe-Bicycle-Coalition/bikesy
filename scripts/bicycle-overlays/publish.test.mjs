import assert from 'node:assert/strict';
import test from 'node:test';
import { featureKey, newId, planChanges } from './publish.mjs';

const line = (name, x, extra = {}) => ({
  type: 'Feature',
  properties: { name, ...extra },
  geometry: { type: 'LineString', coordinates: [[x, 39.1], [x + 0.001, 39.2]] },
});

test('featureKey ignores property order and sub-micro-degree coordinate noise', () => {
  const a = line('A', -120.1, { b: 1 });
  const b = { ...line('A', -120.1000000004), properties: { b: 1, name: 'A' } };
  assert.equal(featureKey(a), featureKey(b));
  assert.notEqual(featureKey(a), featureKey(line('B', -120.1)));
});

test('planChanges keeps matches, adds new, removes old and duplicates', () => {
  const existing = [
    { ...line('same', -120.1), id: '1' },
    { ...line('same', -120.1), id: '2' }, // duplicate import
    { ...line('old', -120.2), id: '3' },
  ];
  const incoming = [line('same', -120.1), line('new', -120.3)];
  const plan = planChanges(existing, incoming);
  assert.equal(plan.keep, 1);
  assert.deepEqual(plan.remove.sort(), ['2', '3']);
  assert.equal(plan.add.length, 1);
  assert.equal(plan.add[0].properties.name, 'new');
  assert.match(plan.add[0].id, /^o[0-9a-f]{20}$/);
});

test('identical new features get distinct, stable ids', () => {
  const plan = planChanges([], [line('x', -120.1), line('x', -120.1)]);
  assert.equal(new Set(plan.add.map((f) => f.id)).size, 2);
  assert.equal(newId('k'), newId('k'));
});

test('an up-to-date dataset needs no changes', () => {
  const features = [line('a', -120.1), line('b', -120.2)];
  const plan = planChanges(features.map((f, i) => ({ ...f, id: String(i) })), features);
  assert.deepEqual([plan.keep, plan.remove.length, plan.add.length], [2, 0, 0]);
});

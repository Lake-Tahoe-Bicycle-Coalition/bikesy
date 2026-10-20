#!/usr/bin/env node
// Publish a build's class-*.geojson to the region's Mapbox datasets.
//
//   publish.mjs --region tahoe --from DIR          dry run: shows what would change
//   publish.mjs --region tahoe --from DIR --yes    changes the datasets
//
// Mapbox has no "replace dataset", and writes are limited to 40 per minute per dataset, so this
// only touches the difference: features already in the dataset that match a new feature (same
// geometry and properties) are kept, the new ones are added first, then the old ones deleted, so
// a layer is never empty. Re-running after an interruption continues where it stopped.
// Needs MAPBOX_SECRET_TOKEN (env or .env) with datasets:read and datasets:write.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchDataset, formatLayer } from './live.mjs';
import { loadRegion, regionPaths, secretToken } from './region.mjs';

const API = 'https://api.mapbox.com/datasets/v1';
const WRITES_PER_MINUTE = 36; // the limit is 40; stay under it
const USAGE = `Usage: publish.mjs --region NAME --from DIR [--yes]
  DIR holds class-I.geojson, class-II.geojson, class-III.geojson (a candidate/ or archive/ run, or
  an old-pipeline directory). Without --yes nothing is changed.`;

const round = (n) => Math.round(n * 1e6) / 1e6;
const roundCoords = (c) => (typeof c === 'number' ? round(c) : c.map(roundCoords));

// Identity of a feature: geometry (6 decimals, as Mapbox stores it) and sorted properties.
export function featureKey(feature) {
  const properties = Object.fromEntries(
    Object.entries(feature.properties ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const { type, coordinates } = feature.geometry;
  return JSON.stringify([type, roundCoords(coordinates), properties]);
}

export const newId = (key) => `o${createHash('sha1').update(key).digest('hex').slice(0, 20)}`;

// existing: features with ids from the dataset; incoming: features from the build.
// Returns {keep, remove: [id], add: [feature with id]}. Equal features are matched one to one,
// so duplicates in the dataset are removed.
export function planChanges(existing, incoming) {
  const free = new Map();
  for (const feature of incoming) {
    const key = featureKey(feature);
    free.set(key, [...(free.get(key) ?? []), feature]);
  }
  let keep = 0;
  const remove = [];
  for (const feature of existing) {
    const key = featureKey(feature);
    if (free.get(key)?.length) {
      free.get(key).pop();
      keep += 1;
    } else remove.push(feature.id);
  }
  const add = [...free.entries()].flatMap(([key, features]) =>
    features.map((f, n) => ({
      type: 'Feature',
      id: newId(`${key}#${n}`),
      properties: f.properties ?? {},
      geometry: f.geometry,
    })),
  );
  return { keep, remove, add };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One paced writer per dataset: the rate limit is per dataset.
function writer(datasetId, token) {
  let next = 0;
  return async function write(method, featureId, body) {
    for (let attempt = 1; ; attempt += 1) {
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
      next = Math.max(next, Date.now()) + 60000 / WRITES_PER_MINUTE;
      const res = await fetch(
        `${API}/${datasetId}/features/${encodeURIComponent(featureId)}?access_token=${token}`,
        {
          method,
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      if (res.ok) return;
      if (method === 'DELETE' && res.status === 404) return; // already gone
      if ((res.status === 429 || res.status >= 500) && attempt < 8) {
        const reset = Number(res.headers.get('x-rate-limit-reset'));
        const ms = reset ? reset * 1000 - Date.now() : 15000;
        next = Date.now() + Math.min(Math.max(ms, 2000), 70000);
        continue;
      }
      throw new Error(
        `${method} ${datasetId}/${featureId}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
  };
}

async function readBuild(dir, klass) {
  const file = path.join(dir, `class-${klass}.geojson`);
  const { features } = JSON.parse(await readFile(file, 'utf8'));
  for (const f of features)
    if (f.geometry?.type !== 'LineString' && f.geometry?.type !== 'MultiLineString')
      throw new Error(`${file}: unexpected ${f.geometry?.type} feature (strip points first).`);
  return features;
}

const fetchFresh = (datasetId, token) => fetchDataset(datasetId, token, { fresh: true });

async function publishClass({ klass, datasetId, features, token, backupDir, yes }) {
  const existing = await fetchFresh(datasetId, token);
  const plan = planChanges(existing, features);
  const writes = plan.add.length + plan.remove.length;
  console.log(
    `Class ${klass} (${datasetId}): ${existing.length} in dataset, ${features.length} in build -> keep ${plan.keep}, add ${plan.add.length}, delete ${plan.remove.length}; ${writes} writes, about ${Math.ceil(writes / WRITES_PER_MINUTE)} min`,
  );
  if (!yes) return { ok: true };

  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, `class-${klass}.geojson`), formatLayer(existing));

  const write = writer(datasetId, token);
  let done = 0;
  const tick = () => {
    done += 1;
    if (done % 50 === 0 || done === writes) console.log(`Class ${klass}: ${done}/${writes}`);
  };
  for (const feature of plan.add) {
    await write('PUT', feature.id, feature);
    tick();
  }
  for (const id of plan.remove) {
    await write('DELETE', id);
    tick();
  }

  const after = await fetchFresh(datasetId, token);
  const left = planChanges(after, features);
  const ok = !left.remove.length && !left.add.length && after.length === features.length;
  console.log(
    ok
      ? `Class ${klass}: verified, ${after.length} features match the build.`
      : `Class ${klass}: MISMATCH, ${after.length} in dataset, ${left.add.length} missing, ${left.remove.length} extra. Run again.`,
  );
  return { ok, after };
}

async function main() {
  const { values } = parseArgs({
    options: {
      region: { type: 'string' },
      from: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
  });
  if (!values.region || !values.from) {
    console.error(USAGE);
    process.exit(2);
  }
  const region = await loadRegion(values.region);
  const classes = Object.keys(region.datasets);
  if (!classes.length) throw new Error(`${region.name} has no Mapbox datasets.`);
  const token = await secretToken();
  if (!token) throw new Error('Set MAPBOX_SECRET_TOKEN (datasets:read and datasets:write).');
  const paths = regionPaths(region.name);
  const from = path.resolve(values.from);
  const backupDir = path.join(paths.archive, `pre-publish-${new Date().toISOString().replace(/[:.]/g, '-')}`);

  const builds = {};
  for (const klass of classes) builds[klass] = await readBuild(from, klass);
  console.log(`${values.yes ? 'Publishing' : 'Dry run:'} ${from} -> ${region.name} datasets`);

  // Classes run side by side: the write limit is per dataset.
  const results = await Promise.all(
    classes.map((klass) =>
      publishClass({
        klass,
        datasetId: region.datasets[klass],
        features: builds[klass],
        token,
        backupDir,
        yes: values.yes,
      }),
    ),
  );
  if (!values.yes) {
    console.log('Nothing changed. Run again with --yes to publish.');
    return;
  }
  if (results.some((r) => !r.ok)) process.exit(1);
  await mkdir(paths.live, { recursive: true });
  for (const [i, klass] of classes.entries())
    await writeFile(path.join(paths.live, `class-${klass}.geojson`), formatLayer(results[i].after));
  console.log(`Previous datasets saved in ${backupDir}.`);
  console.log(`live/ now matches Mapbox: commit ${paths.live}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });

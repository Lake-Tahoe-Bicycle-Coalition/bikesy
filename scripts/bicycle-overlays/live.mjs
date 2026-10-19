// data/bicycle-overlays/<region>/live: refreshed from the region's Mapbox datasets, or for
// regions without them (drawn in the Mapbox style) replaced by a build.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.mapbox.com/datasets/v1';

async function fetchDataset(datasetId, token) {
  const features = [];
  let url = `${API}/${datasetId}/features?limit=100&access_token=${token}`;
  while (url) {
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(
        `${datasetId}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    features.push(...(await res.json()).features);
    const next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    if (!next) break;
    const nextUrl = new URL(next);
    nextUrl.searchParams.set('access_token', token);
    url = nextUrl.href;
  }
  return features;
}

// One feature per line, sorted by id, so git diffs show which features changed.
export const formatLayer = (features) =>
  `{"type":"FeatureCollection","features":[\n${[...features]
    .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')))
    .map((f) => JSON.stringify(f))
    .join(',\n')}\n]}\n`;

// Writes class-<C>.geojson for each dataset; returns the classes whose file changed.
export async function refreshLive(datasets, dir, token) {
  const layers = {};
  for (const [klass, datasetId] of Object.entries(datasets))
    layers[klass] = formatLayer(await fetchDataset(datasetId, token));
  await mkdir(dir, { recursive: true });
  const changed = [];
  for (const [klass, text] of Object.entries(layers)) {
    const file = path.join(dir, `class-${klass}.geojson`);
    const old = await readFile(file, 'utf8').catch(() => null);
    if (old === text) continue;
    await writeFile(file, text);
    changed.push(klass);
  }
  return changed;
}

// Make a build the live baseline: its class-*.geojson and run.json replace live/.
export async function buildToLive(buildDir, dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of await readdir(buildDir))
    if (/^class-.*\.geojson$/.test(file) || file === 'run.json')
      await copyFile(path.join(buildDir, file), path.join(dir, file));
}

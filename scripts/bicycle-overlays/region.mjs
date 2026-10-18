// Region settings and data directories shared by download_and_build.mjs and review.mjs.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');

// src/appConfig/NAME.js merged over defaults.js, like src/appConfig/index.js does.
export async function loadRegion(name) {
  if (!/^[a-z0-9-]+$/.test(name ?? ''))
    throw new Error('--region must name a src/appConfig/*.js file, e.g. --region tahoe.');
  const load = async (file) =>
    (await import(pathToFileURL(path.join(ROOT, 'src/appConfig', `${file}.js`)))).default;
  const config = { ...(await load('defaults')), ...(await load(name)) };
  const { TOP, RIGHT, BOTTOM, LEFT } = config.SEARCH_BOUNDS;
  return {
    name,
    // Same bounds as generate.mjs --region: BICYCLE_OVERLAY_OPTIONS.bbox, else SEARCH_BOUNDS.
    bbox: config.BICYCLE_OVERLAY_OPTIONS?.bbox ?? [LEFT, BOTTOM, RIGHT, TOP],
    // Geofabrik paths, e.g. 'north-america/us/nevada'.
    extracts: config.BICYCLE_OVERLAY_EXTRACTS ?? [],
    // The published class layers: MAP_LAYERS entries with an overlayClass.
    datasets: Object.fromEntries(
      (config.MAP_LAYERS ?? [])
        .filter((layer) => layer.overlayClass && layer.datasetId)
        .map((layer) => [layer.overlayClass, layer.datasetId]),
    ),
  };
}

// data/bicycle-overlays/NAME: decisions.json and live/ are committed; the rest is ignored.
export function regionPaths(name) {
  const dir = path.join(ROOT, 'data/bicycle-overlays', name);
  return {
    dir,
    decisions: path.join(dir, 'decisions.json'),
    live: path.join(dir, 'live'),
    candidate: path.join(dir, 'candidate'),
    archive: path.join(dir, 'archive'),
    // Shared by all regions: several use the same Geofabrik extract.
    downloads: path.join(ROOT, 'data/bicycle-overlays/downloads'),
  };
}

// The candidate's run.json: {run, built_at, extracts: [{path, last_modified, md5}]}.
export async function readRun(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// MAPBOX_SECRET_TOKEN from the environment or the repository's .env.
export async function secretToken() {
  if (process.env.MAPBOX_SECRET_TOKEN) return process.env.MAPBOX_SECRET_TOKEN;
  try {
    const env = await readFile(path.join(ROOT, '.env'), 'utf8');
    return env.match(/^MAPBOX_SECRET_TOKEN=["']?([^"'\s]+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

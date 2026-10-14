#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELP = `List what changed between two sets of class layers: stretches added, removed, or moved
to a different class.
Usage: node scripts/bicycle-overlays/diff.mjs --before DIR --after DIR [options]
  --before DIR          class-I..IV.geojson as published or previously generated; features
                        need no OSM IDs (a snapshot of hand-maintained layers works)
  --after DIR           any directory of class-*.geojson (a generate.mjs or old pipeline output)
  --output FILE         write the changes as JSON
  --extract FILE        the .osm/.osm.pbf the run used; lists the OSM ways each change
                        without OSM IDs runs along, longest first
  --python FILE         default: tool-local .venv/bin/python (needed with --extract)
  --tolerance METRES    default 20: lines closer than this count as the same stretch
  --min-length METRES   default 50: ignore shorter differences
Matching is geometric, every 10 m along each line, so it works whether or not the before
layers carry OSM IDs. A stretch whose class differs is reported once, as changed.
`;

export const CLASSES = ['I', 'II', 'III', 'IV'];
export const STEP = 10;
const CELL = 100;

export const lineParts = (geometry) =>
  geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates];

export function projector(collections) {
  let sum = 0;
  let n = 0;
  for (const fc of collections)
    for (const f of fc.features)
      for (const part of lineParts(f.geometry))
        for (const [, lat] of part) {
          sum += lat;
          n++;
        }
  const lat0 = n ? sum / n : 0;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return ([lng, lat]) => [lng * kx, lat * 110570];
}

export function segmentGrid(collection, project) {
  const grid = new Map();
  for (const f of collection?.features ?? [])
    for (const part of lineParts(f.geometry)) {
      const pts = part.map(project);
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]];
        for (
          let x = Math.floor(Math.min(a[0], b[0]) / CELL);
          x <= Math.floor(Math.max(a[0], b[0]) / CELL);
          x++
        )
          for (
            let y = Math.floor(Math.min(a[1], b[1]) / CELL);
            y <= Math.floor(Math.max(a[1], b[1]) / CELL);
            y++
          ) {
            const key = `${x},${y}`;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push([a, b]);
          }
      }
    }
  return grid;
}

export function isNear(grid, p, tolerance) {
  const r = Math.ceil(tolerance / CELL);
  const cx = Math.floor(p[0] / CELL);
  const cy = Math.floor(p[1] / CELL);
  for (let x = cx - r; x <= cx + r; x++)
    for (let y = cy - r; y <= cy + r; y++)
      for (const [a, b] of grid.get(`${x},${y}`) ?? []) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1),
          ),
        );
        if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) <= tolerance)
          return true;
      }
  return false;
}

// Split a line part into the pieces where `keep(projectedPoint)` holds, judged every 10 m.
// Pieces keep the original vertices between their ends, so cutting never reshapes a line.
export function cutLine(part, keep, project) {
  const pieces = [];
  let piece = null;
  const push = (p) => {
    const last = piece[piece.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) piece.push(p);
  };
  const close = () => {
    if (piece?.length > 1) pieces.push(piece);
    piece = null;
  };
  for (let i = 1; i < part.length; i++) {
    const [a, b] = [part[i - 1], part[i]];
    const [pa, pb] = [project(a), project(b)];
    const n = Math.max(1, Math.round(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / STEP));
    const at = (t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    for (let j = 0; j < n; j++) {
      if (keep(project(at((j + 0.5) / n)))) {
        if (!piece) {
          piece = [];
          push(j === 0 ? a : at(j / n));
        }
        if (j === n - 1) push(b);
      } else if (piece) {
        push(j === 0 ? a : at(j / n));
        close();
      }
    }
  }
  close();
  return pieces;
}

// Consecutive 10 m samples of a feature with no counterpart in `grid`, as stretches.
function unmatched(feature, grid, project, { tolerance, minLength }) {
  const stretches = [];
  for (const part of lineParts(feature.geometry)) {
    let run = null;
    const close = () => {
      if (run && run.metres >= minLength) stretches.push(run);
      run = null;
    };
    for (let i = 1; i < part.length; i++) {
      const [a, b] = [part[i - 1], part[i]];
      const [pa, pb] = [project(a), project(b)];
      const length = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      const n = Math.max(1, Math.round(length / STEP));
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        const ll = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        if (isNear(grid, project(ll), tolerance)) close();
        else {
          run ??= { coords: [], metres: 0 };
          run.coords.push(ll);
          run.metres += length / n;
        }
      }
    }
    close();
  }
  return stretches;
}

// The other class that this stretch replaced (or was replaced by): it covers over half the
// stretch in `grids` and is absent there in `counterGrids`. A parallel facility that still
// exists on both sides (a path beside a road with new lanes) does not count.
function otherClass(coords, grids, counterGrids, exclude, project, tolerance) {
  let best = null;
  let bestShare = 0.5;
  for (const [klass, grid] of Object.entries(grids)) {
    if (klass === exclude) continue;
    const counter = counterGrids[klass];
    const share =
      coords.filter((ll) => {
        const p = project(ll);
        return isNear(grid, p, tolerance) && !(counter && isNear(counter, p, tolerance));
      }).length / coords.length;
    if (share > bestShare) [best, bestShare] = [klass, share];
  }
  return best;
}

export function diffLayers(before, after, { tolerance = 20, minLength = 50 } = {}) {
  const project = projector([...Object.values(before), ...Object.values(after)]);
  const gridsBefore = Object.fromEntries(
    Object.entries(before).map(([k, fc]) => [k, segmentGrid(fc, project)]),
  );
  const gridsAfter = Object.fromEntries(
    Object.entries(after).map(([k, fc]) => [k, segmentGrid(fc, project)]),
  );
  const options = { tolerance, minLength };
  const changes = [];
  const round = (p) => p.map((v) => Number(v.toFixed(6)));
  const add = (change, feature, run, source) => {
    const coords = run.coords.map(round);
    const mid = coords[Math.floor(coords.length / 2)];
    const wayId = feature.properties?.osm_way_id ?? null;
    changes.push({
      id: `${change.type}:${change.before ?? '-'}>${change.after ?? '-'}:${wayId ?? feature.properties?.name ?? ''}:${mid[0].toFixed(4)},${mid[1].toFixed(4)}`,
      ...change,
      source,
      name: feature.properties?.name || null,
      metres: Math.round(run.metres),
      mid,
      coords,
      ways: wayId
        ? [
            {
              id: wayId,
              name: feature.properties.name ?? null,
              highway: feature.properties.highway ?? null,
            },
          ]
        : [],
    });
  };
  for (const klass of CLASSES) {
    for (const [index, feature] of (after[klass]?.features ?? []).entries())
      for (const run of unmatched(
        feature,
        gridsBefore[klass] ?? new Map(),
        project,
        options,
      )) {
        const from = otherClass(
          run.coords,
          gridsBefore,
          gridsAfter,
          klass,
          project,
          tolerance,
        );
        add(
          from
            ? { type: 'changed', before: from, after: klass }
            : { type: 'added', before: null, after: klass },
          feature,
          run,
          { side: 'after', layer: klass, index },
        );
      }
    for (const [index, feature] of (before[klass]?.features ?? []).entries())
      for (const run of unmatched(
        feature,
        gridsAfter[klass] ?? new Map(),
        project,
        options,
      ))
        // A stretch now in another class was already reported from the after side.
        if (!otherClass(run.coords, gridsAfter, gridsBefore, klass, project, tolerance))
          add({ type: 'removed', before: klass, after: null }, feature, run, {
            side: 'before',
            layer: klass,
            index,
          });
  }
  return changes.sort((a, b) => b.metres - a.metres);
}

export function summarize(changes) {
  const summary = {};
  for (const c of changes) {
    const klass = c.type === 'changed' ? `${c.before}>${c.after}` : (c.after ?? c.before);
    const row = (summary[c.type] ??= {});
    const cell = (row[klass] ??= { count: 0, km: 0 });
    cell.count++;
    cell.km = Number((cell.km + c.metres / 1000).toFixed(2));
  }
  return summary;
}

export async function readLayers(dir) {
  const layers = {};
  for (const klass of CLASSES) {
    const file = path.join(dir, `class-${klass}.geojson`);
    try {
      await access(file);
    } catch {
      continue;
    }
    layers[klass] = JSON.parse(await readFile(file, 'utf8'));
  }
  if (!Object.keys(layers).length) throw new Error(`No class-*.geojson files in ${dir}`);
  return layers;
}

async function waysAlong(changes, extract, python) {
  const temp = await mkdtemp(path.join(tmpdir(), 'bikesy-diff-'));
  try {
    const input = path.join(temp, 'stretches.json');
    const output = path.join(temp, 'ways.json');
    await writeFile(
      input,
      JSON.stringify(Object.fromEntries(changes.map((c) => [c.id, c.coords]))),
    );
    const run = spawnSync(
      python,
      ['-I', path.join(HERE, 'ways_near.py'), extract, input, output],
      {
        encoding: 'utf8',
      },
    );
    if (run.status !== 0)
      throw new Error(`ways_near.py failed: ${run.stderr || run.error}`);
    return JSON.parse(await readFile(output, 'utf8'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      before: { type: 'string' },
      after: { type: 'string' },
      output: { type: 'string' },
      extract: { type: 'string' },
      python: { type: 'string' },
      tolerance: { type: 'string', default: '20' },
      'min-length': { type: 'string', default: '50' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(HELP);
  if (!values.before || !values.after)
    throw new Error('--before and --after are required.');
  const tolerance = Number(values.tolerance);
  const minLength = Number(values['min-length']);
  if (!(tolerance > 0) || !(minLength >= 0))
    throw new Error('Invalid --tolerance or --min-length.');
  const before = await readLayers(values.before);
  const after = await readLayers(values.after);
  const changes = diffLayers(before, after, { tolerance, minLength });
  if (values.extract) {
    const missing = changes.filter((c) => !c.ways.length);
    const python = path.resolve(values.python ?? path.join(HERE, '.venv/bin/python'));
    const found = await waysAlong(missing, path.resolve(values.extract), python);
    for (const c of missing) c.ways = found[c.id] ?? [];
  }
  const summary = summarize(changes);
  if (values.output)
    await writeFile(
      values.output,
      JSON.stringify(
        {
          before: path.resolve(values.before),
          after: path.resolve(values.after),
          extract: values.extract ? path.resolve(values.extract) : null,
          tolerance_m: tolerance,
          min_length_m: minLength,
          summary,
          changes,
        },
        null,
        1,
      ) + '\n',
    );
  for (const type of ['added', 'removed', 'changed']) {
    const cells = Object.entries(summary[type] ?? {})
      .map(([k, v]) => `${k.replace('>', '→')} ${v.count} (${v.km} km)`)
      .join(', ');
    console.log(`${type.padEnd(8)} ${cells || 'none'}`);
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(`Diff failed: ${error.message}`);
    process.exitCode = 1;
  });

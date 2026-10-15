#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isRecurring, readDecisions } from './decisions.mjs';
import {
  CLASSES,
  cutLine,
  isNear,
  lineParts,
  projector,
  readLayers,
  segmentGrid,
} from './diff.mjs';

const HELP = `Write updated class layers: the before layers plus only the changes you accepted.
Usage: node scripts/bicycle-overlays/apply.mjs --changes FILE --decisions FILE --output NEW_DIRECTORY
  --changes FILE    output of diff.mjs (it names the before and after directories)
  --decisions FILE  {"version": 2, "decisions": {"<change id>": {"decision": "accept" | "reject", "reason": "osm" | "generator"}}}
                    (version 1 files with include / exclude are read too)
  --output DIR      must not exist; receives class-*.geojson and applied.json
Changes without a decision, or rejected, leave the before layers as they were. A reject made
on an earlier diff whose change is back (still present) counts as undecided: recurring.
`;

// Samples from diff.mjs lie exactly on their own feature, so a 1 m match selects the same
// stretch. Erasing a changed stretch from another feature uses the diff's tolerance.
const SAME_FEATURE = 1;

const geometryOf = (pieces) =>
  pieces.length === 1
    ? { type: 'LineString', coordinates: pieces[0] }
    : { type: 'MultiLineString', coordinates: pieces };
const round = (pieces) =>
  pieces.map((piece) =>
    piece.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]),
  );
const lineCollection = (coordsList) => ({
  type: 'FeatureCollection',
  features: coordsList.map((coordinates) => ({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates:
        coordinates.length > 1 ? coordinates : [coordinates[0], coordinates[0]],
    },
  })),
});

// Accepted, rejected on this diff (by reason), recurring rejects (back after an earlier reject,
// counted as undecided) and the rest.
export function tally(changes, decisions, run) {
  const rejected = { osm: 0, generator: 0 };
  let accepted = 0;
  let recurring = 0;
  for (const c of changes) {
    const d = decisions[c.id];
    if (d?.decision === 'accept') accepted++;
    else if (isRecurring(d, run)) recurring++;
    else if (d?.decision === 'reject')
      rejected[d.reason === 'generator' ? 'generator' : 'osm']++;
  }
  return {
    accepted,
    rejected,
    recurring,
    undecided: changes.length - accepted - rejected.osm - rejected.generator,
  };
}

export function applyChanges(before, after, changes, decisions, { tolerance = 20 } = {}) {
  const project = projector([...Object.values(before), ...Object.values(after)]);
  const accepted = changes.filter((c) => decisions[c.id]?.decision === 'accept');
  const output = {};

  for (const klass of CLASSES) {
    const features = before[klass]?.features ?? [];
    const own = accepted.filter((c) => c.type === 'removed' && c.before === klass);
    const moved = accepted.filter((c) => c.type === 'changed' && c.before === klass);
    const movedGrid = moved.length
      ? segmentGrid(lineCollection(moved.map((c) => c.coords)), project)
      : null;
    const kept = [];
    for (const [index, feature] of features.entries()) {
      const mine = own.filter((c) => c.source.index === index);
      const ownGrid = mine.length
        ? segmentGrid(lineCollection(mine.map((c) => c.coords)), project)
        : null;
      if (!ownGrid && !movedGrid) {
        kept.push({
          ...feature,
          properties: { ...feature.properties, overlay_source: 'before' },
        });
        continue;
      }
      const keep = (p) =>
        !(ownGrid && isNear(ownGrid, p, SAME_FEATURE)) &&
        !(movedGrid && isNear(movedGrid, p, tolerance));
      const pieces = lineParts(feature.geometry).flatMap((part) =>
        cutLine(part, keep, project),
      );
      if (pieces.length)
        kept.push({
          ...feature,
          geometry: geometryOf(round(pieces)),
          properties: { ...feature.properties, overlay_source: 'before' },
        });
    }
    for (const c of accepted.filter((x) => x.type !== 'removed' && x.after === klass)) {
      const feature = after[klass].features[c.source.index];
      const grid = segmentGrid(lineCollection([c.coords]), project);
      const pieces = lineParts(feature.geometry).flatMap((part) =>
        cutLine(part, (p) => isNear(grid, p, SAME_FEATURE), project),
      );
      if (!pieces.length) continue;
      const { osm_way_id, name, highway } = feature.properties;
      kept.push({
        type: 'Feature',
        geometry: geometryOf(round(pieces)),
        properties: {
          osm_way_id,
          name: name ?? null,
          highway: highway ?? null,
          overlay_source: 'after',
          change_id: c.id,
        },
      });
    }
    if (kept.length || before[klass])
      output[klass] = { type: 'FeatureCollection', features: kept };
  }
  return { layers: output, accepted };
}

async function main() {
  const { values } = parseArgs({
    options: {
      changes: { type: 'string' },
      decisions: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(HELP);
  if (!values.changes || !values.decisions || !values.output)
    throw new Error('--changes, --decisions and --output are required.');
  const diff = JSON.parse(await readFile(values.changes, 'utf8'));
  const decisions = readDecisions(JSON.parse(await readFile(values.decisions, 'utf8')));
  const before = await readLayers(diff.before);
  const after = await readLayers(diff.after);
  for (const c of diff.changes)
    if (c.source.side === 'after' && !after[c.source.layer]?.features[c.source.index])
      throw new Error(
        `${diff.after} no longer matches ${values.changes}; run diff.mjs again.`,
      );
  const { layers, accepted } = applyChanges(before, after, diff.changes, decisions, {
    tolerance: diff.tolerance_m,
  });
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output); // EEXIST is intentional: never replace an earlier result.
  for (const [klass, collection] of Object.entries(layers))
    await writeFile(
      path.join(output, `class-${klass}.geojson`),
      JSON.stringify(collection) + '\n',
    );
  const counts = tally(diff.changes, decisions, diff.after);
  await writeFile(
    path.join(output, 'applied.json'),
    JSON.stringify(
      {
        changes: path.resolve(values.changes),
        decisions: path.resolve(values.decisions),
        before: diff.before,
        after: diff.after,
        accepted: accepted.map(
          ({ id, type, before: from, after: to, name, metres, ways }) => ({
            id,
            type,
            before: from,
            after: to,
            name,
            metres,
            way_ids: ways.map((w) => w.id),
          }),
        ),
        ...counts,
      },
      null,
      1,
    ) + '\n',
  );
  console.log(
    `Applied ${accepted.length} of ${diff.changes.length} changes (rejected ${counts.rejected.osm} to fix in OSM, ${counts.rejected.generator} to fix in the generator; ${counts.undecided} undecided, of which ${counts.recurring} rejected earlier and still present) → ${output}`,
  );
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(`Apply failed: ${error.message}`);
    process.exitCode = 1;
  });

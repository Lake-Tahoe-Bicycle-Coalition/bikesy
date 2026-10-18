#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cleanFix, GROUP_GAP, REASONS } from './decisions.mjs';
import { diffDirs, summaryLines } from './diff.mjs';
import { refreshLive } from './live.mjs';
import { loadRegion, readRun, regionPaths, secretToken } from './region.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELP = `Compare the region's candidate with its live layers and review each change in the browser.
Usage: node scripts/bicycle-overlays/review.mjs --region NAME [options]
  --region NAME         uses data/bicycle-overlays/NAME: live/ (refreshed from Mapbox first when
                        MAPBOX_SECRET_TOKEN is set), candidate/ (from download_and_build.mjs) and
                        decisions.json, where decisions are saved as you make them
  --before DIR          compare these class-*.geojson instead of live/
  --after DIR           review these class-*.geojson instead of candidate/; an .osm.pbf
                        in the directory is used to list OSM ways along each change
  --tolerance METRES    default 20: lines closer than this count as the same stretch
  --min-length METRES   default 50: ignore shorter differences
  --group-gap METRES    default 500: same-named changes whose ends are this close are one group
  --decisions FILE      use this file instead of the region's
  --python FILE         default: tool-local .venv/bin/python
  --port N              default 8787; the server listens on 127.0.0.1 only
`;

const lean = (collection, keys) => ({
  type: 'FeatureCollection',
  features: collection.features.map((f) => ({
    type: 'Feature',
    geometry: f.geometry,
    properties: Object.fromEntries(keys.map((k) => [k, f.properties?.[k] ?? null])),
  })),
});

// Classification details per way from the after run's debug.jsonl, read on first use.
let whyIndex;
async function why(afterDir, wayId) {
  if (!whyIndex) {
    whyIndex = new Map();
    const lines = createInterface({
      input: createReadStream(path.join(afterDir, 'debug.jsonl')),
    });
    for await (const line of lines) {
      if (!line) continue;
      const r = JSON.parse(line);
      whyIndex.set(String(r.id), {
        tags: r.tags,
        warnings: r.classification.warnings,
        facilities: r.classification.facilities.map((f) => ({
          class: f.class_like,
          kind: f.kind,
          side: f.side,
          eligible: f.eligible,
          surface: f.surface_state,
          evidence: f.evidence,
          warnings: f.warnings,
        })),
      });
    }
  }
  return whyIndex.get(String(wayId)) ?? null;
}

async function main() {
  const { values } = parseArgs({
    options: {
      region: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      python: { type: 'string' },
      tolerance: { type: 'string', default: '20' },
      'min-length': { type: 'string', default: '50' },
      'group-gap': { type: 'string', default: String(GROUP_GAP) },
      decisions: { type: 'string' },
      port: { type: 'string', default: '8787' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(HELP);
  const region = await loadRegion(values.region);
  const paths = regionPaths(region.name);
  const decisionsFile = path.resolve(values.decisions ?? paths.decisions);
  let decisions = {};
  try {
    decisions = JSON.parse(await readFile(decisionsFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Sorted by change id, so the file diffs cleanly in git.
  const saveDecisions = async () => {
    const sorted = Object.fromEntries(
      Object.keys(decisions)
        .sort()
        .map((id) => [id, decisions[id]]),
    );
    await mkdir(path.dirname(decisionsFile), { recursive: true });
    const temp = `${decisionsFile}.tmp`;
    await writeFile(temp, JSON.stringify(sorted, null, 2) + '\n');
    await rename(temp, decisionsFile);
  };

  if (!values.before) {
    const token = await secretToken();
    if (!Object.keys(region.datasets).length)
      console.log(
        `${region.name} has no MAP_LAYERS with an overlayClass: live/ is not refreshed, so put the published class-*.geojson there yourself.`,
      );
    else if (!token)
      console.log('MAPBOX_SECRET_TOKEN is not set: using live/ as committed.');
    else
      try {
        const changed = await refreshLive(region.datasets, paths.live, token);
        console.log(
          changed.length
            ? `Live layers changed on Mapbox: class ${changed.join(', ')} (commit live/)`
            : 'Live layers are up to date with Mapbox.',
        );
      } catch (error) {
        console.log(
          `Could not refresh live/ from Mapbox (${error.message}); using it as committed.`,
        );
      }
  }
  const beforeDir = values.before ?? paths.live;
  const afterDir = values.after ?? paths.candidate;
  // A live/ built by download_and_build.mjs (regions without Mapbox datasets) has a run.json.
  const liveRun = await readRun(beforeDir);
  if (liveRun)
    console.log(
      `Before: ${liveRun.run}${liveRun.built_at ? `, built ${liveRun.built_at}` : ''}`,
    );
  if (!values.after && !(await stat(afterDir).catch(() => null)))
    throw new Error(
      `No candidate yet: node scripts/bicycle-overlays/download_and_build.mjs --region ${region.name}`,
    );
  const extract = (await readdir(afterDir)).find((f) => f.endsWith('.osm.pbf'));
  if (!extract)
    console.log(
      `No .osm.pbf in ${afterDir}: way lists only where the layers carry OSM IDs.`,
    );
  const { diff, before, after } = await diffDirs(beforeDir, afterDir, {
    run: (await readRun(afterDir))?.run,
    classes: Object.keys(region.datasets),
    tolerance: Number(values.tolerance),
    minLength: Number(values['min-length']),
    extract: extract && path.join(afterDir, extract),
    python: values.python,
  });
  for (const line of summaryLines(diff.summary)) console.log(line);
  const data = JSON.stringify({
    region: region.name,
    changes: { ...diff, group_gap_m: Number(values['group-gap']) },
    before: Object.fromEntries(
      Object.entries(before).map(([k, fc]) => [k, lean(fc, ['name'])]),
    ),
    after: Object.fromEntries(
      Object.entries(after).map(([k, fc]) => [k, lean(fc, ['osm_way_id', 'name'])]),
    ),
  });
  const page = await readFile(path.join(HERE, 'review.html'), 'utf8');

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/')
        return send(res, 200, page, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/decisions.mjs')
        return send(
          res,
          200,
          await readFile(path.join(HERE, 'decisions.mjs'), 'utf8'),
          'text/javascript; charset=utf-8',
        );
      if (req.method === 'GET' && url.pathname === '/data') return send(res, 200, data);
      if (req.method === 'GET' && url.pathname === '/decisions')
        return send(res, 200, decisions);
      const why_ = url.pathname.match(/^\/why\/(\d+)$/);
      if (req.method === 'GET' && why_)
        return send(res, 200, (await why(diff.after, why_[1])) ?? { found: false });
      if (req.method === 'PUT' && url.pathname === '/decisions') {
        // One change {id, ...} or a group {ids: [...], ...}; all-or-nothing, one file write.
        // Absent decision = leave as is, null = clear it. A group's osm_fix.ways may be from any
        // member; each member keeps only its own.
        let body = '';
        for await (const chunk of req) body += chunk;
        const {
          id,
          ids = [id],
          decision,
          reason,
          note,
          osm_fix,
          confirm,
        } = JSON.parse(body);
        const members = ids.map((x) => diff.changes.find((c) => c.id === x));
        if (!members.length || members.includes(undefined))
          return send(res, 404, { error: 'Unknown change' });
        if (decision && !['accept', 'reject'].includes(decision))
          return send(res, 400, { error: 'Bad decision' });
        if (decision === 'reject' && !REASONS.includes(reason))
          return send(res, 400, { error: 'A reject needs a reason: osm or generator' });
        let clean;
        if (osm_fix)
          try {
            clean = cleanFix(
              osm_fix,
              members.flatMap((c) => c.ways.map((w) => w.id)),
            );
          } catch (error) {
            return send(res, 400, { error: error.message });
          }
        // `run` says which diff the decision was made on. Saving only a note or fix keeps it;
        // a new or confirmed decision (even the same reject again) records this diff.
        const updated = {};
        for (const c of members) {
          const old = decisions[c.id];
          let fix = old?.osm_fix;
          if (osm_fix === null) fix = undefined;
          else if (clean)
            fix = {
              ...fix,
              ...clean,
              ...(clean.ways && {
                ways: clean.ways.filter((w) => c.ways.some((x) => Number(x.id) === w)),
              }),
            };
          const next = { ...old, osm_fix: fix, at: new Date().toISOString() };
          if (note !== undefined) next.note = note;
          if (decision !== undefined) {
            const same = decision === old?.decision && reason === old?.reason;
            next.decision = decision ?? undefined;
            next.reason = decision === 'reject' ? reason : undefined;
            next.run =
              decision && (confirm || !same) ? diff.run : decision ? old?.run : undefined;
          }
          const { decision: d, reason: r, run, note: n, osm_fix: f, at } = next;
          updated[c.id] = JSON.parse(
            JSON.stringify({ decision: d, reason: r, run, note: n, osm_fix: f, at }),
          );
          if (!d && !n && !f) updated[c.id] = null;
        }
        for (const [key, value] of Object.entries(updated))
          if (value) decisions[key] = value;
          else delete decisions[key];
        await saveDecisions();
        return send(
          res,
          200,
          Object.fromEntries(members.map((c) => [c.id, decisions[c.id] ?? {}])),
        );
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) {
      send(res, 500, { error: error.message });
    }
  });
  server.listen(Number(values.port), '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`Reviewing ${diff.changes.length} changes at http://127.0.0.1:${port}/`);
    console.log(`Decisions save to ${decisionsFile}. Press Ctrl+C to stop.`);
  });
}

main().catch((error) => {
  console.error(`Review failed: ${error.message}`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cleanFix } from './decisions.mjs';
import { readLayers } from './diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELP = `Review the output of diff.mjs in the browser and record include/exclude decisions.
Usage: node scripts/bicycle-overlays/review.mjs --changes FILE --decisions FILE [--port N]
  --changes FILE    output of diff.mjs
  --decisions FILE  created if missing; decisions are saved here as you make them. Reuse the
                    same file on later runs and repeated changes keep their decision.
  --port N          default 8787; the server listens on 127.0.0.1 only
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
      changes: { type: 'string' },
      decisions: { type: 'string' },
      port: { type: 'string', default: '8787' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(HELP);
  if (!values.changes || !values.decisions)
    throw new Error('--changes and --decisions are required.');
  const diff = JSON.parse(await readFile(values.changes, 'utf8'));
  const decisionsFile = path.resolve(values.decisions);
  let decisions = {};
  try {
    decisions = JSON.parse(await readFile(decisionsFile, 'utf8')).decisions ?? {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const saveDecisions = async () => {
    const temp = `${decisionsFile}.tmp`;
    await writeFile(temp, JSON.stringify({ decisions }, null, 1) + '\n');
    await rename(temp, decisionsFile);
  };
  const before = await readLayers(diff.before);
  const after = await readLayers(diff.after);
  const data = JSON.stringify({
    changes: diff,
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
        let body = '';
        for await (const chunk of req) body += chunk;
        const { id, decision, note, osm_fix, confirm } = JSON.parse(body);
        const change = diff.changes.find((c) => c.id === id);
        if (!change) return send(res, 404, { error: 'Unknown change' });
        if (decision && !['include', 'exclude'].includes(decision))
          return send(res, 400, { error: 'Bad decision' });
        let fix = decisions[id]?.osm_fix;
        if (osm_fix === null) fix = undefined;
        else if (osm_fix)
          try {
            fix = {
              ...fix,
              ...cleanFix(
                osm_fix,
                change.ways.map((w) => w.id),
              ),
            };
          } catch (error) {
            return send(res, 400, { error: error.message });
          }
        // `run` says which diff the decision was made on. Saving only a note or fix keeps it;
        // a new or confirmed decision (even the same exclude again) records this diff.
        const old = decisions[id];
        const next = {
          ...old,
          decision: decision ?? undefined,
          run:
            decision && (confirm || decision !== old?.decision) ? diff.after : old?.run,
          note: note ?? old?.note,
          osm_fix: fix,
          at: new Date().toISOString(),
        };
        if (!decision) delete next.run;
        if (!next.decision && !next.note && !next.osm_fix) delete decisions[id];
        else decisions[id] = JSON.parse(JSON.stringify(next));
        await saveDecisions();
        return send(res, 200, decisions[id] ?? {});
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

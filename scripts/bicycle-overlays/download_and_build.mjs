#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadRegion, readRun, regionPaths } from './region.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEOFABRIK = 'https://download.geofabrik.de';
const HELP = `Build a new candidate for review: download the region's OSM extracts, clip them to the
overlay bounds and run generate.mjs.
Usage: node scripts/bicycle-overlays/download_and_build.mjs --region NAME
  --region NAME   src/appConfig/NAME.js lists BICYCLE_OVERLAY_EXTRACTS (Geofabrik paths)
Extracts are kept in data/bicycle-overlays/downloads (shared by regions) and downloaded again only when
Geofabrik has a newer one (md5 differs). The new candidate goes to candidate/; the previous
one moves to archive/<its run>/. Requires osmium-tool (brew install osmium-tool) and the
generator's Python environment.
`;

const md5Of = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });

// Geofabrik throttles each connection, so download in parallel byte ranges.
async function download(url, file, parts = 8) {
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`);
  const size = Number(head.headers.get('content-length'));
  const part = `${file}.part`;
  const handle = await open(part, 'w');
  let done = 0;
  const progress = setInterval(
    () =>
      console.log(
        `  ${path.basename(file)} ${Math.round((100 * done) / size)}% of ${Math.round(size / 1e6)} MB`,
      ),
    10000,
  );
  try {
    const chunk = Math.ceil(size / parts);
    await Promise.all(
      Array.from({ length: parts }, async (_, i) => {
        const start = i * chunk;
        const end = Math.min(size, start + chunk) - 1;
        if (start > end) return;
        // Dropped connections are common on slow downloads: resume from where the range
        // stopped, giving up after 5 attempts in a row that make no progress.
        let position = start;
        for (let failures = 0; position <= end;) {
          const from = position;
          try {
            const res = await fetch(url, {
              headers: { range: `bytes=${position}-${end}` },
            });
            if (res.status !== 206)
              throw new Error(`${url}: no range support (HTTP ${res.status})`);
            for await (const buffer of res.body) {
              await handle.write(buffer, 0, buffer.length, position);
              position += buffer.length;
              done += buffer.length;
            }
            if (position <= end) throw new Error(`${url}: connection closed early`);
          } catch (error) {
            failures = position > from ? 1 : failures + 1;
            if (failures >= 5) throw error;
            console.log(`  retrying after: ${error.message}`);
            await new Promise((resolve) => setTimeout(resolve, 5000 * failures));
          }
        }
      }),
    );
  } finally {
    clearInterval(progress);
    await handle.close();
  }
  await rename(part, file);
}

// The current extract for a Geofabrik path, downloaded unless the local copy is current.
async function extract(geofabrikPath, downloads) {
  const url = `${GEOFABRIK}/${geofabrikPath}-latest.osm.pbf`;
  const file = path.join(downloads, path.basename(new URL(url).pathname));
  const md5Res = await fetch(`${url}.md5`);
  if (!md5Res.ok) throw new Error(`${url}.md5: HTTP ${md5Res.status}`);
  const md5 = (await md5Res.text()).split(/\s+/)[0];
  const head = await fetch(url, { method: 'HEAD' });
  const lastModified = head.headers.get('last-modified');
  const local = await stat(file).catch(() => null);
  if (local && (await md5Of(file)) === md5) console.log(`${geofabrikPath}: up to date`);
  else {
    console.log(`${geofabrikPath}: downloading`);
    await download(url, file);
    if ((await md5Of(file)) !== md5)
      throw new Error(`${file}: md5 does not match Geofabrik`);
  }
  return {
    file,
    path: geofabrikPath,
    last_modified: lastModified ? new Date(lastModified).toISOString() : null,
    md5,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT')
    throw new Error(
      `${command} not found${command === 'osmium' ? ' (brew install osmium-tool)' : ''}`,
    );
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed`);
}

const stamp = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
};

async function main() {
  const { values } = parseArgs({
    options: { region: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) return console.log(HELP);
  const region = await loadRegion(values.region);
  if (!region.extracts.length)
    throw new Error(`src/appConfig/${region.name}.js has no BICYCLE_OVERLAY_EXTRACTS.`);
  const paths = regionPaths(region.name);
  await mkdir(paths.downloads, { recursive: true });

  const extracts = [];
  for (const p of region.extracts) extracts.push(await extract(p, paths.downloads));

  // Clip each extract to the overlay bounds (whole ways), then merge.
  const pbf = path.join(paths.downloads, `${region.name}.osm.pbf`);
  const clips = [];
  for (const e of extracts) {
    const clip = path.join(
      paths.downloads,
      `${region.name}-${path.basename(e.file, '.osm.pbf')}-clip.osm.pbf`,
    );
    run('osmium', [
      'extract',
      '--bbox',
      region.bbox.join(','),
      '--strategy',
      'complete_ways',
      '--overwrite',
      '--output',
      clip,
      e.file,
    ]);
    clips.push(clip);
  }
  if (clips.length === 1) await rename(clips[0], pbf);
  else {
    run('osmium', ['merge', '--overwrite', '--output', pbf, ...clips]);
    for (const clip of clips) await rm(clip);
  }

  const name = stamp(new Date());
  const building = path.join(paths.dir, 'building');
  await rm(building, { recursive: true, force: true });
  run(process.execPath, [
    path.join(HERE, 'generate.mjs'),
    '--region',
    region.name,
    '--input',
    pbf,
    '--output',
    building,
  ]);
  await rename(pbf, path.join(building, `${region.name}.osm.pbf`));
  await writeFile(
    path.join(building, 'run.json'),
    JSON.stringify(
      {
        run: name,
        built_at: new Date().toISOString(),
        extracts: extracts.map(({ path: p, last_modified, md5 }) => ({
          path: p,
          last_modified,
          md5,
        })),
      },
      null,
      2,
    ) + '\n',
  );

  if (await stat(paths.candidate).catch(() => null)) {
    const previous = (await readRun(paths.candidate))?.run ?? `previous-${name}`;
    await mkdir(paths.archive, { recursive: true });
    await rename(paths.candidate, path.join(paths.archive, previous));
    console.log(`Archived the previous candidate as archive/${previous}`);
  }
  await rename(building, paths.candidate);
  console.log(
    `New candidate ${name} in ${path.relative(process.cwd(), paths.candidate)}`,
  );
  console.log(
    `Review it: node scripts/bicycle-overlays/review.mjs --region ${region.name}`,
  );
}

main().catch((error) => {
  console.error(`Candidate failed: ${error.message}`);
  process.exitCode = 1;
});

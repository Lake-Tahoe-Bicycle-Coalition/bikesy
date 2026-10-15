// Helpers shared by review.mjs, review.html (served at /decisions.mjs) and apply.mjs.

// Decisions file: {"version": 2, "decisions": {id: {decision: "accept" | "reject", reason, run, note, osm_fix, at}}}.
// A reject has a reason: "osm" (fix it in OSM) or "generator" (fix the rules). Version 1 had
// no version field and "include" / "exclude" (an exclude meant an OSM fix).
export const REASONS = ['osm', 'generator'];
export function readDecisions(json) {
  if (json?.version > 2) throw new Error(`Unknown decisions version ${json.version}`);
  return Object.fromEntries(
    Object.entries(json?.decisions ?? {}).map(([id, entry]) => {
      const { decision, ...rest } = entry;
      if (decision === 'include') return [id, { decision: 'accept', ...rest }];
      if (decision === 'exclude')
        return [id, { decision: 'reject', reason: 'osm', ...rest }];
      return [id, entry];
    }),
  );
}

// A reject made on an earlier diff whose change is back: the problem is still there.
// Decisions saved before `run` existed count as made on the current diff.
export const isRecurring = (decision, run) =>
  decision?.decision === 'reject' && Boolean(decision.run) && decision.run !== run;

// Connected changes share a group, independent of input order (members keep input order, the
// group id is its smallest change id). Endpoints only, so cross streets stay out.
// 1. Changes with the same name (case-insensitive) join when endpoints are within `gap` metres.
// 2. An unnamed change joins the named groups it touches (endpoints within `tolerance`) only if
//    they all share one name; touching two different names, it joins neither.
// 3. Unnamed changes left over join each other within `tolerance`.
export const GROUP_GAP = 500;
const metresBetween = (a, b) =>
  Math.hypot(
    (a[0] - b[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180),
    a[1] - b[1],
  ) * 111320;
export function groupChanges(changes, tolerance = 20, gap = GROUP_GAP) {
  const root = changes.map((_, i) => i);
  const find = (i) => (root[i] === i ? i : (root[i] = find(root[i])));
  const union = (i, j) => (root[find(j)] = find(i));
  const ends = changes.map((c) => [c.coords[0], c.coords.at(-1)]);
  const within = (i, j, metres) =>
    ends[i].some((p) => ends[j].some((q) => metresBetween(p, q) <= metres));
  const key = (c) => c.name?.trim().toLowerCase() || null;
  const named = changes.flatMap((c, i) => (key(c) ? [i] : []));
  const unnamed = changes.flatMap((c, i) => (key(c) ? [] : [i]));
  for (const i of named)
    for (const j of named)
      if (i < j && key(changes[i]) === key(changes[j]) && within(i, j, gap)) union(i, j);
  const left = [];
  for (const n of unnamed) {
    const touched = named.filter((i) => within(n, i, tolerance));
    if (touched.length && new Set(touched.map((i) => key(changes[i]))).size === 1)
      for (const i of touched) union(i, n);
    else left.push(n);
  }
  for (const i of left)
    for (const j of left) if (i < j && within(i, j, tolerance)) union(i, j);
  const groups = new Map();
  changes.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });
  return [...groups.entries()].map(([r, members]) => {
    const coords = members.flatMap((c) => c.coords);
    const lngs = coords.map((p) => p[0]);
    const lats = coords.map((p) => p[1]);
    const ids = members.map((c) => c.id).sort();
    return {
      id: ids[0],
      name:
        members
          .map((c) => c.name)
          .filter(Boolean)
          .sort()[0] ?? null,
      members,
      metres: members.reduce((sum, c) => sum + c.metres, 0),
      coords,
      bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
    };
  });
}

// Ways of several changes, each once, longest total distance along the stretches first.
export function unionWays(changes) {
  const ways = new Map();
  for (const w of changes.flatMap((c) => c.ways)) {
    const seen = ways.get(w.id);
    if (seen) seen.metres += w.metres ?? 0;
    else ways.set(w.id, { ...w, metres: w.metres ?? 0 });
  }
  return [...ways.values()].sort((a, b) => (b.metres ?? 0) - (a.metres ?? 0));
}

// "surface=dirt -cycleway, highway=path;name=A B" → set key=value, remove -key. Separators:
// whitespace, commas, semicolons. Returns { tags: [[key, value | null]], error }.
export function parseTags(text) {
  const tags = [];
  for (const token of String(text ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean)) {
    const remove = token.match(/^-([^=\s-][^=\s]*)$/);
    const set = token.match(/^([^=\s-][^=\s]*)=(.+)$/);
    if (remove) tags.push([remove[1], null]);
    else if (set) tags.push([set[1], set[2]]);
    else
      return {
        tags: [],
        error: `"${token}": use key=value to set or -key to remove (no spaces in values)`,
      };
  }
  const seen = new Set();
  for (const [key] of tags) {
    if (seen.has(key)) return { tags: [], error: `"${key}" appears twice` };
    seen.add(key);
  }
  return { tags, error: null };
}

export const JOSM = 'http://127.0.0.1:8111/load_object';
// JOSM remote control: select the ways and apply the tags (removing a key = `key=`).
export function josmUrl(fix) {
  const { tags, error } = parseTags(fix?.tags);
  if (error || !tags.length || !fix.ways?.length) return null;
  const addtags = tags.map(([k, v]) => `${k}=${v ?? ''}`).join('|');
  return `${JOSM}?new_layer=false&objects=${fix.ways.map((id) => `w${id}`).join(',')}&addtags=${encodeURIComponent(addtags)}`;
}

// Satellite view centred on the change's bounding box, zoomed so the box fits (13-19).
export function googleMapsUrl(coords, { width = 800, height = 600 } = {}) {
  const lngs = coords.map((p) => p[0]);
  const lats = coords.map((p) => p[1]);
  const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  const fit = (pixels, degrees) => Math.log2((pixels * 360) / (256 * degrees));
  const cos = Math.cos((lat * Math.PI) / 180);
  const zoom = Math.floor(
    Math.max(
      13,
      Math.min(
        19,
        fit(width, Math.max(east - west, 1e-9)),
        fit(height, Math.max((north - south) / cos, 1e-9)),
      ),
    ),
  );
  return `https://www.google.com/maps/@?api=1&map_action=map&center=${lat.toFixed(6)},${lng.toFixed(6)}&zoom=${zoom}&basemap=satellite`;
}

// Keep only well-formed fix fields; ways must be among the change's way ids.
export function cleanFix(fix, wayIds) {
  if (fix.tags !== undefined && typeof fix.tags !== 'string') throw new Error('Bad tags');
  if (fix.status !== undefined && !['todo', 'uploaded'].includes(fix.status))
    throw new Error('Bad fix status');
  if (
    fix.ways !== undefined &&
    !(
      Array.isArray(fix.ways) &&
      fix.ways.every((id) => wayIds.some((w) => String(w) === String(id)))
    )
  )
    throw new Error('Bad fix ways');
  return Object.fromEntries(
    ['tags', 'ways', 'status']
      .filter((k) => fix[k] !== undefined)
      .map((k) => [k, k === 'ways' ? fix.ways.map(Number) : fix[k]]),
  );
}

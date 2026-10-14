// Helpers shared by review.mjs, review.html (served at /decisions.mjs) and apply.mjs.

// An exclude made on an earlier diff whose change is back: the OSM data is still wrong.
// Decisions saved before `run` existed count as made on the current diff.
export const isRecurring = (decision, run) =>
  decision?.decision === 'exclude' && Boolean(decision.run) && decision.run !== run;

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

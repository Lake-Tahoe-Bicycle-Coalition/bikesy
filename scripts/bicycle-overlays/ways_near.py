"""Find OSM highway ways that run along given line samples.

Usage: python -I ways_near.py EXTRACT.osm.pbf GAPS.json OUT.json
GAPS.json: {"gap id": [[lng, lat], ...]} sampled about every 10 m.
OUT.json:  {"gap id": [{"id": way_id, "name": ..., "highway": ..., "metres": along}, ...]}
metres is the stretch length within 20 m of the way (samples x 10 m). A way is kept when
that is at least min(20% of the stretch, 150 m), so cross streets and short footways that
only touch the stretch are left out. Ways are sorted by metres, longest first.
"""
import json
import math
import sys
from collections import defaultdict

import osmium

TOL = 20.0
STEP = 10
MIN_SHARE = 0.2
MIN_METRES = 150
CELL = 0.0005  # degrees; about 45-55 m around Tahoe
KX = 111320 * math.cos(math.radians(39.05))
KY = 110570


def main():
    extract, gaps_path, out_path = sys.argv[1:]
    with open(gaps_path) as f:
        gaps = json.load(f)
    grid = defaultdict(list)
    for gid, coords in gaps.items():
        for i, (lng, lat) in enumerate(coords):
            grid[(int(lng // CELL), int(lat // CELL))].append((gid, i, lng * KX, lat * KY))

    hits = defaultdict(lambda: defaultdict(set))
    info = {}
    processor = osmium.FileProcessor(extract).with_locations().with_filter(
        osmium.filter.KeyFilter("highway")
    )
    for way in processor:
        if not way.is_way():
            continue
        try:
            pts = [(n.lon, n.lat) for n in way.nodes]
        except osmium.InvalidLocationError:
            continue
        found = False
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            ax, ay, bx, by = x1 * KX, y1 * KY, x2 * KX, y2 * KY
            dx, dy = bx - ax, by - ay
            seg = dx * dx + dy * dy or 1
            for cx in range(int(min(x1, x2) // CELL) - 1, int(max(x1, x2) // CELL) + 2):
                for cy in range(int(min(y1, y2) // CELL) - 1, int(max(y1, y2) // CELL) + 2):
                    for gid, i, px, py in grid.get((cx, cy), ()):
                        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / seg))
                        if math.hypot(px - ax - t * dx, py - ay - t * dy) <= TOL:
                            hits[gid][way.id].add(i)
                            found = True
        if found:
            info[way.id] = {"name": way.tags.get("name"), "highway": way.tags.get("highway")}

    result = {}
    for gid, coords in gaps.items():
        need = min(MIN_SHARE * len(coords), MIN_METRES / STEP)
        ways = sorted(
            (wid for wid, samples in hits[gid].items() if len(samples) >= need),
            key=lambda wid: -len(hits[gid][wid]),
        )
        result[gid] = [
            {"id": wid, **info[wid], "metres": len(hits[gid][wid]) * STEP} for wid in ways
        ]
    with open(out_path, "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()

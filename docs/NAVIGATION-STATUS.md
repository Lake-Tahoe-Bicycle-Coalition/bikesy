# Turn-by-turn navigation: status

Working notes for branch `turn-by-turn-nav`, current as of 2026-10-20. Drop or condense
this file before opening the upstream PR.

The plan is in the separate `nav-demo` repo, `docs/IMPLEMENTATION-PLAN.md`. This branch
covers Step 2: porting the demo into the frontend. The backend half (Step 1) is branch
`turn-by-turn-nav` in `bikesy-backend`.

## Where things stand

|                          | State                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Step 0: pitch to Brendan | Not started                                                                                |
| Step 1: backend `nav=1`  | Done on bikesy-backend `turn-by-turn-nav`; deployed as a Vercel preview, not in production |
| Step 2: frontend         | Done on this branch; simulated rides pass, deployed as a Vercel preview                    |
| Step 3: field test       | Not started. Nothing has been tried on a real phone yet                                    |
| Step 4: launch           | Not started                                                                                |

Both branches are local and unpushed. The base is `upstream/master` (eea25b7) here, and
`origin/main` (0bb6477) for the backend.

## What's built

- **Start ride** button on phones, once a route is planned. It switches to navigation:
  - a follow camera;
  - a next-turn banner with a "Then…" strip;
  - spoken prompts;
  - arrival time, time left and distance left;
  - a steps list;
  - automatic rerouting after 3 s off route;
  - an arrival card with the ridden track.
    End or Done restores the planning screen.
- **Navigation engine:** Ferrostar 0.58.0, pinned exactly. It loads with a dynamic `import()`
  only when Start ride is tapped (about 317 kB gzipped). It works with Turbopack and webpack
  (`next.config.mjs`).
- **Region setting `NAVIGATION_ENABLED`:**
  - `false` by default, so SF and Contra Costa are unchanged.
  - Tahoe uses `'url'`, so navigation shows only with `?nav=1` in the page URL (for the
    field test). Set it to `true` at launch.
- **Routing:** route requests send `nav=1` only for rides and reroutes. Planning requests
  are unchanged.
- **Analytics:** `nav_start`, `nav_reroute`, `nav_arrive` and `nav_end_early` send only the
  scenario, distance and reroute count, never coordinates.
- **Development:**
  - `?sim=1` rides a simulated rider; add `&warp=8&noise=6` for speed-up and GPS noise.
  - `?debug=1` shows a heading and GPS readout.
  - `NEXT_PUBLIC_BIKESY_API_URL` overrides the region's backend URL.

Code:

- `src/lib/navigation/` holds the engine wrapper, ride controller, camera, layers, heading,
  device, simulator and formatting.
- `src/components/navigation/` holds the screens.
- `src/redux/slices/navigation.js` holds UI state only.

## Changes from the demo's tuning

- **Step advance.** With the demo's settings, Ferrostar 0.58 froze the turn banner under GPS
  noise, because its "reached end of step" flag toggles on each fix. In simulation at 6 m of
  noise:
  - demo settings: 36% of rides finished with the banner following;
  - new settings: 99.9%.

  The new setting keeps the demo's check that the rider has actually passed the maneuver,
  plus a bounded fallback (see `NAV_CONFIG` in `navigator.js`).
  `step-advance.test.mjs` runs the real engine. **Check this first in the field test.**

- **Distance ridden** counts progress along the route. Ferrostar's own counter adds up GPS
  jitter: at 6 m of noise it showed 3.9 mi for a 2.5 mi ride.
- **Riding from your current position.** A ride starts from the rider's position when it is
  more than 150 m (plus the GPS accuracy) from the planned start. Only fixes accurate to
  50 m or better are used for this check.

## Verified

- `pnpm exec node --test src/lib/*.test.mjs src/lib/navigation/*.test.mjs`: 183 pass.
- `next build` and `next build --webpack` pass.
- Ferrostar is absent from the initial JS. The initial JS grows by about 6–8 kB gzipped for
  the navigation screens.
- Headless Chrome, at phone size against a local backend, with simulated rides:
  - a ride runs start, turn, missed turn, reroute, arrival, Done, with and without GPS noise;
  - failure paths show a message and stay on planning: location refused, an old backend,
    offline, and a failed download;
  - SF, desktop, and Tahoe without `?nav=1` are pixel-identical to `upstream/master`.
- An independent code review found two bugs, both fixed and covered by tests: a blank screen
  after switching to Directions during start, and a wake lock and compass left on after a
  cancelled start.

## Not verified

These need real phones (Step 3): the iOS compass permission prompt, screen wake lock,
speech, compass behaviour on a handlebar mount, battery use, and GPS under trees.

## Test deployment (Vercel preview, team `tahoebike`)

Production is untouched:

- `map.tahoebike.org` and `newmap.tahoebike.org` stay on production deployments;
- `bikesy-backend.tahoebike.org` serves data image v2-20261019 without `nav=1`.

|                                    | Preview deployment                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend (`bikesy` project)        | https://bikesy-hdi05qr7d-tahoebike.vercel.app (built from this branch at 87112cb)                                                                        |
| Backend (`bikesy-backend` project) | https://bikesy-backend-386v830hz-tahoebike.vercel.app (code from bikesy-backend `turn-by-turn-nav`, data image v2-20261019, the same data as production) |

Both preview URLs require a Vercel login (Standard Deployment Protection). The frontend can't
call a protected backend from the browser, so the previews are meant to be reached through
public test subdomains, which the protection doesn't cover:

- `navtest.tahoebike.org` → the frontend preview
- `navtest-api.tahoebike.org` → the backend preview. The frontend preview was built with
  `NEXT_PUBLIC_BIKESY_API_URL=https://navtest-api.tahoebike.org/route`.

**Pending:** both names need a DNS record at Hover. `*.tahoebike.org` has a wildcard A record
pointing at another server, so Vercel can't issue certificates until these exist:

```
navtest      CNAME  cname.vercel-dns.com
navtest-api  CNAME  cname.vercel-dns.com
```

Then run:

```sh
vercel alias set bikesy-backend-386v830hz-tahoebike.vercel.app navtest-api.tahoebike.org --scope tahoebike
vercel alias set bikesy-hdi05qr7d-tahoebike.vercel.app navtest.tahoebike.org --scope tahoebike
```

Test on a phone at `https://navtest.tahoebike.org/?nav=1`, or `?nav=1&sim=1` for a
simulated ride. These aliases point at single deployments, not at the projects, so production
deploys never move them. Remove them with `vercel alias rm <name> --scope tahoebike`.

### Redeploying after changes

Frontend, from a clean export of the branch, so no local `.env.local` is uploaded:

```sh
X=$(mktemp -d) && git archive turn-by-turn-nav | tar -x -C "$X"
vercel link --yes --cwd "$X" --scope tahoebike --project bikesy && rm -f "$X/.env.local"
vercel deploy --cwd "$X" --scope tahoebike --target preview \
  --build-env NEXT_PUBLIC_BIKESY_API_URL=https://navtest-api.tahoebike.org/route
vercel alias set <new deployment URL> navtest.tahoebike.org --scope tahoebike
```

The backend steps are in bikesy-backend's `docs/NAVIGATION-STATUS.md`.

## Open questions

1. Is the Start ride button in the right place (bottom centre of the map)?
2. On phones, bike overlays stay off until the legend is opened, so a ride shows no bike
   lanes by default. Should starting a ride turn them on?
3. Every region's initial JS grows by about 6–8 kB gzipped for the navigation screens. Accept
   that, or lazy-load the screens too?
4. There are about 2,500 lines of new tests, against about 900 already in the repo. Trim
   them before the upstream PR?
5. `redux-logger` already runs in production builds. During a ride it logs about once a
   second. Gate it on `NODE_ENV`?
6. Should the far-from-start distance be 150 m (as in the demo) or 100 m (as in the plan)?

## Next steps

1. Add the two DNS records and aliases above, then ride with the preview on iPhone and Android
   (Step 3 checklist in the plan).
2. Send the plan's Step 0 pitch to Brendan.
3. Open the backend PR, then release `nav=1` to production with the release-backend skill.
4. Open the frontend PR. Do the Step 4 items: a permission explainer, a screen-on and battery
   note, the privacy policy, and a mention in the welcome dialog.

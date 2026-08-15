# Wusool (وصول) — backend

Turns free-text Palestinian addresses into verified GPS locations, learns from every
delivery, and routes drivers around live checkpoint closures.

```bash
cd backend
npm install          # ~7s, no native builds
npm run seed         # 8 checkpoints, 2753 landmarks, 294 synthetic deliveries
npm run dev          # http://localhost:4000  <- the whole app, API and UI
npm run smoke        # 22 end-to-end assertions, in another terminal
```

The frontend is served by the API, so the demo is one origin and needs no
internet. Open `http://localhost:4000` and everything — the customer flow, the
driver manifest, the dispatch dashboard — reads live rows. If the server is not
running, the page falls back to an in-browser simulation and says so.

### Other commands

```bash
npm run osm                              # re-pull landmarks from OpenStreetMap
npm run checkpoints -- --fix             # check checkpoint coordinates against OSM
DB_PATH=/tmp/bench.db npm run seed       # measure location accuracy on a
DB_PATH=/tmp/bench.db npm run bench      #   scratch DB, never the demo one
npm run warm                             # bake the LLM cache (needs a key)

cd ../telegram && python3 listener.py --replay      # feed road reports in
```

## It works with no API key and no internet

`ANTHROPIC_API_KEY` is **optional**. Without it the rule-based Arabic engine
(`services/rules.ts`) handles extraction and the whole cascade still runs. With it,
`claude-sonnet-5` parses first and the rule engine backs it up on any failure.

This is not a fallback bolted on for safety — weak connectivity is the normal case in
Area C and at checkpoints, so an address pipeline that stops working offline does not
work in Palestine. `GET /api/health` reports which engine is live, and every
`Resolution` carries an `engine` field so the UI can show it.

`npm run warm` pushes every demo string through the LLM once and commits the cache, so
a warmed repo runs the full demo with the wifi switched off.

## The resolution cascade

Cheapest knowledge first. Every answer carries a plain-language `explain[]`.

| Tier | Question | Confidence |
|---|---|---|
| 1 | Has *this person* used *this address* before? | 0.98 |
| 2 | **Has anyone pinned this building before?** (the neighbour effect) | entity + 0.15 |
| 3 | Can we triangulate from the landmarks named? | 0.55 / 0.70 / 0.80 |
| 4 | Cold — city centroid at best, ask for one pin | 0.20 |

`> 0.75` resolves · `0.50–0.75` estimated (driver sees a flag) · `< 0.50` asks for a pin.

## Measured location accuracy

Location accuracy is 30% of the hackathon score, so it is measured rather than
asserted. `npm run bench` un-learns every building, resolves each address from
the text alone, then pins each building once and resolves a *differently worded*
address from a *different phone*. Ground truth is the building's known position;
every simulated pin carries 12 m of GPS error so the warm number is not 0 by
construction.

| | median | p90 | within 100 m |
|---|---|---|---|
| A normal mapping app (city centroid) | 1270 m | 2805 m | 4% |
| Wusool, from the text alone | 87 m | 1376 m | 56% |
| Wusool, after ONE customer pin | 9 m | 12 m | 100% |

27 buildings; 11 excluded for having a duplicate generated name and 2 for having
only one phrasing. The dashboard reads these numbers from `seed/accuracy.json`.

## API

```
POST /api/resolve                        {raw_text, phone?}      -> Resolution
POST /api/orders                         {items, phone, raw_address} -> Order
GET  /api/orders/:id                                             -> Order
POST /api/pin/:token                     {lat, lng}              -> PinResult
GET  /api/driver/tasks                                           -> DriverTask[]
POST /api/driver/road-tap                {checkpoint_id, status} -> {ok, checkpoints}
POST /api/deliveries/:orderId/complete   {lat, lng}              -> DeliveryResult
GET  /api/checkpoints                                            -> CheckpointState[]
GET  /api/road-events?limit=20                                   -> RoadEvent[]
POST /api/ingest/road-post               {text, source}          -> {parsed, matched, checkpoints}
GET  /api/dashboard/kpis                                         -> Kpis
GET  /api/dashboard/landmarks                                    -> learned ghost landmarks
GET  /api/dashboard/accuracy                                     -> the measured benchmark
POST /api/simulate/neighbor              {text, phone?}          -> Resolution
GET  /api/health
```

Types live in `shared/contract.ts`, copied to `backend/src/contract.ts`. **Change both
in the same commit.**

## Bugs found in the spec, and fixed here

1. **The neighbour-effect demo could never fire.** Tier 2 needs a building entity *with
   coordinates*; `onPinConfirmed` attached the entity but never positioned it, and the
   only rule that set coordinates needed 3 confirmations plus a completed delivery.
   Fixed in `verify.ts` — a pin (or a delivery) positions the building at
   `POSITIONED_CONFIDENCE = 0.65`, so tier 2 yields 0.80.
2. **The flagship demo address sat exactly on the threshold.** Two landmarks scored
   0.70 + 0.05 = 0.75, and `>= 0.75` resolved it outright, so no pin token was issued
   and the "pin once" step had nothing to tap. `cascade.ts` uses a strict `>`.
3. **Contract mismatch.** `/driver/tasks` returned `{order, resolution, route}` while
   `DriverTask` declared `{order, route}` — and `Order` already embeds its resolution.
   The route now matches the contract exactly.
4. **Timezone.** `road_events.reported_at` is epoch milliseconds, not
   `datetime('now')`. SQLite writes UTC and Palestine runs UTC+3, so a local-time
   comparison made every report look 180 minutes old and silently marked every
   checkpoint `assumed`.
5. **`claude-sonnet-4-6` -> `claude-sonnet-5`** for structured outputs, with
   `temperature` removed (rejected) and `thinking` explicitly disabled (adaptive
   thinking is on by default there and would add seconds to every parse on stage).

## Bugs found while building

- **Entity resolution merged different buildings.** Levenshtein ≤2 across a whole
  phrase matched `عمارة زيدان` to `عمارة حمدان` — two edits inside the family name,
  two different buildings, one merged entity, a driver sent to the wrong address.
  `lib/placename.ts` now strips generic stems (`عمارة` means "building" and carries no
  identity) and compares only the distinguishing tokens. `عمارة زيدان` still matches
  `برج زيدان`, which is correct — same building, two names.
- **New entities inherited the city centre.** The coordinate hint passed for fuzzy
  matching was being stored, so every unknown building "resolved" to downtown with
  false confidence. The hint is now search-only.
- **A shop name matched a different shop 6 km away.** With 28 hand-picked
  landmarks every proper noun was unique. Against the real OSM extract, seven
  places in Ramallah reduce to the distinctive token "الامل" alone — a
  supermarket, two pharmacies, a kindergarten and a petrol station — because
  stripping generic stems threw away the *type*. `placename.ts` now also
  compares the category the name declares: "صيدلية الأمل" is not
  "سوبرماركت الأمل", while "عمارة زيدان" still matches "برج زيدان".
- **An exact name match in the wrong town beat a fuzzy match in the right one.**
  A single exact alias hit was returned without any distance check, so a shop
  with the same name 6 km away won outright. An exact hit now has to be in the
  customer's town to be authoritative.
- **Chain names were guessed silently.** "بنك فلسطين" is six branches spread
  over 8.7 km; 127 alias strings resolve to places more than 500 m apart. The
  matcher picked one by confidence and reported no doubt. It now prefers the
  nearest to the city, counts the rivals it could not rule out, and the cascade
  subtracts 0.12 and says so in `explain[]` — which drops the order into the
  band where we ask for one tap instead of guessing.
- **A road report saying there was NO traffic was read as traffic.**
  "مافي زحمة" matched the congestion word and won. Inverting a clear-road report
  is the worst failure here: it routes drivers away from the one open road. The
  road parser now handles negation, and covers "سكر", "فتح", "بطيء", "تفتيش"
  and "حاجز طيار", which it previously ignored entirely.
- **Compound Arabic names never matched.** "عبد الناصر" and "عبدالناصر" overlap
  at 0.33 by token set and were judged different mosques. `normalizeArabic` now
  joins عبد / أبو / ابن / بن to the word that follows.
- **Addresses with no punctuation failed.** People type
  `البيرة عمارة زيدان جنب سوبرماركت الامل ط٢` with no commas. The parser now also
  splits on relation words and place stems, without breaking compounds like
  `سوبر ماركت`.

## Where the data comes from

- **Landmarks** — a live Overpass query over Ramallah, Al-Bireh, Beitunia, Kufr
  Aqab, Qalandia, Jifna and Birzeit, committed as `seed/landmarks.ramallah.json`
  (`npm run osm` to refresh). 3,887 named features in, 2,753 entities out:
  generic-named ones ("Supermarket", "مسجد") are dropped because a name with no
  distinctive token can only ever produce a wrong match. The 28 hand-verified
  downtown anchors outrank OSM where both have the same place.
- **Checkpoints** — `npm run checkpoints` re-checks all eight against OSM by
  proximity. Any that OSM cannot confirm stay flagged rather than being quietly
  "corrected"; `source` records which are OSM-verified.
- **Road reports** — `telegram/listener.py`. Replay mode streams recorded
  dialect messages through the same endpoint the live listener uses, so the demo
  never depends on somebody posting at the right moment.

## Deviations from the spec

- **`node:sqlite` instead of `better-sqlite3`** — same API shape, but built into Node
  ≥22.5, so `npm install` cannot fail on a native toolchain the night before the demo.
- **No build step** — Node strips TypeScript natively. `node src/index.ts` just runs.
  `npx tsc --noEmit` type-checks (currently clean).

## Layout

```
shared/contract.ts          the source of truth for API types
backend/src/
  contract.ts               copy, kept in sync
  db/                       schema.sql + node:sqlite helpers
  lib/arabic.ts             normalisation, Levenshtein, token overlap
  lib/placename.ts          generic-stem stripping, place-type groups, same-place test
  lib/geo.ts                haversine, centroid, point-to-line, hashing
  services/rules.ts         offline Arabic/English address parser
  services/llm.ts           Anthropic structured outputs + file cache
  services/parser.ts        LLM with rule-engine fallback
  services/entities.ts      entity resolution, landmark discovery
  services/cascade.ts       the 4-tier resolver
  services/verify.ts        pin + delivery, the learning writes
  services/roads.ts         checkpoint status, freshness decay
  services/routing.ts       OSRM alternatives scored by closures
  services/points.ts        pending -> verified incentive ledger
  routes/api.ts             every endpoint
  seed/
    fetch-osm.ts            Overpass pull -> landmarks.ramallah.json
    verify-checkpoints.ts   checks checkpoint coordinates against OSM
    bench.ts                the location-accuracy measurement
    seed.ts smoke.ts warm.ts
frontend/
  index.html                the whole app; falls back to simulation if the API is down
  _e2e.html                 25 browser assertions, repeatable against the live server
  _shot.html                screenshot driver (#trace, #road, #accuracy)
telegram/
  listener.py               road reports in, live or replayed
  samples.jsonl             recorded dialect messages
```

## Before the demo

- [ ] `npm run seed` then `npm run smoke` — expect 22/22
- [ ] Open `http://localhost:4000/_e2e.html` — expect 25/25
- [ ] `npm run warm` if you have an API key, so the cache is committed
- [ ] Do not call Nominatim live; it rate-limits at 1 req/sec and will block the venue IP
- [ ] Overpass is only needed by `npm run osm` and `npm run checkpoints`. Both write
      committed files, so the demo machine never talks to it.

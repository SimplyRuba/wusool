# 05 — Wusool: what is built, what is left
### Paste-ready status · updated after the real map data landed and the repo went up

Supersedes the status section of `04-STATUS-AND-DESIGN-BRIEF.md`. That file is still the
authority on **design**; this one is the authority on **state and plan**.

---

## 0 · One paragraph

**Wusool (وصول)** turns free-text colloquial Palestinian addresses ("قرب المسجد", "خلف
السينما القديمة") into verified GPS locations, learns from every completed delivery, ingests
community road reports to route drivers around live checkpoint closures, and prices shipping
by how trustworthy an address is. Hackathon judging: location accuracy 30%, innovation 20%,
applicability in Palestine 15%, AI/data quality 15%, UX 10%, scalability 5%, prototype 5%.

---

## 1 · Status at a glance

| Piece | State | Where |
|---|---|---|
| Backend API | **Done** — 22/22 smoke assertions, 0 type errors | `backend/` |
| Shared API contract | **Done** | `shared/contract.ts` |
| Frontend, wired to the backend | **Done** — 25/25 browser assertions | `frontend/index.html` |
| Served from one origin, no internet | **Done** — Express serves the app | `http://localhost:4000` |
| Road-post simulator (paste a Telegram message) | **Done** | dispatch → Learning tab |
| OSM landmark bulk seed | **Done** — 2,753 entities from a live Overpass pull | `npm run osm` |
| Checkpoint coordinates verified | **Done** — 6 of 8 were wrong, one by 2.7 km | `npm run checkpoints` |
| Measured location accuracy | **Done** — 1270 m → 87 m → 9 m | `npm run bench` |
| Telegram listener | **Done** — live mode + replay mode | `telegram/listener.py` |
| Code shared with the team | **Done** — private GitHub repo | see §1b |
| Real React app (Vite + Leaflet) | **Not needed** — Option A executed | — |
| LLM cache warmed | **Blocked** — needs an `ANTHROPIC_API_KEY` | not a blocker, see §7 |
| Slides / pitch rehearsal | **Not done** | — |

**Size:** 2,948 lines of TypeScript, 3,256 lines of frontend, 187 lines of Python,
46 tracked files.

---

## 1b · Where the code lives

```
https://github.com/SimplyRuba/wusool        (private)
```

```bash
git clone https://github.com/SimplyRuba/wusool.git
cd wusool/backend && npm install && npm run seed && npm run dev
# open http://localhost:4000
```

No API key, no build step, no native compiles, and no internet needed after the clone.
The repo carries the committed OSM landmark extract, so a fresh clone runs the full demo
offline. `.env`, the SQLite database and `node_modules` are gitignored — the database is
rebuilt by `npm run seed` in a couple of seconds.

The specs and these status docs are in `docs/`.

---

## 2 · How to run it

```bash
cd backend
npm install                              # ~7s, no native builds
npm run seed                             # 8 checkpoints, 2753 landmarks, 294 deliveries
npm run dev                              # http://localhost:4000  <- API *and* UI
npm run smoke                            # 22 assertions, in another terminal
```

Then open `http://localhost:4000/_e2e.html` for the 25 browser assertions.

```bash
npm run osm                              # re-pull landmarks from OpenStreetMap
npm run checkpoints -- --fix             # re-check checkpoint coordinates against OSM
DB_PATH=/tmp/bench.db npm run seed       # measure location accuracy, on a scratch DB
DB_PATH=/tmp/bench.db npm run bench      #   never the demo one
npm run warm                             # bake the LLM cache (needs a key)

cd ../telegram && python3 listener.py --replay --delay 3    # feed road reports in
```

**`npm run seed` wipes and rebuilds the database.** That is by design, but if anyone pins
buildings while rehearsing, re-seeding resets that learning. Worth knowing before a run-through.

---

## 3 · What the product does (built and working)

**Customer — a 4-step flow, one idea per screen**
1. `وين نوصّلك؟` — type or speak the address, pick a demo scenario, see the cart
2. `هذا اللي فهمناه` — coloured entity tags + a live engine trace + the structured JSON
3. `هل هذا هو مبناكم بالضبط؟` — a large satellite map, one question, one tap
4. `سعرك، ومن وين إجا` — trust gauge, the 7 evidence factors, price, delivery options

**Driver** — phone mock with route, offline mode, checkpoint reporting, first-delivery
doorway capture, zero-call completion. **Dispatch** — three tabs: Overview (KPIs + live
fleet map), Learning (ghost-landmark feed, road-post simulator, address DB), Impact
(measured accuracy panel + charts).

Nothing on those screens is scripted. The engine trace streams the server's real
`explain[]`; the entity tags come from the server's parse; the confidence is computed from
how tightly the entities constrain a point; the KPIs are SQL over real rows. Confirming the
building on step 3 creates the order and posts the pin, which is the write that positions
the building entity — so the neighbour effect that follows is *caused* by that tap, live.

**The simulation is still there as a fallback.** On boot the app probes `/api/health`.
Live backend → a green "متصل بالخادم" pill and every screen reads real data. Server killed
mid-demo → it silently drops back to the in-browser simulation and keeps going. The pill
always tells the truth about which one is running.

Business layer: **Address Trust Score** (7 factors) → **dynamic pricing** ₪20 → ₪17 → ₪15 →
₪14, plus **Dukkan pickup** (₪10), **Neighbour Split** (−40%), and **COD gated by trust**.

---

## 4 · What the backend does

Node 22+ / TypeScript / Express / SQLite (`node:sqlite`, no native build; Node strips the
types natively, so there is no build step at all).

### It runs with no API key and no internet
`ANTHROPIC_API_KEY` is **optional**. Without it a rule-based Arabic engine handles
extraction and the whole cascade still works. With it, `claude-sonnet-5` parses first with
structured outputs and the rule engine backs it up on any failure. This is a product
requirement, not a safety net — weak connectivity is normal in Area C and at checkpoints.
`npm run warm` commits an LLM cache so a warmed repo demos with the wifi off.

### The resolution cascade — cheapest knowledge first
| Tier | Question | Confidence |
|---|---|---|
| 1 | Has *this person* used *this address* before? | 0.98 |
| 2 | **Has anyone pinned this building before?** (neighbour effect) | entity + 0.15 |
| 3 | Can we triangulate from the landmarks named? | 0.55 / 0.70 / 0.80 |
| 4 | Cold — city centroid, ask for one pin | 0.20 |

`> 0.75` resolved · `0.50–0.75` estimated · `< 0.50` ask for a pin. Every answer carries a
plain-language `explain[]` array, so the dashboard can show *why* it believes something.

### The four demo paths, verified end to end
- **A** cold address → tier 3, 0.70, estimated → pin link issued
- **B** different wording + different phone → **tier 2, 0.80, resolved**, badge reads
  "already on the map from 1 prior delivery"
- **C** `الوضع عالكونتينر مسكر بالكامل` → matched حاجز الكونتينر → closed, 0 min stale
- **D** 6 driver tasks, OSRM route 1380 m, alternatives scored by checkpoint penalties

---

## 5 · Bugs found and fixed

### 5a · In the original specs — several were demo-killers

1. **The neighbour-effect demo could never fire.** Tier 2 needs a building entity *with
   coordinates*; the pin handler attached the entity but never positioned it, and the only
   rule that set coordinates needed 3 confirmations plus a completed delivery. Fixed: a pin
   or delivery positions the building at 0.65, so tier 2 yields 0.80.
2. **The flagship demo address sat exactly on the threshold.** Two landmarks = 0.70 + 0.05 =
   0.75, and `>= 0.75` resolved it outright, so no pin link was ever issued and the "pin
   once" demo step had nothing to tap. Now a strict `>`.
3. **Contract mismatch** between the driver-tasks endpoint and the TypeScript type.
4. **Timezone.** SQLite writes UTC, Palestine runs UTC+3 — a local-time comparison made every
   road report look 180 minutes old and silently marked every checkpoint "assumed". Now
   epoch-ms throughout.
5. **Model.** `claude-sonnet-4-6` → `claude-sonnet-5` for structured outputs (guaranteed
   schema-valid JSON instead of "please return only JSON"), `temperature` removed (rejected
   on Sonnet 5), thinking explicitly disabled (adaptive is on by default and adds seconds).

### 5b · Found while building on 28 hand-written landmarks

6. **Entity resolution merged different buildings.** Levenshtein ≤2 across a whole phrase
   matched `عمارة زيدان` to `عمارة حمدان` — two edits inside the family name, two different
   buildings, one merged entity, a driver sent to the wrong address. Fixed by stripping
   generic stems (`عمارة` means "building" and carries no identity) and comparing only the
   distinguishing tokens. `عمارة زيدان` still matches `برج زيدان`, which is correct.
7. **New entities inherited the city centre** as their position, so every unknown building
   "resolved" to downtown with false confidence.
8. **Addresses with no punctuation failed** — `البيرة عمارة زيدان جنب سوبرماركت الامل ط٢`,
   which is how people actually type. The parser now splits on relation words and place
   stems without breaking compounds like `سوبر ماركت`.

### 5c · Found when the data got real — the important ones

Everything above ran against 28 hand-written landmarks. Replacing them with the real
OpenStreetMap extract (**2,753 entities, 4,766 aliases**, Ramallah out to Birzeit and Jifna)
broke the matcher in four ways that 28 landmarks could never have exposed. All four are the
same shape: *precision that was free at small scale has to be earned at real scale.*

9. **A shop matched a different shop 6 km away.** Stripping generic stems left seven
   Ramallah places sharing the token "الامل" — a supermarket, two pharmacies, a
   kindergarten, a petrol station. The stem says what KIND of place it is, and that is
   enough to rule a match out. "صيدلية الأمل" is no longer "سوبرماركت الأمل"; "عمارة زيدان"
   still matches "برج زيدان".
10. **An exact name match in the wrong town beat a fuzzy match in the right one.** A single
    exact alias hit was returned with no distance check at all.
11. **Chain names were guessed silently.** "بنك فلسطين" is six branches over 8.7 km; 127
    alias strings point at places >500 m apart. The engine now picks the nearest, counts the
    rivals it could not rule out, subtracts 0.12 and says so in `explain[]` — which drops
    that order into the band where we ask for one tap.
    **Saying "I know the name but not which one" is the correct answer.**
12. **"عبد الناصر" never matched "عبدالناصر"** — 0.33 token overlap, judged different
    mosques. Normalisation now joins عبد / أبو / ابن / بن to the word after it.

13. **Checkpoint coordinates were wrong.** Six of the eight, one (عطارة) by 2.7 km. A
    checkpoint in the wrong place is worse than a missing one: the router avoids a closure
    3 km from the real road, sends the driver through the actual one, and reports success.
    `npm run checkpoints` now verifies them against OSM by proximity, and refuses to "correct"
    anything it cannot confirm.
14. **A road report saying there was NO traffic was read as traffic.** "مافي زحمة" matched
    the congestion word and won — the worst possible failure, because it routes drivers away
    from the one clear road. The road parser now handles negation and covers
    سكر / فتح / بطيء / تفتيش / حاجز طيار, which it ignored entirely. Hand-checked on 14 real
    dialect posts: 14/14.

---

## 6 · Location accuracy is a measured number, not a claim

Accuracy is 30% of the score and it was the one thing argued from a screenshot.
`npm run bench` un-learns every building, resolves from the text alone, then pins each
building once and resolves a **differently worded** address from a **different phone**.
Ground truth is the building's known position. Every simulated pin carries 12 m of GPS
error, so the warm number is not 0 by construction.

| | median | p90 | within 100 m |
|---|---|---|---|
| A normal mapping app (city centroid) | **1270 m** | 2805 m | 4% |
| Wusool, from the text alone | **87 m** | 1376 m | 56% |
| Wusool, after ONE customer pin | **9 m** | 12 m | 100% |

27 buildings, on a scratch database that never touches the demo one. 11 buildings were
excluded for having a duplicate generated name and 2 for having only one phrasing — the
exclusions are printed, not silent. This is Gemini's split-screen accuracy comparison,
expressed as a number instead of a screenshot, and it is on the dashboard Impact tab, read
from `seed/accuracy.json`.

The middle row is the honest one to lead with: **87 m from nothing but a sentence a person
typed**, where a mapping app gives you the city.

---

## 6b · Verification — what is actually checked

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run smoke` — backend, four demo paths | **22 / 22** |
| `_e2e.html` — real browser against the live server | **25 / 25** |
| Same e2e, run three times consecutively | 25/25 each time |
| Arabic place-name matcher, hand-built cases | 11 / 11 |
| Road-post parser, real dialect posts | 14 / 14 |

The e2e suite is repeatable by design: it picks its own customer phone number and finds a
building the graph has never seen, so the cold → pin → neighbour path is exercised on every
run rather than once per seed.

---

## 7 · What is left

### ~~P0 · Connect the two halves~~ — **DONE** (§3)
### ~~P1 · Make the data real~~ — **DONE** (§5c)
### ~~P2 · Road intelligence input~~ — **DONE** (§5c)

### Still open, in order of how much they matter

1. **زعترة's coordinate is unverified.** No OSM checkpoint feature exists there, so it stays
   flagged rather than quietly "corrected". Someone who knows the junction should confirm
   **32.11200, 35.27600** by eye. ~2 minutes, and it is the only unverified coordinate left.
2. **`npm run warm` needs an `ANTHROPIC_API_KEY`.** Without one the rule engine runs the
   entire demo, so this is an enhancement rather than a blocker. With one, the LLM path
   handles messier input than the rules do, and the cache makes it work with the wifi off.
3. **Pitch rehearsal.** The 3-minute script draft is in `03-INTEGRATION §7`; it now needs to
   be run against the real system, since the numbers changed.
4. **A native Arabic review pass** on the colloquial headlines.

### Stretch — only if everything above is done
- Cadastral join to GeoMOLG / Ramallah GIS (the `official` field already exists in the
  contract and is currently null)
- Dukkan pickup network as a real backend feature rather than a UI option

---

## 8 · Decisions

1. ~~Option A or B~~ — **decided: Option A, and shipped.** The prototype was wired to the
   backend rather than rewritten in React/Vite.
2. ~~Which single moment does the demo build toward?~~ — **decided: the tier-2 neighbour
   badge is the money shot; the road post is the supporting act.** Both are live, so
   sequencing is a rehearsal question, not a build question.
3. ~~How do we demonstrate the 30% accuracy criterion?~~ — **decided: measure it.** §6.
4. **Still open — is dynamic pricing demoed live or left on a slide?** The specs put pricing
   tiers in "slides only", but it is fully working and it is the feature that most directly
   shows business value. Demoing it costs nothing.

---

## 9 · Constraints for anyone proposing changes

- **Light mode only.** No dark mode. Do not propose one.
- **Keep the step/tab structure.** One idea per screen. An earlier version crammed 12 cards
  onto each of 3 dense pages and it was rejected.
- **Keep the type large.** 16px Latin / 17px Arabic body, 34px headlines. No 11–12px text.
- **Monospace only for machine output** (engine trace, JSON, coordinates). Never for prices.
- **Design system:** background `#f5f7fb`, white cards, indigo→violet brand gradient
  `#5a86ff → #3961fb → #6d28d9`, Plus Jakarta Sans + Tajawal, soft layered shadows, radii
  18–30px, aurora ambience. Full detail in `04-STATUS-AND-DESIGN-BRIEF.md §3`.
- **The product is Wusool (وصول)**, not WASEL. The teal/IBM Plex direction in
  `02-FRONTEND-SPEC.md` is superseded.
- **Do not add a dependency that needs a native build.** `npm install` must not be able to
  fail on a toolchain the night before the demo. That is why `node:sqlite` replaced
  `better-sqlite3`.
- **Nothing on stage may require the internet.** Overpass is used by `npm run osm` and
  `npm run checkpoints` only; both write committed files.

---

## 10 · Questions for Gemini

Answered since the last version, and no longer open: Option A vs the React rewrite (A,
shipped); which moment is the money shot (the neighbour badge); and how to demonstrate the
accuracy criterion (measure it — §6). What is still worth a second opinion:

1. **The accuracy table in §6 is the strongest asset and also the most attackable.** The
   ground truth is synthetic — 40 generated buildings anchored near real OSM landmarks. Is
   that fatal to the claim, or defensible if stated plainly? What is the cheapest way to get
   even 15–20 *real* address/coordinate pairs to re-run it against?
2. **"87 m from the text alone" vs "9 m after one pin" — which should lead the pitch?** The
   first is the more surprising number; the second is the product's actual promise.
3. **Tier 3 still falls back to a city centroid 9 times in 27 (§6 cold pass, T4).** Those are
   addresses naming no landmark the graph knows. Is it better to show that honestly as
   "asks for one tap", or to invest the remaining time in widening landmark coverage?
4. **What is the most likely hostile question from a judge, and what should the answer be?**
   Prepared: gaming the points system, privacy of phone data, wrong-neighbour pins, why
   Google will not just do this, offline areas, and now — "your accuracy benchmark is
   measured against your own synthetic data".
5. **Anything in the business layer** — dynamic pricing, Dukkan hubs, neighbour split, COD
   tiers — that a judge from a Palestinian delivery company would immediately poke a hole in?

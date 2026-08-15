# 05 — Wusool: what is built, what is left
### Paste-ready status · updated after the frontend and backend were connected

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
| Interactive prototype (3 roles) | **Done** — redesigned, light mode, 4-step flow | Claude artifact (private link, Ruba's account only) |
| Backend API | **Done** — 23/23 e2e tests, 0 type errors | `~/wusool/backend` |
| Shared API contract | **Done** | `~/wusool/shared/contract.ts` |
| Frontend wired to backend | **DONE** — 18/18 browser e2e tests | `~/wusool/frontend` |
| Road-post simulator (paste a Telegram message) | **DONE** — was missing entirely | dispatch → Learning tab |
| Real React app (Vite + Leaflet) | **Not needed** — Option A executed, see §5 | — |
| OSM landmark bulk seed | **DONE** — 2,753 entities from a live Overpass pull | `npm run osm` |
| Checkpoint coordinates verified | **DONE** — 6 of 8 were wrong, one by 2.7 km | `npm run checkpoints` |
| Measured location accuracy | **DONE** — 1270 m → 87 m → 9 m | `npm run bench` |
| Telegram listener | **DONE** — live mode + replay mode | `telegram/listener.py` |
| Slides / pitch | **NOT DONE** | — |

---

## 2 · What the prototype does (built and working)

A single self-contained HTML file. No backend, no build. Used for the stage demo.

**Customer — a 4-step flow, one idea per screen**
1. `وين نوصّلك؟` — type or speak the address, pick a demo scenario, see the cart
2. `هذا اللي فهمناه` — coloured entity tags + a live engine trace + the structured JSON
3. `هل هذا هو مبناكم بالضبط؟` — a large satellite map, one question, one tap
4. `سعرك، ومن وين إجا` — trust gauge, the 7 evidence factors, price, delivery options

**Driver** — phone mock with route, offline mode, checkpoint reporting, first-delivery
doorway capture, zero-call completion. **Dispatch** — three tabs: Overview (KPIs + live
fleet map), Learning (ghost-landmark feed + address DB), Impact (charts).

Genuinely working, not scripted: the address parser really parses arbitrary typed input;
confidence is computed from how tightly the entities constrain a point (including a −24
penalty for unplanned camp fabric); the maps are procedurally rendered on canvas; the three
roles are wired to each other (a driver's checkpoint report shows up in dispatch).

Business layer: **Address Trust Score** (7 factors) → **dynamic pricing** ₪20 → ₪17 → ₪15 →
₪14, plus **Dukkan pickup** (₪10), **Neighbour Split** (−40%), and **COD gated by trust**.

---

## 3 · What the backend does (built and working)

Node 20+ / TypeScript / Express / SQLite. **2,022 lines. 23/23 end-to-end tests pass.**

```bash
cd ~/wusool/backend
npm install     # ~7s, no native builds
npm run seed    # 8 checkpoints, 28 landmarks, 294 synthetic deliveries
npm run dev     # http://localhost:4000
npm run smoke   # 23 assertions across the four demo paths
```

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
- **D** 5 driver tasks, OSRM route 1495 m, 1 rejected alternative named by its closure

---

## 4 · Bugs found and fixed (worth knowing — several were demo-killers)

**In the original specs:**
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

**Found while building — one is serious:**
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

---

## 4b · Option A is done — the two halves are connected

Gemini's call was taken. The prototype now talks to the real backend, and the whole thing
runs from **one URL with no internet**:

```bash
cd ~/wusool/backend && npm install && npm run seed && npm run dev
# open http://localhost:4000
```

- **The published Claude artifact could never have done this.** Artifacts run under a CSP
  that blocks every external host, so a hosted page cannot call `localhost`. The app is
  therefore served by Express itself — same origin, no CORS, no mixed content, no internet.
- **The simulation is still the fallback.** On boot the app probes `/api/health`. Live
  backend → a green "متصل بالخادم" pill and every screen reads real data. Server down or
  killed mid-demo → it silently drops back to the in-browser simulation and keeps going.
  The pill always tells the truth about which one is running.
- **The engine trace is now real.** Step 2 streams the server's actual `explain[]`, the
  entity graph matches with their IDs and confidences (`#69 "عمارة زيدان" [learned conf 0.65]`),
  the tier and the geocode. Nothing on that screen is scripted any more.
- **The pin writes to the graph.** Confirming the building on step 3 creates the order and
  posts the pin, which is what positions the building entity — so the neighbour effect that
  follows is caused by that tap, live.
- **New: the road-post simulator** (spec `02-FRONTEND §Route 4.3`, previously unbuilt).
  Paste a real dialect Telegram message in dispatch → Learning; the same parser that reads
  addresses matches the checkpoint, flips it red, and updates the incident board.

Verified in a real browser against the real server and database — **18/18**:
resolve → tier 3 @ 0.70 → order → pin → **neighbour resolves at tier 2 @ 0.80, learned_from=1**
→ dialect road post closes حاجز الكونتينر → driver manifest loads 6 real tasks → KPIs read
84.8% auto-resolution from 295 verified addresses.

---

## 4c · Second pass — the data got real, and it broke things

Everything above ran against 28 hand-written landmarks. Replacing them with the
real OpenStreetMap extract (**2,753 entities, 4,766 aliases**, from Ramallah out
to Birzeit and Jifna) broke the matcher in four ways that 28 landmarks could
never have exposed. All four are the same shape: *precision that was free at
small scale has to be earned at real scale.*

1. **A shop matched a different shop 6 km away.** Stripping generic stems left
   seven Ramallah places sharing the token "الامل" — a supermarket, two
   pharmacies, a kindergarten, a petrol station. The stem says what KIND of place
   it is, and that is enough to rule a match out. "صيدلية الأمل" is no longer
   "سوبرماركت الأمل"; "عمارة زيدان" still matches "برج زيدان".
2. **An exact name match in the wrong town beat a fuzzy match in the right one.**
   A single exact hit was returned with no distance check at all.
3. **Chain names were guessed silently.** "بنك فلسطين" is six branches over
   8.7 km; 127 alias strings point at places >500 m apart. The engine now picks
   the nearest, counts the rivals it could not rule out, subtracts 0.12 and says
   so — which drops that order into the band where we ask for one tap.
   **Saying "I know the name but not which one" is the correct answer.**
4. **"عبد الناصر" never matched "عبدالناصر"** — 0.33 token overlap, judged
   different mosques. Normalisation now joins عبد / أبو / ابن / بن.

**Checkpoint coordinates were wrong.** Six of the eight, one (عطارة) by 2.7 km.
A checkpoint in the wrong place is worse than a missing one: the router avoids a
closure 3 km from the real road, sends the driver through the actual one, and
reports success. `npm run checkpoints` now verifies them against OSM by
proximity. زعترة has no OSM feature and stays flagged rather than quietly
"corrected".

**A road report saying there was NO traffic was read as traffic.** "مافي زحمة"
matched the congestion word and won — the worst possible failure, because it
routes drivers away from the one clear road. The road parser now handles
negation and covers سكر / فتح / بطيء / تفتيش / حاجز طيار, which it ignored
entirely. Hand-checked on 14 real dialect posts: 14/14.

---

## 4d · Location accuracy is now a measured number, not a claim

Accuracy is 30% of the score and it was the one thing argued from a screenshot.
`npm run bench` un-learns every building, resolves from the text alone, then
pins each building once and resolves a **differently worded** address from a
**different phone**. Every simulated pin carries 12 m of GPS error, so the warm
number is not 0 by construction.

| | median | p90 | within 100 m |
|---|---|---|---|
| A normal mapping app (city centroid) | **1270 m** | 2805 m | 4% |
| Wusool, from the text alone | **87 m** | 1376 m | 56% |
| Wusool, after ONE customer pin | **9 m** | 12 m | 100% |

27 buildings, on a scratch database that never touches the demo one. This is
Gemini's split-screen accuracy comparison, expressed as a number instead of a
screenshot — and it is on the dashboard, read from `seed/accuracy.json`.

The middle row is the honest one to lead with: **87 m from nothing but a
sentence a person typed**, where a mapping app gives you the city.

---

## 5 · What is left — in priority order

### ~~P0 · Connect the two halves~~ — **DONE** (see §4b)

### ~~P1 · Make the data real~~ — **DONE** (see §4c)
- ~~Overpass pull~~ — 2,753 entities, committed. `npm run osm` refreshes it.
- ~~Verify the 8 checkpoint coordinates~~ — six were wrong; `npm run checkpoints` now
  checks them against OSM. **زعترة still has no OSM feature and stays flagged** —
  someone who knows the junction should confirm 32.11200, 35.27600 by eye.
- **`npm run warm` still needs an API key.** Without one the rule engine runs the whole
  demo, so this is an enhancement, not a blocker.

### ~~P2 · Road intelligence input~~ — **DONE** (see §4c)
- `telegram/listener.py` — live Telethon mode, plus a **replay mode that is the default**.
  Replay streams recorded dialect messages through the same endpoint the live listener
  uses, so the demo never waits on somebody posting at the right moment.
- Real Telegram credentials are optional and were deliberately not pursued.

### P3 · Pitch
- 3-minute demo script (draft in `03-INTEGRATION §7`) rehearsed against the real system
- Slides: SDK embed snippet, flywheel diagram (already drawn in
  `smart-addressing-system-diagrams.html`), pricing tiers, scalability

### Stretch — only if everything above is done
- Cadastral join to GeoMOLG / Ramallah GIS (the `official` field already exists in the
  contract and is currently null)
- Dukkan pickup network as a real backend feature rather than a UI option

---

## 6 · Decisions the team needs to make

1. ~~Option A or B in P0~~ — **decided: Option A, and shipped.** See §4b.
2. **Is dynamic pricing demoed live or left on a slide?** The specs put pricing tiers in
   "slides only", but it is fully working in the prototype and it is the feature that most
   directly shows business value. Demoing it costs nothing.
3. ~~Which single moment does the demo build toward?~~ — **decided: the tier-2 neighbour
   badge is the money shot; the road post is the supporting act.** Both are now live, so
   the sequencing is a rehearsal question, not a build question.
4. **Does the Arabic copy need a native review pass?** The headlines are deliberately
   colloquial (`وين نوصّلك؟`, `سعرك، ومن وين إجا`).

---

## 7 · Constraints for anyone proposing changes

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

---

## 8 · Specific questions for Gemini

1. Given ~2 days of work left, is Option A the right call in §5-P0, or is there a reason to
   pay for the React rewrite?
2. Which of the two candidate "money shot" moments in §6.3 lands harder with judges, and how
   would you sequence the 3 minutes around it?
3. The judging rubric weights **location accuracy at 30%** — what is the most credible way to
   *demonstrate* accuracy live, beyond showing a confidence number? Is there a comparison
   against Google Maps we could stage honestly?
4. What is the most likely hostile question from a judge, and what should the answer be?
   (Current prepared answers: gaming the points system, privacy of phone data, wrong-neighbour
   pins, why Google will not just do this, and offline areas.)
5. Anything in the business layer — dynamic pricing, Dukkan hubs, neighbour split, COD tiers —
   that a judge from a Palestinian delivery company would immediately poke a hole in?

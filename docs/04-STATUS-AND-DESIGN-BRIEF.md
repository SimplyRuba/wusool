# 04 — Status & Design Brief
### Hand this to Gemini (or any collaborator) to get design help without losing context

---

## 1. What the project is

Hackathon challenge: **Palestine has no standardised addressing.** People navigate by landmarks
("near the mosque", "behind the old cinema", "after the second circle"). Delivery drivers make
multiple phone calls per drop, fuel and time are wasted, and because most orders are cash-on-delivery,
a failed delivery is a direct financial loss to the merchant.

We are building **Wusool (وصول)** — a platform that turns free-text colloquial Palestinian addresses
into verified GPS locations, learns from every delivery, and prices shipping according to how
trustworthy the address is.

Judging weights: location accuracy 30% · innovation 20% · applicability in Palestine 15% ·
AI/data quality 15% · UX 10% · scalability 5% · prototype quality 5%.

---

## 2. What exists right now

**A working interactive prototype** — a single self-contained HTML file, no backend, no build step.
It runs entirely in the browser and is used for the stage demo. Three roles:

| Role | What it shows |
|---|---|
| **Customer** | A 4-step checkout flow: write/speak address → see what the AI extracted → confirm the building on a satellite map → get your price |
| **Driver** | A phone mock: route, offline mode, checkpoint reporting, "first-delivery doorway capture", zero-call completion |
| **Dispatch** | Three tabs: Overview (KPIs + live fleet map), Learning (ghost-landmark feed + address DB), Impact (charts) |

### What is genuinely working (not faked)

- **The address parser really parses.** A rule-based Arabic/English entity engine over a Palestinian
  lexicon (18 cities and camps, spatial prepositions قرب/خلف/فوق/مقابل, building keywords عمارة/بناية,
  floor and door regexes). Type any messy address and it extracts city / landmark / relation /
  building / micro-location. It is *not* a script that replays a fixed answer.
- **Confidence is computed**, not hardcoded — from how tightly the entities constrain a point,
  including a **−24 penalty for unplanned refugee-camp fabric**. Four demo scenarios land at
  37% / 65% / 93% / 70% because of the actual arithmetic.
- **The maps are procedurally rendered on canvas** — seeded street grids, limestone rooftops with
  sun-angle shadows, water tanks, olive groves, camp-vs-urban density. Satellite/road toggle, pan,
  zoom, and clicking the correct building all work. Doorway "photos" are drawn the same way.
- **The three modules are wired together.** A driver's checkpoint report appears in the dispatch
  incident board. Capturing a doorway photo writes it to the database so later stops see it.
  Confirming an order pushes a row into the dispatch address table.

### The business layer (this is the differentiator)

- **Address Trust Score 0–100**, built from 7 transparent evidence factors (descriptive clarity,
  known landmark, satellite pin, floor/door details, prior deliveries, doorway photo, voice note).
- **Dynamic pricing** — the market charges a flat ₪20. We charge ₪20 → ₪17 → ₪15 → ₪14 as trust rises.
  A vague camp address genuinely stays at ₪20; that is the point, not a bug.
- **Dukkan pickup network** (₪10 — collect from the corner shop), **Neighbour Split** (−40% to batch
  with a neighbour's parcel), **COD gated by trust** (low-trust addresses must prepay, protecting the merchant).
- **Ghost landmarks** — a self-healing database that learns culturally-known places Google Maps
  does not have ("the old Al-Quds cinema", "Abu Samir's vegetable shop").

---

## 3. The design system — PLEASE FOLLOW THIS

This was derived from Ruba's own GitHub projects and must not be replaced with a generic look.
Reference repos: `SimplyRuba/masrafji-sadeil-ruba-aya`, `SimplyRuba/AmanQ-Resilience-OS`, `sadeil/Sense`.

| | Value |
|---|---|
| **Mode** | **LIGHT ONLY.** No dark mode. Do not propose one. |
| **Background** | `#f5f7fb`, white card surfaces |
| **Brand** | indigo → violet gradient `linear-gradient(135deg,#5a86ff,#3961fb,#6d28d9)` |
| **Semantic** | success `#059669` · warning `#d97706` · danger `#dc2626` · info `#0284c7` |
| **Type** | Plus Jakarta Sans (Latin) · **Tajawal** (Arabic) · JetBrains Mono **only** for logs/coordinates/JSON |
| **Base size** | 16px Latin / 17px Arabic. Headlines 34px. Never 11–12px body text. |
| **Depth** | layered soft shadows, **not** hard 1px borders |
| **Radii** | generous — 18px / 24px / 30px |
| **Ambience** | aurora radial gradients + blurred floating orbs |
| **Motion** | `cubic-bezier(.22,1,.36,1)` ease-out and `cubic-bezier(.34,1.56,.64,1)` spring |
| **RTL** | Arabic-first, `dir="rtl"`, full English toggle |

### The design mistake we already fixed — do not reintroduce it

The first version crammed ~12 cards into each of 3 dense scrolling pages at 11–12px type, and used
monospace for every price and number. It read as a terminal, not a product. The fix was:

1. **Split into steps and tabs** — the customer is now a 4-step wizard, the driver has 2 tabs,
   dispatch has 3 tabs. **One idea per screen.**
2. **Raise the type scale** — 16/17px body, 34px headlines, 46px price, 44px trust score.
3. **Remove monospace from anything a customer reads.** Prices and KPIs use Plus Jakarta Sans with
   tabular numerals. Monospace survives only in the engine trace and JSON panels, where it belongs.
4. **Delete dark mode entirely.**

**If you suggest design changes, they must keep the flow split into steps and keep the type large.**

---

## 4. There is also a full backend spec (WASEL)

Separate documents `00-OVERVIEW.md` … `03-INTEGRATION-AND-DEMO.md` specify a real implementation:
Node 20 + TypeScript + Express + SQLite, an LLM address parser via the Anthropic API, Leaflet +
OpenStreetMap, OSRM routing scored against checkpoint status, and a Telegram road-report listener.

**Naming decision made: the product is Wusool (وصول), not WASEL. The design system above wins over
the teal/IBM Plex direction in `02-FRONTEND-SPEC.md`.**

### Bugs found in that spec that are still unfixed

1. **The tier-2 "neighbour effect" demo cannot fire.** Tier 2 requires a building entity *with
   coordinates*, but `onPinConfirmed` never assigns coordinates to the entity, and the only rule that
   does requires 3 confirmations plus a completed delivery. Fix: on pin confirmation, set the
   building entity's lat/lng to the pinned point with `confidence = 0.6`.
2. **Demo address 1 lands exactly on the confidence threshold.** 2 landmarks = 0.70, "+0.05 if within
   300m" = 0.75, and the threshold is `≥0.75 → resolved` — so no pin link is generated and the demo
   step that taps it breaks. Make the threshold `>0.75` or drop the bonus.
3. Contract mismatch: `/api/driver/tasks` returns `{order, resolution, route}` but the TypeScript
   contract declares `{order, route}`. `GeoJSON.LineString` also needs `@types/geojson` to compile.
4. `claude-sonnet-4-6` works, but **`claude-sonnet-5` is better and supports structured outputs**
   (guaranteed schema-valid JSON instead of "return ONLY valid JSON"). If switching: delete
   `temperature: 0` (rejected on Sonnet 5) and set `thinking: {type:"disabled"}` explicitly, because
   adaptive thinking is on by default there and would add latency to every parse on stage.
5. SQLite `datetime('now')` is UTC and Palestine is UTC+3 — if checkpoint freshness is computed
   against local time, every report reads as 180 minutes stale and all checkpoints decay to "assumed".
6. Nominatim rate-limits aggressively (1 req/sec, User-Agent required). Do not call it live during
   the demo; seed from a cached Overpass extract.

---

## 5. What we would like help with

- Layout and information hierarchy **within** the steps and tabs — is anything still too dense?
- Copywriting in Arabic — the headlines are colloquial on purpose ("وين نوصّلك؟", "سعرك، ومن وين إجا").
- The three-minute stage narrative: which single moment should the demo build toward?
- Anything in the business layer (pricing, Dukkan, neighbour split, COD tiers) that a judge would
  poke a hole in.

**Constraints: light mode only, keep the step/tab structure, keep the type large, keep the design
system in section 3.**

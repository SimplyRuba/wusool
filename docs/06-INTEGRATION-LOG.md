# 06 — Integration Log
### What was added after Laptop B's base build went up

This documents the integration work done after cloning `SimplyRuba/wusool` — merging the
best of both laptops and adding new capabilities.

---

## 0 · Decision: Laptop B is the base

Both laptops built the backend independently. After a head-to-head comparison:

| Area | Laptop A | Laptop B | Winner |
|---|---|---|---|
| DB library | `better-sqlite3` (native compile) | `node:sqlite` (built-in) | **B** |
| LLM model | claude-sonnet-4-6 | claude-sonnet-5 (structured outputs) | **B** |
| LLM fallback | Cache-only, crashes without | Rule-based Arabic engine — full offline | **B** |
| Landmark data | 40 hand-written | 2,753 real OSM, 4,766 aliases | **B** |
| Checkpoint coords | Copied from spec (6/8 wrong) | Verified against OSM | **B** |
| Entity matching | Naive Levenshtein (merges wrong buildings) | Stem-stripped, kind-aware, ambiguity penalty | **B** |
| Frontend | None | Full 4-step customer + driver + dispatch | **B** |
| Telegram | Not built | Working listener with replay mode | **B** |
| Accuracy | Eval harness with perturbation | `npm run bench` on 27 buildings | **B** |
| **P13 eval harness** | 24-case ground-truth suite | Not present | **A** |

**Decision:** B is the sole system. A's eval harness (P13) was the one feature worth porting.

---

## 1 · What was added (4 commits)

### 1a · P13 Accuracy Eval Harness
`npm run eval` — `src/seed/eval.ts`

24 ground-truth test cases with independently perturbed coordinates (zero-error results
are impossible by construction):
- **12 reworded building addresses** — same buildings from the seed but with swapped
  relation words (قرب→وراء, بجانب→مقابل), added/removed floors, misspelled landmarks.
  Ground truth = building position + 15–60m deterministic GPS noise.
- **8 landmark-only cold addresses** — single landmarks, customer lives 80–200m away.
  Ground truth = perturbed from landmark centroid.
- **4 controls** — الخليل, أريحا, سلفيت, gibberish → must return `needs_pin`.

Results:
```
hit@250m : 18/20 = 90.0%   ← PASS (≥85%)
controls : 100%              ← PASS (=100%)
mean err : 116m
```

`GET /api/dashboard/eval` — serves the last `eval-report.json` (404 if never run).

### 1b · Cadastral Enrichment from Ramallah Municipality GIS
`src/services/cadastral.ts`

Queries the municipality's public ArcGIS REST layers after every resolution:
- **Parcels layer** → block name (حوض), quarter name, parcel number, city
- **Buildings layer** → neighborhood (حي), formal street address, postcode

The GIS uses EPSG:28191 (Palestine 1923 Grid), so coordinates are projected via
ArcGIS Geometry Service before querying. Both layers queried in parallel.

Example — resolving "قرب دوار المنارة" now returns:
```json
{
  "official": {
    "neighborhood": "حي قدورة",
    "parcel": "1"
  },
  "explain": [
    "tier 3: triangulated from 1 landmark (دوار المنارة)",
    "cadastral: حي قدورة / 17-قدوره — 16 شارع خليل صلاح"
  ]
}
```

This bridges colloquial addresses ("قرب المسجد") to the municipality's formal system
("حي قدورة, حوض المدينة, 16 شارع خليل صلاح, رمز بريدي 6008960").

`GET /api/dashboard/cadastral?lat=31.9033&lng=35.2058` — standalone lookup endpoint.

Graceful degradation: returns `null` when offline or outside Ramallah coverage.

### 1c · Gemini 3.5 Flash as Free LLM Backend
`src/services/llm.ts` — rewired to support both providers

The original code used Anthropic (paid). Now Gemini is the default when
`GEMINI_API_KEY` is set — **completely free** (500 req/day, more than enough for a
hackathon).

```
GEMINI_API_KEY=...  → Gemini 3.5 Flash (free)
ANTHROPIC_API_KEY=... → Claude Sonnet 5 (paid)
neither → rule engine (still works, just shows engine: rules)
```

**Output normalization:** Gemini returns slightly different JSON shapes than Anthropic
(landmarks as strings instead of `{name,type}` objects; `name`/`type` instead of
`place`/`kind` for road posts). The parser normalizes both to the contract types.

`npm run warm` bakes demo addresses into `cache/llm/` — the demo then runs offline
forever with `engine: llm-cache` displayed on every resolution.

### 1d · LLM Cache Warmed
The committed cache includes 5 demo addresses parsed by Gemini 3.5 Flash. The server
now starts with:
```
parser → Gemini 3.5 Flash (free) + rule fallback
```

And demo resolutions show `engine: llm-cache` instead of `engine: rules`.

---

## 2 · Current state after integration

| Piece | State | Verified |
|---|---|---|
| Backend API | **Done** | 22/22 smoke |
| Resolution cascade (4 tiers) | **Done** | All tiers working |
| Neighbor effect (money shot) | **Done** | Pin → tier 2 live |
| LLM parser (Gemini 3.5 Flash) | **Done** | Free, cached, offline-capable |
| Rule-based Arabic parser | **Done** | Fallback, no key needed |
| 2,753 real OSM landmarks | **Done** | Live Overpass pull |
| 8 checkpoints (6 corrected) | **Done** | Verified against OSM |
| Road post parser (negation-aware) | **Done** | 14/14 real posts |
| Frontend (customer + driver + dispatch) | **Done** | 25/25 browser e2e |
| Telegram listener (replay mode) | **Done** | Works offline |
| Accuracy measured (1270→87→9m) | **Done** | `npm run bench` |
| P13 eval harness (24 cases) | **Done** | 90% hit@250m, 100% controls |
| Cadastral enrichment (municipality GIS) | **Done** | Live queries, graceful offline |
| LLM cache warmed | **Done** | Demo runs offline with engine: llm-cache |
| Served from one origin, offline | **Done** | http://localhost:4000 |

## 3 · How to run

```bash
cd backend
npm install                    # ~7s, no native builds
npm run seed                   # 8 checkpoints, 2753 landmarks, 294 deliveries
npm run dev                    # http://localhost:4000 — API and UI

# In another terminal:
npm run smoke                  # 22 backend assertions
npm run eval                   # 24-case accuracy harness
```

The `.env` file is already configured with a Gemini API key. To re-warm the cache:
```bash
npm run warm                   # caches demo addresses via Gemini
```

## 4 · What's left

| Item | Priority | Time |
|---|---|---|
| Slides / pitch deck | **P0** — only fully unbuilt deliverable | 1–2 hours |
| Pitch rehearsal (3-min script) | **P1** | 30 min |
| Real-pairs mini-bench (15–20 real buildings) | **P2** — makes accuracy unchallengeable | 30 min with team |
| زعترة checkpoint verification | **P3** | 2 min if someone knows the junction |
| Arabic review pass on colloquial headlines | **P4** | 15 min with native speaker |

## 5 · Data sources now integrated

| Source | What it gives | Status |
|---|---|---|
| OpenStreetMap (Overpass) | 2,753 landmarks with GPS | Seeded in DB |
| Ramallah Municipality GIS (ArcGIS) | Neighborhoods, parcels, streets, postcodes | Live queries on every resolution |
| Wusool's own learning | Pinned buildings, verified deliveries | Growing with every use |
| Community road reports | Checkpoint closures, congestion | Telegram replay + API ingestion |
| Gemini 3.5 Flash | Dialect Arabic address/road parsing | Free, cached for offline |

---

*Updated: 2026-08-15*

# WASEL (واصل) — Smart Addressing & Delivery Platform
## Master Overview — read this before any other spec

Working name: **WASEL** ("arriving/delivered"). Rename freely; use `wasel` as the code namespace.

---

## 1. What we are building (one paragraph)

A platform that converts free-text Palestinian descriptive addresses (عناوين وصفية) into verified GPS locations, learns from every delivery (the neighbor effect), ingests community road/checkpoint reports (Telegram/WhatsApp), routes drivers around closures, and packages all of it as an embeddable B2B service (SDK screens + API + dashboard). The demo tells this story end-to-end with ONE web app + ONE backend.

## 2. Judging weights that drive every decision

| Criterion | Weight | What we build for it |
|---|---|---|
| Location accuracy | 30% | Resolution cascade + live confidence + learning demo moment |
| Innovation | 20% | Neighbor effect, landmark discovery, road-post NLP, incentive logic |
| Applicability in Palestine | 15% | Checkpoint routing, dialect handling, COD economics, municipal data |
| AI & data quality | 15% | LLM extraction shown live, verification engine, anomaly logic |
| UX | 10% | Clean RTL Arabic UI, zero-friction customer flow |
| Scalability | 5% | SDK/tokenization story (slides, not code) |
| Presentation/prototype | 5% | Demo script in 03-INTEGRATION |

**Rule: if a task does not move one of the top four criteria, it is a slide, not code.**

## 3. Tech stack (final — agents do not deviate)

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js 20 + TypeScript + Express | One language across stack; fastest agent iteration |
| DB | SQLite via better-sqlite3 | Zero setup, file-based, sync API, good enough for demo |
| LLM | Anthropic API (claude-sonnet-4-6), JSON-mode prompts | Dialect Arabic handling zero-shot |
| Geo math | Plain haversine + point-in-radius in TS | No PostGIS needed at this scale |
| Maps (frontend) | Leaflet + OpenStreetMap tiles | Free, no API key, no billing risk |
| Geocoding seed | OSM Overpass API (pre-downloaded to JSON) + Nominatim fallback | Free |
| Routing | OSRM public server (router.project-osrm.org) with `alternatives=true` | Free; we score alternatives against checkpoint status |
| Frontend | Vite + React 18 + TypeScript + Tailwind | Fast build, no SSR complexity |
| Telegram | Telethon (small Python sidecar) OR simulated feed endpoint | Real if channel access works in 30 min, else simulator — both specced |
| Deploy (demo) | Everything runs on one laptop: `npm run dev` x2 + optional python listener | No cloud dependency during judging |

## 4. Repository structure

```
wasel/
├── backend/
│   ├── src/
│   │   ├── index.ts             # Express bootstrap, CORS, routes
│   │   ├── db/schema.sql        # All tables (see 01-BACKEND)
│   │   ├── db/index.ts          # better-sqlite3 init + helpers
│   │   ├── services/
│   │   │   ├── llm.ts           # Anthropic calls, prompt templates, response cache
│   │   │   ├── parser.ts        # extractAddress(), extractRoadPost()
│   │   │   ├── entities.ts      # entity resolution / normalization / merging
│   │   │   ├── cascade.ts       # 4-tier resolution + confidence
│   │   │   ├── verify.ts        # corroboration, anomaly checks, decay
│   │   │   ├── roads.ts         # checkpoint status, freshness decay
│   │   │   ├── routing.ts       # OSRM alternatives + penalty scoring
│   │   │   ├── points.ts        # incentive ledger (pending→verified)
│   │   │   └── geo.ts           # haversine, clustering helpers
│   │   ├── routes/              # one file per resource (see API contract)
│   │   └── seed/
│   │       ├── landmarks.ramallah.json   # pre-fetched OSM extract
│   │       ├── checkpoints.json          # seeded checkpoint list
│   │       ├── history.generator.ts      # synthetic 300-delivery history
│   │       └── seed.ts                   # runs all seeding
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # router: / , /pin/:token , /driver , /dashboard
│   │   ├── screens/  (see 02-FRONTEND)
│   │   ├── components/
│   │   ├── lib/api.ts           # typed client matching shared contract
│   │   └── lib/types.ts         # COPY of shared contract types
│   └── package.json
├── shared/
│   └── contract.ts              # THE source of truth — API types (see 03-INTEGRATION)
├── telegram/
│   └── listener.py              # optional Telethon sidecar → POST /api/ingest/road-post
└── README.md
```

## 5. Build order (phases, not hours — agents parallelize)

1. **P0 — Contract freeze**: `shared/contract.ts` written first (already specced in 03). Nothing else starts before this exists.
2. **P1 — Parallel tracks**: Backend agent(s) build db+services+routes against contract. Frontend agent(s) build all four screens against a mock of the contract (`lib/api.ts` has a `MOCK=true` switch returning fixtures).
3. **P2 — Seeding**: landmarks JSON, checkpoints, synthetic history, demo fixtures.
4. **P3 — Integration**: flip `MOCK=false`, fix mismatches, wire map layers.
5. **P4 — Demo hardening**: LLM response cache warmed with demo addresses, offline fallback verified, demo script rehearsed.

## 6. Scope guard (print this)

**BUILD**: resolve pipeline, cascade + confidence, pin confirm flow, neighbor-effect demo, checkpoint map + status decay, OSRM alternative scoring, driver screen, dashboard KPIs, demo store checkout, Telegram (real or simulated) feed, points display (UI only).

**SIMULATE**: WhatsApp ingestion (simulator posts labeled "WhatsApp"), synthetic delivery history, incentive ledger backend (static numbers OK), cadastral join (stretch: only if Ramallah GIS endpoint is open — else screenshot slide).

**SLIDES ONLY**: SDK embed snippet, tokenization/vault, multi-tenancy, pricing tiers, national dataset/GeoMOLG integration, anti-gaming detail, native apps.

**FORBIDDEN during build**: new features not in these specs, auth systems, payment, real WhatsApp API, model fine-tuning, PostGIS, docker, tests beyond smoke.

## 7. Pre-build checklist (before agents start)

- [ ] Anthropic API key with credit, exported as `ANTHROPIC_API_KEY`
- [ ] F12 network test on Ramallah GIS viewer → record FeatureServer URLs if public (stretch goal input)
- [ ] Pick 2–3 public Telegram road channels; test Telethon login OR decide simulator-only
- [ ] Run the Overpass query in 01-BACKEND §7 once; save result to `seed/landmarks.ramallah.json`
- [ ] Confirm venue internet; if risky, warm the LLM cache (03-INTEGRATION §6) so demo runs offline

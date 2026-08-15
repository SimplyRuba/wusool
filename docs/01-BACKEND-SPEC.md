# 01 — BACKEND SPEC (Node.js + TypeScript + Express + SQLite)

Everything here is implementable without the frontend. All responses conform to `shared/contract.ts` (03-INTEGRATION §1).

---

## 1. Database schema (`db/schema.sql`)

```sql
-- Canonical resolved places (the graph nodes)
CREATE TABLE entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,            -- 'landmark' | 'building' | 'shop' | 'street' | 'area'
  canonical_name TEXT NOT NULL,  -- normalized Arabic
  lat REAL, lng REAL,
  source TEXT NOT NULL,          -- 'osm' | 'learned' | 'municipal'
  confidence REAL NOT NULL DEFAULT 0.5,   -- 0..1, evidence-weighted
  confirmations INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Name variants → entity (the entity-resolution memory)
CREATE TABLE entity_aliases (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  alias TEXT NOT NULL,           -- raw variant as seen in text (normalized form)
  UNIQUE(entity_id, alias)
);

-- Verified customer addresses (graph edges: text ↔ point ↔ person)
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY,
  phone_hash TEXT,               -- sha256(phone), nullable for anon
  raw_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  lat REAL, lng REAL,
  building_entity_id INTEGER REFERENCES entities(id),
  status TEXT NOT NULL DEFAULT 'unverified',  -- 'unverified'|'pinned'|'delivery_verified'
  verified_count INTEGER NOT NULL DEFAULT 0,
  official_neighborhood TEXT,    -- from cadastral join (stretch)
  official_parcel TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE resolutions (
  id INTEGER PRIMARY KEY,
  raw_text TEXT NOT NULL,
  phone_hash TEXT,
  parsed_json TEXT NOT NULL,     -- LLM extraction result
  tier INTEGER,                  -- 1..4 which cascade tier answered
  matched_address_id INTEGER REFERENCES addresses(id),
  matched_entity_ids TEXT,       -- JSON array
  lat REAL, lng REAL,
  confidence REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  items_json TEXT NOT NULL,
  phone TEXT NOT NULL,           -- demo only; production stores hash
  raw_address TEXT NOT NULL,
  resolution_id INTEGER REFERENCES resolutions(id),
  pin_token TEXT UNIQUE,         -- set when low confidence
  status TEXT NOT NULL DEFAULT 'created',
  -- 'created'|'awaiting_pin'|'ready'|'assigned'|'delivered'|'failed'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE checkpoints (
  id INTEGER PRIMARY KEY,
  name_ar TEXT NOT NULL, name_en TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL
);

CREATE TABLE road_events (
  id INTEGER PRIMARY KEY,
  checkpoint_id INTEGER REFERENCES checkpoints(id),
  status TEXT NOT NULL,          -- 'open'|'congested'|'closed'
  source TEXT NOT NULL,          -- 'telegram'|'whatsapp'|'driver'
  raw_text TEXT,
  reported_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE points_ledger (
  id INTEGER PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,          -- 'pin_verified'|'sparse_bonus'|'neighbor_assist'|'road_corroborated'
  state TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'verified'|'revoked'
  ref_type TEXT, ref_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
```

Arabic normalization function (used everywhere before matching): strip tashkeel; unify أ/إ/آ→ا, ة→ه, ى→ي; collapse whitespace; remove punctuation; keep digits.

## 2. LLM service (`services/llm.ts`)

- Single `callLLM(system, user): Promise<string>` with:
  - model `claude-sonnet-4-6`, max_tokens 1024, temperature 0
  - **File cache**: key = sha1(system+user) → `cache/llm/*.json`. Cache is committed after warming (offline demo insurance).
  - On network failure: return cached, else throw typed `LLMUnavailable` (routes degrade gracefully: resolve falls back to tier-1/2 only).

### Prompt A — address extraction (`parser.extractAddress`)
System prompt (verbatim, keep Arabic examples):
```
You extract structured data from Palestinian descriptive addresses written in Arabic dialect, MSA, or mixed Arabic/English. Return ONLY valid JSON, no markdown, matching:
{"city": string|null, "area": string|null, "landmarks": [{"name": string, "type": "mosque|church|pharmacy|supermarket|school|roundabout|hospital|shop|other"}], "building": string|null, "floor": string|null, "apartment": string|null, "relations": [{"subject":"target","relation":"near|next_to|behind|opposite|after|inside","object": string}], "notes": string|null}
Rules: preserve original Arabic names exactly; landmarks include mosques, shops, roundabouts (دوار), pharmacies; "عمارة/بناية X" is building; floors like "ط٣/الطابق الثالث" → "3"; do not invent fields.
```
User = raw address text.

### Prompt B — road post extraction (`parser.extractRoadPost`)
```
You extract road/checkpoint status from Palestinian community posts (Telegram/WhatsApp style, dialect Arabic). Return ONLY JSON:
{"mentions":[{"place": string, "kind":"checkpoint|road|junction", "status":"open|congested|closed|unknown", "severity":"low|medium|high|null", "alternative_route": string|null}], "is_road_related": boolean}
Vocabulary: سالك=open, أزمة/عجقة=congested, مسكر/مغلق/إغلاق=closed, حاجز=checkpoint, طيّار=flying checkpoint. If the post is not about roads, is_road_related=false.
```

## 3. Entity resolution (`services/entities.ts`)

`matchOrCreateEntity(name, type, nearLat?, nearLng?)`:
1. normalized = normalizeArabic(name)
2. Exact alias hit → return entity.
3. Fuzzy: compare against all aliases with (a) Levenshtein ≤ 2 for len>5, (b) token-set overlap ≥ 0.6. If candidate found AND (no coords given OR within 500m) → add new alias, return.
4. Else create entity `source='learned', confidence=0.3`, add alias.

**Landmark discovery rule** (run inside delivery completion): if a learned entity accumulates ≥3 confirmations whose confirmed points cluster within 120m, set `lat/lng = centroid`, `confidence = min(0.9, 0.3 + 0.2*confirmations)`.

## 4. Resolution cascade (`services/cascade.ts`)

`resolve(rawText, phone?) → Resolution`

- Parse via Prompt A. Normalize all names. Match/attach entities.
- **Tier 1 — exact**: same `phone_hash` + normalized_text similarity ≥0.85 against `addresses` with status != 'unverified' → confidence 0.98.
- **Tier 2 — building (neighbor effect)**: parsed.building matches a building entity with coords (via aliases) → confidence `min(0.95, entity.confidence + 0.15)`. Response includes `learned_from: verified_count` for the UI badge.
- **Tier 3 — landmark triangulation**: geocode each parsed landmark: (a) entity table w/ coords, (b) seed OSM JSON by name match, (c) live Nominatim (`q=<name> رام الله`, limit 3) as last resort. If ≥1 point: result = weighted centroid (weights: entity confidence, else 0.5). Confidence: 1 landmark→0.55, 2→0.7, 3+→0.8; +0.05 if all points within 300m; −0.15 if spread >800m.
- **Tier 4 — cold**: confidence 0.2, no coords (or city centroid), status `needs_pin`.
- Threshold: confidence ≥0.75 → `resolved`; 0.5–0.75 → `estimated` (driver sees flag); <0.5 → `needs_pin` (order flow generates `pin_token`).
- Always persist to `resolutions`.

## 5. Verification engine (`services/verify.ts`)

- `onPinConfirmed(order, lat, lng)`: upsert `addresses` row (status 'pinned'); attach building entity if parsed; **anomaly check**: if tier-3 estimate existed and pin is >2km away → mark resolution contradicted, entity `contradictions+1`, points stay pending with reason flagged. Else create pending points (+10, reason 'pin_verified'; +10 'sparse_bonus' if <3 verified addresses within 400m).
- `onDelivered(order, lat, lng)`: address status → 'delivery_verified', `verified_count+1`; entities on path get `confirmations+1`; landmark-discovery rule runs; pending points for this address flip to 'verified'; if tier-2 used someone else's building, credit that address's phone_hash +2 'neighbor_assist'.
- Confidence decay on contradiction: entity confidence `*= 0.6`; address with 2 contradictions returns to needs_pin next time.

## 6. Roads & routing (`services/roads.ts`, `services/routing.ts`)

- `currentStatus(checkpoint)`: take events in last 6h; weight = source_weight (driver .5, telegram .35, whatsapp .3) × freshness `exp(-ageMinutes/90)`; sum per status; winner = current status, `staleness` returned. No events → 'open' (assumed), flagged `assumed:true`.
- Ingest endpoint runs Prompt B, matches `mentions[].place` to checkpoints via alias/fuzzy (checkpoint names + aliases live in seed JSON), inserts `road_events`.
- Routing `getRoute(fromLat,fromLng,toLat,toLng)`: call OSRM `/route/v1/driving/{coords}?alternatives=true&overview=full&geometries=geojson`. For each alternative: penalty = Σ over checkpoints within 250m of geometry: closed→+3600s, congested→+900s. Pick min(duration+penalty). Return chosen + rejected alternatives + which checkpoint caused rejection (the UI tells this story).

## 7. Seeding (`seed/`)

- **Landmarks**: run once pre-build, save JSON. Overpass query (bbox = central Ramallah/Al-Bireh ≈ 31.88,35.18,31.93,35.23):
```
[out:json][timeout:60];
(nwr["amenity"~"mosque|pharmacy|hospital|school|restaurant|cafe|bank"](31.88,35.18,31.93,35.23);
 nwr["shop"](31.88,35.18,31.93,35.23);
 nwr["highway"="mini_roundabout"](31.88,35.18,31.93,35.23););
out center 600;
```
Loader inserts entities (`source='osm'`, confidence 0.7) with `name`, `name:ar`, `name:en` all as aliases.
- **Checkpoints** (`checkpoints.json`, coords approximate — verify on map before demo): قلنديا Qalandia (31.865, 35.216), الكونتينر Container (31.741, 35.262), عين سينيا/عطارة Atara (32.007, 35.196), بيت إيل DCO (31.923, 35.220), جبع Jaba (31.856, 35.246). Aliases include misspellings (كونتينر/الكونتينر/كونتاينر).
- **Synthetic history** (`history.generator.ts`): 300 deliveries over "6 months": pick 40 buildings near real landmarks, generate 2–12 orders each with varied phrasings of the same address (template bank: "قرب X", "جنب X", "بجانب X عمارة Y", floor variants), mark delivery_verified, set entity confirmations accordingly. Purpose: dashboard charts + tier-2 richness. **Demo building 'عمارة زيدان' is EXCLUDED from history** — it must be learned live on stage.
- **Demo fixtures**: the exact demo addresses + expected parse results pre-warmed into LLM cache.

## 8. HTTP endpoints (implement exactly; schemas in contract)

```
POST /api/resolve                 {raw_text, phone?} → Resolution
POST /api/orders                  {items, phone, raw_address} → Order (+pin_token if needed)
GET  /api/orders/:id              → Order + Resolution
POST /api/pin/:token              {lat, lng} → {ok, points_pending}
GET  /api/driver/tasks            → [{order, resolution, route}]
POST /api/driver/road-tap         {checkpoint_id, status} → {ok}
POST /api/deliveries/:orderId/complete {lat, lng} → {ok, learned: {...}}
GET  /api/checkpoints             → [{checkpoint, status, staleness, assumed}]
GET  /api/road-events?limit=20    → recent feed (for dashboard ticker)
POST /api/ingest/road-post        {text, source} → {parsed, matched}   # telegram sidecar + simulator both use this
GET  /api/dashboard/kpis          → {resolution_rate, tier_breakdown, avg_confidence, calls_saved_est, addresses_verified, entities_learned, trend:[...]}
POST /api/simulate/neighbor       {text} → Resolution   # convenience for stage demo of tier-2
```
CORS open; JSON errors `{error: {code, message}}`; every route logs one line (method, path, ms) — the running log is part of the demo's credibility.

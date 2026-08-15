# 07 — WUSOOL System Architecture
### How the engine works, what data it uses, and how everything connects

---

## 1 - What We Built

WUSOOL converts free-text Palestinian dialect addresses into GPS coordinates, learns from
every delivery, routes drivers around live checkpoint closures, and bridges colloquial
addresses to the municipality's formal addressing system.

**One sentence:** "رام الله، قرب المسجد، عمارة زيدان، ط٣" → GPS + official neighborhood +
safe route + dynamic price — in under 2 seconds.

---

## 2 - Data Sources

### 2.1 OpenStreetMap (Overpass API)

**What:** 2,753 real landmarks in the Ramallah/Al-Bireh delivery zone — mosques, pharmacies,
roundabouts, schools, shops, hospitals, banks, restaurants, cafes.

**How:** `npm run osm` sends an Overpass query covering Ramallah, Al-Bireh, Beitunia,
Kufr Aqab, Qalandia, Jifna, and Birzeit. The response is saved to
`seed/landmarks.ramallah.json` and committed to the repo — so a fresh clone has the data
without needing internet.

**What we extract per landmark:**
- `name` / `name:ar` / `name:en` — inserted as aliases for fuzzy matching
- `lat` / `lng` — from the node or polygon centroid
- `amenity` / `shop` tags — mapped to entity kinds (landmark, shop)
- Confidence: 0.70 (OSM-sourced)

**4,766 aliases** are generated from the name variants — so "دوار المنارة", "المنارة",
"ساحة المنارة", and "Al-Manara Square" all resolve to the same entity.

**Role in the cascade:** Tier 3 triangulation. When a customer says "قرب دوار المنارة",
the cascade looks up "دوار المنارة" in the entity graph, finds its GPS coordinates, and
uses them as a triangulation anchor.

---

### 2.2 Ramallah Municipality GIS (ArcGIS REST API)

**What:** Official cadastral data — neighborhoods (حي), blocks (حوض), parcels (قطعة),
street addresses, postcodes, building classifications.

**Source:** `https://ramallahm.maps.arcgis.com` — the municipality's public GIS portal.
Publicly accessible, no authentication required. The challenge document §8 explicitly lists
"بيانات البلديات المتاحة" as a suggested data source.

**Two layers queried:**

| Layer | Endpoint | Fields |
|---|---|---|
| Parcels (قطع الأراضي) | `Parcels_Ramallah_AlBeirh/MapServer/1` | BLOCKNONAME, QUARTERNONAME, PARCEL_NO, CITY |
| Buildings (المباني) | `RamallahBuildingsOpen/MapServer/0` | NEIGHBORHOOD, ADDRESS, POSTCODE, ROAD_NAME_ARABIC |

**How it works:**

1. Resolution produces GPS coordinates (e.g. 31.9033, 35.2058)
2. Coordinates are projected from WGS84 to Palestine Grid (EPSG:28191) via ArcGIS
   Geometry Service
3. Both layers are queried in parallel with a 50m envelope around the projected point
4. Results are merged into the resolution response as `official: { neighborhood, parcel }`
5. The explain array shows: `cadastral: حي قدورة / 17-قدوره — 16 شارع خليل صلاح`

**Example response:**
```json
{
  "neighborhood": "حي قدورة",
  "block": "19-المدينة",
  "quarter": "17-قدوره",
  "parcel": "1",
  "street_address": "16 شارع خليل صلاح",
  "postcode": "6008960",
  "city": "رام الله"
}
```

**Graceful degradation:** Returns null when offline or outside Ramallah coverage. The
resolution still works without it — cadastral data enriches but doesn't block.

**Why it matters:** This bridges three worlds that nobody else connects:
- "عمارة زيدان قرب المسجد" — how Palestinians talk
- 31.9033, 35.2058 — GPS (how the driver's phone talks)
- حي قدورة, 16 شارع خليل صلاح — how the municipality talks

---

### 2.3 Gemini 3.5 Flash (Google AI)

**What:** Large language model for parsing dialect Arabic addresses and community road posts
into structured JSON.

**Cost:** Free (500 requests/day on Google AI Studio free tier).

**Two parsing jobs:**

**A. Address Extraction:**
```
Input:  "رام الله، التحتا، قرب عمارة النتشة، فوق سوبرماركت الأمل، طابق ٣، باب بني"
Output: {
  "city": "رام الله",
  "area": "التحتا",
  "building": "عمارة النتشة",
  "landmarks": [{"name": "سوبرماركت الأمل", "type": "supermarket"}],
  "floor": "3",
  "relations": [{"subject": "target", "relation": "near", "object": "عمارة النتشة"}],
  "notes": "باب بني"
}
```

**B. Road Post Extraction:**
```
Input:  "الوضع عالكونتينر مسكر بالكامل والبديل واد النار أزمة خانقة"
Output: {
  "is_road_related": true,
  "mentions": [
    {"place": "الكونتينر", "kind": "checkpoint", "status": "closed"},
    {"place": "واد النار", "kind": "road", "status": "congested"}
  ]
}
```

**Caching:** Every LLM response is cached by SHA1(model+system+user) in `cache/llm/`.
`npm run warm` pre-caches the demo addresses. After warming, the demo runs fully offline
with `engine: llm-cache`.

**Fallback chain:**
1. Check cache → hit → return (engine: llm-cache)
2. Cache miss + key available → call Gemini → cache response (engine: llm)
3. No key or Gemini fails → rule-based Arabic parser (engine: rules)

The rule engine is not a stub — it handles the full cascade offline. Weak connectivity
is the normal case in Area C and at checkpoints. This is a product requirement.

---

### 2.4 OSRM (Open Source Routing Machine)

**What:** Road routing with alternatives — real road geometry, not straight lines.

**Source:** Public OSRM server at `router.project-osrm.org`.

**How we use it:**

1. Request: `GET /route/v1/driving/{storeLng},{storeLat};{destLng},{destLat}?alternatives=true&overview=full&geometries=geojson`
2. For each alternative route, check if it passes within 600m of any active checkpoint
3. Apply penalties: closed checkpoint = +3600s, congested = +900s
4. Choose the route with minimum (duration + penalty)
5. Return chosen route + rejected alternatives with `blocked_by` checkpoint name

**On the frontend:** The driver phone screen draws the real OSRM route as a blue polyline
on Esri satellite imagery tiles.

**Fallback:** If OSRM is unreachable, serve the cached route or draw a straight line.

---

### 2.5 Esri World Imagery

**What:** Satellite tile imagery for the map views.

**Source:** `server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile`

**How we use it:** Leaflet tile layer on both the customer pin-confirmation map (step 3)
and the driver navigation map. Free for non-commercial use.

---

### 2.6 Community Road Reports (Telegram / WhatsApp)

**What:** Live checkpoint and road status from Palestinian "أحوال الطرق" communities.

**How:**
- `POST /api/ingest/road-post` — ingestion endpoint for any source
- `telegram/listener.py` — Telegram listener with `--replay` mode for offline demo
- The LLM (or rule engine) parses dialect text into structured events
- Events are matched to checkpoint entities via fuzzy name matching
- Status is aggregated with freshness decay (half-life 90 min) and source weights
  (driver 0.5, telegram 0.35, whatsapp 0.3)

**Negation handling:** "مافي زحمة" (no congestion) correctly maps to `open`, not
`congested`. This was a critical bug fix — misreading "no traffic" as "traffic" would
route drivers away from the one clear road.

**8 checkpoints** with verified coordinates (6 of 8 spec coordinates were wrong, one by
2.7 km — verified against OSM):
Qalandia, Container, Atara, Beit El, Jaba, Huwara, Zaatara, Jalama.

---

### 2.7 Wusool's Own Delivery Data (The Flywheel)

**What:** Every pin confirmation and completed delivery teaches the system.

**What gets learned:**
- **Building positions:** Pin at عمارة زيدان → entity gets GPS coordinates
- **Alias accumulation:** "بناية زيدان" → same entity as "عمارة زيدان"
- **Confidence growth:** Each delivery → confirmations++, confidence rises
- **Landmark discovery:** 3+ deliveries clustering within 120m → new landmark created
- **Contradiction detection:** Pin >2km from existing estimate → confidence decays,
  re-pin triggered

**The neighbor effect (the money shot):**
```
Day 1: Customer A pins عمارة زيدان → building gets coordinates (confidence 0.65)
Day 2: Customer B says "بناية زيدان" → Tier 2, instant, confidence 0.80
       Badge: "learned from 1 prior delivery"
Day N: Every tenant resolves instantly — zero pins, zero calls
```

This is the flywheel: every delivery makes the next one cheaper and faster.

---

## 3 - The Resolution Engine (4-Tier Cascade)

When `POST /api/resolve` receives a raw Arabic address:

### Tier 1 — Your Own History (confidence 0.98)
```
Has THIS phone sent THIS address before?
  → normalized text similarity ≥ 0.85 against verified addresses
  → YES → return stored GPS, instant
```

### Tier 2 — Neighbor Effect (confidence = entity + 0.15, up to 0.95)
```
Has ANYONE pinned THIS BUILDING before?
  → parse building name from text
  → match to entity graph (fuzzy: Levenshtein ≤2 or token overlap ≥0.6)
  → entity has coordinates?
  → YES → return building GPS + "learned from N prior deliveries"
```

### Tier 3 — Landmark Triangulation (confidence 0.55 / 0.70 / 0.80)
```
Can we locate from the LANDMARKS named?
  → parse landmark names from text
  → match each to entity graph (2,753 OSM + learned landmarks)
  → compute weighted centroid of matched landmarks
  → 1 landmark → 0.55, 2 → 0.70, 3+ → 0.80
  → spread bonus: all within 300m → +0.05
  → spread penalty: spread > 800m → -0.15
```

### Tier 4 — Cold (confidence 0.20)
```
Nothing matched → fall back to city centroid
  → confidence 0.20 → status: needs_pin
  → generate pin token → customer taps once on the map
  → building learned → next person gets Tier 2
```

### Status Thresholds
```
confidence > 0.75  → "resolved"  → order goes to ready
confidence 0.50-0.75 → "estimated" → order goes to ready (pin available for refinement)
confidence < 0.50  → "needs_pin"  → order waits for customer pin
```

### After Resolution: Cadastral Enrichment
```
If coordinates exist and inside Ramallah coverage:
  → project to Palestine Grid (EPSG:28191)
  → query Parcels + Buildings layers in parallel
  → attach official neighborhood, parcel, street address, postcode
  → add to explain[]: "cadastral: حي قدورة / 17-قدوره — 16 شارع خليل صلاح"
```

---

## 4 - Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     DATA SOURCES                             │
│                                                              │
│  OpenStreetMap ──→ 2,753 landmarks (seed layer)              │
│  Ramallah GIS ──→ official neighborhoods/parcels (enrichment)│
│  Gemini AI    ──→ dialect Arabic parsing (or rule engine)     │
│  OSRM         ──→ road routing + alternatives                │
│  Telegram     ──→ community checkpoint reports               │
│  Deliveries   ──→ pins + confirmations (the flywheel)        │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                     RESOLUTION ENGINE                        │
│                                                              │
│  Raw Arabic text                                             │
│       ↓                                                      │
│  AI Parser (Gemini) ──or──→ Rule Engine (offline)            │
│       ↓                                                      │
│  Tier 1: phone history ─→ 0.98                               │
│  Tier 2: neighbor effect ─→ 0.80  ← THE FLYWHEEL            │
│  Tier 3: landmark triangulation ─→ 0.55-0.80                │
│  Tier 4: cold / ask for pin ─→ 0.20                         │
│       ↓                                                      │
│  Cadastral Enrichment (Ramallah GIS)                         │
│       ↓                                                      │
│  Checkpoint-Aware Routing (OSRM + penalties)                 │
│       ↓                                                      │
│  GPS + Official Address + Safe Route + Dynamic Price         │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                     THREE INTERFACES                         │
│                                                              │
│  Customer Phone ──→ type address → see parse → confirm pin   │
│                     → see price with trust discount           │
│                                                              │
│  Driver Phone   ──→ satellite map + OSRM route + checkpoints │
│                     → turn-by-turn → delivery completion      │
│                                                              │
│  Dispatch Panel ──→ KPIs + learned landmarks + road events   │
│                     → accuracy metrics + address database     │
└─────────────────────────────────────────────────────────────┘
```

---

## 5 - Measured Accuracy

From `npm run bench` — 27 buildings, scratch database, differently-worded addresses from
different phones, 12m GPS noise on simulated pins:

| Scenario | Median | p90 | Within 100m |
|---|---|---|---|
| Normal mapping app (city centroid) | **1,270 m** | 2,805 m | 4% |
| Wusool — text only (cold) | **87 m** | 1,376 m | 56% |
| Wusool — after ONE customer pin | **9 m** | 12 m | 100% |

From `npm run eval` — 24 cases with perturbed ground truth (zero-error impossible by
construction):

| Metric | Value | Threshold |
|---|---|---|
| hit@250m | 90% | ≥85% PASS |
| controls_correct | 100% | =100% PASS |
| mean error (tiers 1-3) | 116m | — |

---

## 6 - The Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js 22+ / TypeScript | Native type stripping, no build step |
| Server | Express on port 4000 | Serves API + frontend from one origin |
| Database | `node:sqlite` (built-in) | No native compile — `npm install` cannot fail |
| AI | Gemini 3.5 Flash (free) | 500 req/day, cached for offline |
| AI fallback | Rule-based Arabic parser | Full cascade without internet |
| Routing | OSRM (public) | Cached — works offline |
| Maps | Leaflet + Esri World Imagery | Real satellite tiles |
| Cadastral | Ramallah Municipality ArcGIS | Live REST queries |
| Frontend | Single HTML file | No React, no Vite, no build step |
| Telegram | Python listener + replay mode | Works offline with recorded samples |

**Total:** ~3,200 lines TypeScript, ~3,300 lines frontend, ~190 lines Python.

**Start command:**
```bash
cd backend && npm install && npm run seed && npm run dev
# open http://localhost:4000
```

No API key, no build step, no internet needed after clone.

---

*Updated: 2026-08-15*

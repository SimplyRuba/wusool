# 03 — INTEGRATION, CONTRACT & DEMO

## 1. The shared contract (`shared/contract.ts`) — WRITE THIS FIRST

```ts
export type ResolutionStatus = 'resolved' | 'estimated' | 'needs_pin';
export type Tier = 1 | 2 | 3 | 4;

export interface ParsedAddress {
  city: string | null; area: string | null;
  landmarks: { name: string; type: string }[];
  building: string | null; floor: string | null; apartment: string | null;
  relations: { subject: string; relation: string; object: string }[];
  notes: string | null;
}

export interface Resolution {
  id: number; status: ResolutionStatus; tier: Tier;
  confidence: number;                 // 0..1
  lat: number | null; lng: number | null;
  parsed: ParsedAddress;
  matched_entities: { id: number; name: string; kind: string; source: string }[];
  learned_from: number | null;        // tier-2 badge: prior verified deliveries for this building
  official: { neighborhood: string; parcel: string } | null;  // stretch
}

export interface Order {
  id: number; status: 'created'|'awaiting_pin'|'ready'|'assigned'|'delivered'|'failed';
  phone: string; raw_address: string; items: {name:string; qty:number}[];
  resolution: Resolution; pin_token: string | null;
}

export type CheckpointStatus = 'open' | 'congested' | 'closed';
export interface CheckpointState {
  id: number; name_ar: string; name_en: string; lat: number; lng: number;
  status: CheckpointStatus; staleness_min: number; assumed: boolean;
}

export interface RouteResult {
  chosen: GeoJSON.LineString; duration_s: number; penalty_s: number;
  rejected: { geometry: GeoJSON.LineString; blocked_by: string }[];
}

export interface DriverTask { order: Order; route: RouteResult | null; }

export interface RoadEvent {
  id: number; checkpoint: string; status: CheckpointStatus;
  source: 'telegram'|'whatsapp'|'driver'; raw_text: string | null; reported_at: string;
}

export interface Kpis {
  resolution_rate: number; avg_confidence: number;
  tier_breakdown: Record<'1'|'2'|'3'|'4', number>;
  calls_saved_est: number; addresses_verified: number; entities_learned: number;
  trend: { month: string; auto_rate: number }[];   // the learning curve
}
```
Backend serializes to this exactly; frontend types import from a copied file. Any change to the contract requires updating both copies in the same commit — the contract file header says so.

## 2. Environment

```
backend/.env   ANTHROPIC_API_KEY=...  PORT=4000  LLM_CACHE=1
frontend/.env  VITE_API=http://localhost:4000
```

## 3. Run commands
```
cd backend && npm i && npm run seed && npm run dev     # :4000
cd frontend && npm i && npm run dev                    # :5173
python telegram/listener.py                            # optional
```

## 4. Integration sequence (after parallel tracks converge)

1. Flip `MOCK=false` in `frontend/src/lib/api.ts`.
2. Smoke path A (address): `/` → type demo address → resolve renders parse chips + map → order → pin link → `/pin/:token` → confirm → backend logs pending points.
3. Smoke path B (learning): `POST /api/simulate/neighbor` with a DIFFERENT wording of the same building → response must be tier 2 with `learned_from ≥ 1` → checkout shows the neighbor badge. **This is the demo's money shot — test it 5 times.**
4. Smoke path C (roads): dashboard simulator → paste dialect post → checkpoint flips color on all open map instances (poll every 5s is fine; no websockets).
5. Smoke path D (driver): `/driver` shows task, route with one rejected alternative labeled with the closed checkpoint, deliver → toast shows learning, dashboard KPI ticks.
6. Fix contract mismatches ONLY by editing both contract copies.

## 5. Demo data script (exact strings)

- Address 1 (cold, live on stage): `رام الله، قرب مسجد جمال عبد الناصر، عمارة زيدان، الطابق الثالث، بجانب سوبر ماركت الأمل` → expect tier 3, estimated/needs_pin.
- Pin it at (31.9052, 35.1994) [adjust to real mosque vicinity on the map].
- Address 2 (neighbor, different phone + different wording): `البيرة عمارة زيدان جنب سوبرماركت الامل ط٢` → expect tier 2 + badge.
- Road post: `الوضع عالكونتينر مسكر بالكامل والبديل واد النار أزمة خانقة` → Container→closed, Wadi al-Nar area→congested.
- Driver route: store (31.906, 35.204) → a destination whose fastest OSRM route passes near the seeded closed checkpoint, so the rejection story triggers. Pre-test and hardcode the destination that produces it.

## 6. Offline insurance

- Warm LLM cache: script `npm run warm` sends both demo addresses + 5 phrasings + the road post through the parser; cache committed.
- Leaflet tiles: keep the laptop's browser cache warm by panning the demo area before going on stage; optional: save a tiles fallback screenshot in slides.
- OSRM: fetch demo route once at startup and cache in memory; if OSRM unreachable, serve cached.
- Full offline mode = cached LLM + cached route + local DB: the entire demo works with zero internet except map tiles.

## 7. Three-minute demo script

1. **(20s) Problem**: show the challenge's own example address on a slide. "Google can't find this. Every Palestinian can. We built the system that closes that gap."
2. **(40s) Live resolve**: type Address 1 in the checkout. Parse chips animate. "Our LLM reads dialect. Landmarks matched from OSM + municipal data. Confidence 6X% — honest uncertainty, so the customer pins ONCE." Tap the pin link, confirm in 5 seconds. "+10 points, pending until reality confirms."
3. **(30s) The learning moment**: submit Address 2 — different customer, different wording. Tier-2 badge appears: "resolved instantly — learned from the neighbor's delivery. The system asks less the more it works. That's how we reach the 90% KPI."
4. **(40s) Roads**: dashboard. Paste the Telegram-style post. Checkpoint flips red live. Switch to driver: route avoids it, rejected route shown dashed. "The same parser that reads addresses reads Palestine's road chatter. Drivers confirm with one tap."
5. **(30s) Close the loop**: driver hits Delivered. Toast: building verified. Dashboard counters tick. Show the learning-curve chart. "Every shawarma order maps Palestine a little more."
6. **(20s) Business**: SDK snippet slide + flywheel diagram. "Any checkout, one paste. Merchants stop losing COD orders; the dataset nobody else has compounds. Delivery today — national addressing infrastructure tomorrow."

## 8. Q&A ammunition (one-liners)
- Gaming the points? → paid only on verified outcomes; anomaly detection; trust scores; sparse-zone diminishing returns.
- Privacy? → phone hashed, tokenized metadata to merchants, public-channel road data only, consent on pin.
- Wrong neighbor pin? → evidence-weighted; contradictions decay confidence and re-trigger the pin ask.
- Why will Google not do this? → they lack the delivery feedback loop and the dialect corpus; our data is generated by operations, not collection.
- Offline areas? → resolution is server-side at order time; driver screen caches the day's tasks.

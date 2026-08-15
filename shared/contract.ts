/* =============================================================================
   WUSOOL — SHARED API CONTRACT  ·  THE SOURCE OF TRUTH
   Any change here must be made in backend and frontend copies in the SAME commit.
   ============================================================================= */

export type ResolutionStatus = 'resolved' | 'estimated' | 'needs_pin';
export type Tier = 1 | 2 | 3 | 4;

/** GeoJSON LineString, declared locally so the contract compiles with no @types/geojson. */
export interface LineString {
  type: 'LineString';
  coordinates: [number, number][];   // [lng, lat]
}

export interface ParsedAddress {
  city: string | null;
  area: string | null;
  landmarks: { name: string; type: string }[];
  building: string | null;
  floor: string | null;
  apartment: string | null;
  relations: { subject: string; relation: string; object: string }[];
  notes: string | null;
}

export interface MatchedEntity {
  id: number; name: string; kind: string; source: string; confidence: number;
}

export interface Resolution {
  id: number;
  status: ResolutionStatus;
  tier: Tier;
  confidence: number;                 // 0..1
  lat: number | null;
  lng: number | null;
  parsed: ParsedAddress;
  matched_entities: MatchedEntity[];
  learned_from: number | null;        // tier-2 badge: prior verified deliveries for this building
  official: { neighborhood: string; parcel: string } | null;
  /** which parser produced `parsed` — the demo shows this, and it proves the offline path */
  engine: 'llm' | 'llm-cache' | 'rules';
  explain: string[];                  // human-readable confidence breakdown
}

export type OrderStatus = 'created'|'awaiting_pin'|'ready'|'assigned'|'delivered'|'failed';

export interface Order {
  id: number;
  status: OrderStatus;
  phone: string;
  raw_address: string;
  items: { name: string; qty: number }[];
  resolution: Resolution;
  pin_token: string | null;
}

export type CheckpointStatus = 'open' | 'congested' | 'closed';

export interface CheckpointState {
  id: number; name_ar: string; name_en: string; lat: number; lng: number;
  status: CheckpointStatus; staleness_min: number; assumed: boolean;
}

export interface RouteResult {
  chosen: LineString;
  duration_s: number;
  penalty_s: number;
  distance_m: number;
  rejected: { geometry: LineString; blocked_by: string; penalty_s: number }[];
  source: 'osrm' | 'cache' | 'straight-line';
}

/** NOTE: `Order` already embeds its `Resolution` — do not add a third key here. */
export interface DriverTask { order: Order; route: RouteResult | null; }

export interface RoadEvent {
  id: number; checkpoint: string; status: CheckpointStatus;
  source: 'telegram'|'whatsapp'|'driver'; raw_text: string | null; reported_at: string;
}

export interface PinResult { ok: true; points_pending: number; address_id: number; }

export interface DeliveryResult {
  ok: true;
  learned: {
    entities_confirmed: number;
    landmark_discovered: { id: number; name: string; lat: number; lng: number } | null;
    address_verified_count: number;
    points_verified: number;
    neighbor_credited: boolean;
  };
}

export interface Kpis {
  resolution_rate: number;
  avg_confidence: number;
  tier_breakdown: Record<'1'|'2'|'3'|'4', number>;
  calls_saved_est: number;
  addresses_verified: number;
  entities_learned: number;
  trend: { month: string; auto_rate: number }[];
}

export interface ApiError { error: { code: string; message: string } }

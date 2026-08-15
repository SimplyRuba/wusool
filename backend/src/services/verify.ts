import type { DeliveryResult, Resolution } from '../contract.ts';
import { all, get, insert, run } from '../db/index.ts';
import { normalizeArabic } from '../lib/arabic.ts';
import { haversine, phoneHash } from '../lib/geo.ts';
import {
  getEntity, setEntityPosition, confirmEntity, contradictEntity,
  runLandmarkDiscovery, type Discovery,
} from './entities.ts';
import { award, verifyPointsFor } from './points.ts';

const ANOMALY_M = 2000;

/* Confidence given to an entity the moment reality positions it (a customer pin
   or a completed delivery). Tier 2 adds +0.15, so 0.65 -> 0.80, comfortably past
   the strict 0.75 RESOLVED boundary in cascade.ts. Both call sites must agree:
   when they drifted apart, the neighbour badge silently landed at 0.75 and the
   demo showed "estimated" instead of "resolved". */
export const POSITIONED_CONFIDENCE = 0.65;

/**
 * The customer pinned their location. This is the single most important write in
 * the system: it is where a text string becomes a coordinate.
 *
 * SPEC FIX — the pinned building entity is given the pinned coordinates here.
 * Spec 01 section 5 attached the entity but never positioned it, while tier 2
 * requires a building entity *with coords*. The only rule that set coordinates
 * needed 3 confirmations and a completed delivery, which cannot happen between
 * the pin and the next order. The neighbour-effect demo could therefore never
 * fire. Confidence 0.65 is chosen so tier 2 yields 0.65 + 0.15 = 0.80, clear of
 * the strict 0.75 RESOLVED boundary in cascade.ts.
 */
export function onPinConfirmed(orderId: number, lat: number, lng: number) {
  const order = get<any>('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw new Error('order not found');
  const res = get<any>('SELECT * FROM resolutions WHERE id = ?', order.resolution_id);
  const parsed = res ? JSON.parse(res.parsed_json) : {};
  const ph = phoneHash(order.phone);

  const entityIds: number[] = res?.matched_entity_ids ? JSON.parse(res.matched_entity_ids) : [];
  const buildingId = entityIds.map(getEntity)
    .find(e => e && e.kind === 'building')?.id ?? null;

  // anomaly: a tier-3 estimate that lands far from where the customer says they are
  let anomalous = false;
  if (res?.tier === 3 && res.lat != null) {
    const drift = haversine(res.lat, res.lng, lat, lng);
    if (drift > ANOMALY_M) {
      anomalous = true;
      for (const id of entityIds) contradictEntity(id);
    }
  }

  const addressId = insert(
    `INSERT INTO addresses
      (phone_hash, raw_text, normalized_text, lat, lng, building_entity_id, status, contradictions)
     VALUES (?,?,?,?,?,?,'pinned',?)`,
    ph, order.raw_address, normalizeArabic(order.raw_address),
    lat, lng, buildingId, anomalous ? 1 : 0);

  run('UPDATE orders SET address_id = ?, status = ? WHERE id = ?',
      addressId, 'ready', orderId);

  // THE FIX: position the building so the next neighbour resolves at tier 2
  if (buildingId) {
    const e = getEntity(buildingId)!;
    if (e.lat == null || e.lng == null) setEntityPosition(buildingId, lat, lng, POSITIONED_CONFIDENCE);
    else confirmEntity(buildingId);
  }

  let pending = 0;
  if (!anomalous) {
    pending += award(ph, 10, 'pin_verified', 'address', addressId);
    const nearby = all<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM addresses
        WHERE status IN ('pinned','delivery_verified') AND id != ? AND lat IS NOT NULL`, addressId)
      .filter(a => haversine(a.lat, a.lng, lat, lng) <= 400).length;
    if (nearby < 3) pending += award(ph, 10, 'sparse_bonus', 'address', addressId);
  }

  return { address_id: addressId, points_pending: pending, anomalous, building_entity_id: buildingId };
}

/**
 * The driver completed the drop. Reality has now confirmed the guess, so every
 * entity on the path gains a confirmation, pending points become real, and the
 * landmark-discovery rule gets its chance to promote a ghost landmark.
 */
export function onDelivered(orderId: number, lat: number, lng: number): DeliveryResult['learned'] {
  const order = get<any>('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw new Error('order not found');
  const res = get<any>('SELECT * FROM resolutions WHERE id = ?', order.resolution_id);
  const ph = phoneHash(order.phone);
  const entityIds: number[] = res?.matched_entity_ids ? JSON.parse(res.matched_entity_ids) : [];

  let addressId: number | null = order.address_id ?? null;
  if (addressId == null) {
    const buildingId = entityIds.map(getEntity).find(e => e && e.kind === 'building')?.id ?? null;
    addressId = insert(
      `INSERT INTO addresses
        (phone_hash, raw_text, normalized_text, lat, lng, building_entity_id, status, verified_count)
       VALUES (?,?,?,?,?,?, 'delivery_verified', 1)`,
      ph, order.raw_address, normalizeArabic(order.raw_address), lat, lng, buildingId);
    run('UPDATE orders SET address_id = ? WHERE id = ?', addressId, orderId);
  } else {
    run(`UPDATE addresses
            SET status = 'delivery_verified', verified_count = verified_count + 1,
                lat = ?, lng = ?
          WHERE id = ?`, lat, lng, addressId);
  }

  for (const id of entityIds) confirmEntity(id);

  // a building with no position yet gets one from the delivery itself
  const addr = get<any>('SELECT * FROM addresses WHERE id = ?', addressId);
  let discovered: Discovery | null = null;
  if (addr?.building_entity_id) {
    const e = getEntity(addr.building_entity_id)!;
    if (e.lat == null) setEntityPosition(e.id, lat, lng, POSITIONED_CONFIDENCE);
    discovered = runLandmarkDiscovery(addr.building_entity_id);
  }
  for (const id of entityIds) {
    if (discovered) break;
    discovered = runLandmarkDiscovery(id);
  }

  const verified = verifyPointsFor(addressId!);
  run('UPDATE orders SET status = ? WHERE id = ?', 'delivered', orderId);

  // tier 2 used somebody else's pin — pay that neighbour
  let neighborCredited = false;
  if (res?.tier === 2 && addr?.building_entity_id) {
    const donor = get<{ phone_hash: string }>(
      `SELECT phone_hash FROM addresses
        WHERE building_entity_id = ? AND phone_hash IS NOT NULL AND phone_hash != ?
        ORDER BY id ASC LIMIT 1`, addr.building_entity_id, ph);
    if (donor?.phone_hash) {
      award(donor.phone_hash, 2, 'neighbor_assist', 'address', addressId!);
      neighborCredited = true;
    }
  }

  return {
    entities_confirmed: entityIds.length,
    landmark_discovered: discovered,
    address_verified_count: (addr?.verified_count ?? 0),
    points_verified: verified,
    neighbor_credited: neighborCredited,
  };
}

/** An address that has been contradicted twice is asked to pin again next time. */
export const isDistrusted = (addressId: number): boolean =>
  (get<{ c: number }>('SELECT contradictions AS c FROM addresses WHERE id = ?', addressId)?.c ?? 0) >= 2;

export const resolutionById = (id: number): Resolution | null => {
  const r = get<any>('SELECT * FROM resolutions WHERE id = ?', id);
  if (!r) return null;
  const ids: number[] = r.matched_entity_ids ? JSON.parse(r.matched_entity_ids) : [];
  return {
    id: r.id, status: r.status, tier: r.tier, confidence: r.confidence,
    lat: r.lat, lng: r.lng, parsed: JSON.parse(r.parsed_json),
    matched_entities: ids.map(getEntity).filter(Boolean).map(e => ({
      id: e!.id, name: e!.canonical_name, kind: e!.kind, source: e!.source, confidence: e!.confidence,
    })),
    learned_from: null, official: null, engine: r.engine,
    explain: r.explain_json ? JSON.parse(r.explain_json) : [],
  };
};

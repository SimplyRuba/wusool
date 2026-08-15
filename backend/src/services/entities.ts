import { all, get, insert, run } from '../db/index.ts';
import { normalizeArabic } from '../lib/arabic.ts';
import { samePlace } from '../lib/placename.ts';
import { haversine, weightedCentroid } from '../lib/geo.ts';

export type Entity = {
  id: number; kind: string; canonical_name: string;
  lat: number | null; lng: number | null;
  source: string; confidence: number; confirmations: number; contradictions: number;
  /** How many DISTINCT places in range share this exact name. 0 = unambiguous.
      Chains are the common case: "بنك فلسطين" is six branches, not one place. */
  ambiguous?: number;
};

export const getEntity = (id: number) =>
  get<Entity>('SELECT * FROM entities WHERE id = ?', id);

export function addAlias(entityId: number, alias: string) {
  const n = normalizeArabic(alias);
  if (!n) return;
  run('INSERT OR IGNORE INTO entity_aliases (entity_id, alias) VALUES (?, ?)', entityId, n);
}

/** A named place is ambiguous when rival candidates sit more than this far apart. */
const SAME_PLACE_M = 500;
/** How far from the city hint we still consider a candidate plausible. */
const IN_TOWN_M = 4000;

/**
 * Exact alias hit.
 *
 * WHY THIS IS NOT `LIMIT 1`: with 28 hand-picked landmarks every name was
 * unique, so taking the highest-confidence row was harmless. Against the real
 * OSM extract, 158 alias strings point at two or more entities and 127 of those
 * are more than 500 m apart — "بنك فلسطين" is six branches spread over 8.7 km.
 * Picking one by confidence would silently send a driver to the wrong branch
 * and report high certainty while doing it.
 *
 * So: prefer the candidate nearest the city hint, and report how many rivals
 * remain plausible. The caller lowers its confidence accordingly — the system
 * should say "I know the name but not which one", not guess quietly.
 */
type AliasHit = { entity: Entity; inTown: boolean };

function byAlias(
  norm: string, nearLat?: number | null, nearLng?: number | null,
): AliasHit | undefined {
  const rows = all<Entity>(
    `SELECT e.* FROM entities e
       JOIN entity_aliases a ON a.entity_id = e.id
      WHERE a.alias = ? ORDER BY e.confidence DESC`, norm);
  if (!rows.length) return undefined;

  const placed = rows.filter(r => r.lat != null && r.lng != null);
  const noHint = nearLat == null || nearLng == null;

  if (!placed.length || noHint) {
    /* No way to tell them apart by position. Report ambiguity from raw spread. */
    let maxSpread = 0;
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++)
        maxSpread = Math.max(maxSpread,
          haversine(placed[i].lat!, placed[i].lng!, placed[j].lat!, placed[j].lng!));
    return {
      entity: { ...rows[0], ambiguous: maxSpread > SAME_PLACE_M ? placed.length : 0 },
      inTown: true,   // nothing contradicts it
    };
  }

  const dist = (r: Entity) => haversine(nearLat, nearLng, r.lat!, r.lng!);
  const inTown = placed.filter(r => dist(r) <= IN_TOWN_M);
  const pool = inTown.length ? inTown : placed;
  const sorted = [...pool].sort((a, b) => dist(a) - dist(b));

  /* Rivals the hint could not separate: same name, still far from the one we
     chose. Two branches on the same street are not ambiguity. */
  const rivals = pool.filter(r =>
    haversine(sorted[0].lat!, sorted[0].lng!, r.lat!, r.lng!) > SAME_PLACE_M).length;

  return {
    entity: { ...sorted[0], ambiguous: rivals ? rivals + 1 : 0 },
    inTown: inTown.length > 0,
  };
}

/**
 * matchOrCreateEntity — spec 01 section 3.
 *  1 normalize   2 exact alias   3 fuzzy (Levenshtein <=2 for len>5, or token overlap >=0.6)
 *  4 otherwise create as `learned` with confidence 0.3
 * A fuzzy candidate is only accepted if it is within 500 m of any coordinate hint.
 */
export function matchOrCreateEntity(
  name: string, kind: string, nearLat?: number | null, nearLng?: number | null,
): Entity {
  const norm = normalizeArabic(name);
  const exact = byAlias(norm, nearLat, nearLng);

  /* An exact name match inside the customer's town is the best answer there is.
     An exact match 6 km away in another town is NOT — Palestine is full of
     shops that share a name across towns, and "سوبر ماركت الأمل" in Kufr Aqab
     is a different shop from the one in Ramallah. When the only exact hit is
     out of town, try the fuzzy pass first: it may find the local place under a
     slightly different spelling, which is the one the customer means. */
  if (exact?.inTown) return exact.entity;

  const cands = all<Entity & { alias: string }>(
    `SELECT e.*, a.alias FROM entities e JOIN entity_aliases a ON a.entity_id = e.id
      WHERE e.kind = ?`, kind);

  const hits: { e: Entity; score: number }[] = [];
  for (const c of cands) {
    const { same, score } = samePlace(norm, c.alias);
    if (!same) continue;
    /* The hint is the city centroid, so this is a "same town" test, not a
       "same street" test. Anything further out is a different place that
       happens to share a name. */
    if (nearLat != null && nearLng != null && c.lat != null && c.lng != null &&
        haversine(nearLat, nearLng, c.lat, c.lng) > IN_TOWN_M) continue;
    hits.push({ e: c, score });
  }
  if (hits.length) {
    hits.sort((a, b) => b.score - a.score);
    const winner = hits[0].e;
    /* Distinct rival places that scored just as well. Several rows can be the
       same entity reached through different aliases — count places, not rows. */
    const rivals = new Set(
      hits.filter(h => h.e.id !== winner.id && h.e.lat != null && winner.lat != null &&
                       haversine(winner.lat, winner.lng!, h.e.lat!, h.e.lng!) > SAME_PLACE_M)
          .map(h => h.e.id)).size;
    addAlias(winner.id, name);
    return { ...winner, ambiguous: rivals ? rivals + 1 : 0 };
  }

  /* Nothing local. Fall back to the out-of-town exact match rather than
     inventing a new entity — the name really does exist, just not here. */
  if (exact) return exact.entity;

  /* nearLat/nearLng are a SEARCH HINT for the fuzzy step above - they are NOT
     stored. A learned entity has no position until something really positions it
     (a customer pin, or a completed delivery). Storing the hint would give every
     brand-new building the city centre, and tier 2 would then "resolve" every
     unknown address to the middle of town with false confidence. */
  const id = insert(
    `INSERT INTO entities (kind, canonical_name, lat, lng, source, confidence)
     VALUES (?, ?, NULL, NULL, 'learned', 0.3)`, kind, name);
  addAlias(id, name);
  return getEntity(id)!;
}

/** Give a coordinate-less entity a position (used when a customer pins a building). */
export function setEntityPosition(id: number, lat: number, lng: number, confidence: number) {
  run(`UPDATE entities SET lat = ?, lng = ?, confidence = MAX(confidence, ?),
                           confirmations = confirmations + 1
        WHERE id = ?`, lat, lng, confidence, id);
}

export function confirmEntity(id: number) {
  run('UPDATE entities SET confirmations = confirmations + 1 WHERE id = ?', id);
}

export function contradictEntity(id: number) {
  run(`UPDATE entities SET contradictions = contradictions + 1,
                           confidence = MAX(0.05, confidence * 0.6)
        WHERE id = ?`, id);
}

export type Discovery = { id: number; name: string; lat: number; lng: number };

/**
 * Landmark discovery — spec 01 section 3.
 * A learned entity with >=3 confirmations whose confirmed drop points cluster
 * within 120 m gets a real position and a confidence promotion. This is the
 * "ghost landmark" moment: a place Google has never heard of becomes a coordinate.
 */
export function runLandmarkDiscovery(entityId: number): Discovery | null {
  const e = getEntity(entityId);
  if (!e || e.source !== 'learned' || e.confirmations < 3) return null;

  const pts = all<{ lat: number; lng: number }>(
    `SELECT lat, lng FROM addresses
      WHERE building_entity_id = ? AND status = 'delivery_verified'
        AND lat IS NOT NULL`, entityId);
  if (pts.length < 3) return null;

  const c = weightedCentroid(pts)!;
  const maxDist = Math.max(...pts.map(p => haversine(c.lat, c.lng, p.lat, p.lng)));
  if (maxDist > 120) return null;

  const conf = Math.min(0.9, 0.3 + 0.2 * e.confirmations);
  run('UPDATE entities SET lat = ?, lng = ?, confidence = ? WHERE id = ?',
      c.lat, c.lng, conf, entityId);
  return { id: entityId, name: e.canonical_name, lat: c.lat, lng: c.lng };
}

/** Every entity that has been given a real position by the system, newest first. */
export const learnedLandmarks = () =>
  all<Entity>(`SELECT * FROM entities
                WHERE source = 'learned' AND lat IS NOT NULL
                ORDER BY id DESC LIMIT 50`);

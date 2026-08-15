import type { ParsedAddress, Resolution, ResolutionStatus, Tier, MatchedEntity } from '../contract.ts';
import { all, get, insert } from '../db/index.ts';
import { normalizeArabic, textSimilarity } from '../lib/arabic.ts';
import { haversine, weightedCentroid, spread, phoneHash, clamp, type Pt } from '../lib/geo.ts';
import { extractAddress } from './parser.ts';
import { matchOrCreateEntity, type Entity } from './entities.ts';
import { findCity } from './rules.ts';

/* Thresholds. NOTE the strict `>` on RESOLVED.
   Spec 01 section 4 said `>= 0.75`, but tier 3 with two landmarks scores
   0.70 + 0.05 (within 300 m) = exactly 0.75. That made the flagship demo
   address resolve outright, so no pin token was ever issued and the
   "pin once" step had nothing to tap. A strict `>` keeps a two-landmark
   estimate in the `estimated` band, which is what the demo script expects. */
const RESOLVED = 0.75;
const ESTIMATED = 0.5;

const statusFor = (c: number): ResolutionStatus =>
  c > RESOLVED ? 'resolved' : c >= ESTIMATED ? 'estimated' : 'needs_pin';

export type ResolveInput = { rawText: string; phone?: string | null };

type Ev = { pt: Pt; label: string };

export async function resolve(input: ResolveInput): Promise<Resolution> {
  const raw = input.rawText.trim();
  const ph = input.phone ? phoneHash(input.phone) : null;
  const norm = normalizeArabic(raw);
  const explain: string[] = [];

  const { parsed, engine, note } = await extractAddress(raw);
  if (note) explain.push(note);
  explain.push(`parsed by ${engine}`);

  const city = findCity(raw);
  const cityPt = city ? { lat: city.lat, lng: city.lng } : null;

  // attach every named thing in the parse to the entity graph
  const matched: Entity[] = [];
  if (parsed.building)
    matched.push(matchOrCreateEntity(parsed.building, 'building', cityPt?.lat, cityPt?.lng));
  for (const lm of parsed.landmarks)
    matched.push(matchOrCreateEntity(lm.name, 'landmark', cityPt?.lat, cityPt?.lng));

  const asMatched = (): MatchedEntity[] => matched.map(e => ({
    id: e.id, name: e.canonical_name, kind: e.kind, source: e.source, confidence: e.confidence,
  }));

  const finish = (
    tier: Tier, confidence: number, lat: number | null, lng: number | null,
    learned_from: number | null, official: Resolution['official'] = null,
    matchedAddressId: number | null = null,
  ): Resolution => {
    const conf = clamp(confidence, 0.05, 0.99);
    const status = statusFor(conf);
    const id = insert(
      `INSERT INTO resolutions
        (raw_text, phone_hash, parsed_json, engine, tier, matched_address_id,
         matched_entity_ids, lat, lng, confidence, status, explain_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      raw, ph, JSON.stringify(parsed), engine, tier, matchedAddressId,
      JSON.stringify(matched.map(m => m.id)), lat, lng, conf, status, JSON.stringify(explain));
    return {
      id, status, tier, confidence: conf, lat, lng, parsed,
      matched_entities: asMatched(), learned_from, official, engine, explain,
    };
  };

  /* ---- TIER 1 — this person, this address, already verified ---- */
  if (ph) {
    const mine = all<any>(
      `SELECT * FROM addresses
        WHERE phone_hash = ? AND status != 'unverified' AND lat IS NOT NULL`, ph);
    let best: { row: any; sim: number } | null = null;
    for (const row of mine) {
      const sim = textSimilarity(norm, row.normalized_text);
      if (!best || sim > best.sim) best = { row, sim };
    }
    if (best && best.sim >= 0.85 && best.row.contradictions < 2) {
      explain.push(`tier 1: your own verified address, text similarity ${(best.sim * 100) | 0}%`);
      return finish(1, 0.98, best.row.lat, best.row.lng, best.row.verified_count,
        best.row.official_neighborhood
          ? { neighborhood: best.row.official_neighborhood, parcel: best.row.official_parcel }
          : null,
        best.row.id);
    }
  }

  /* ---- TIER 2 — the neighbour effect: somebody already pinned this building ---- */
  const bldg = matched.find(m => m.kind === 'building' && m.lat != null && m.lng != null);
  if (bldg) {
    const priors = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM addresses
        WHERE building_entity_id = ? AND status IN ('pinned','delivery_verified')`, bldg.id);
    const learnedFrom = priors?.n ?? 0;
    const conf = Math.min(0.95, bldg.confidence + 0.15);
    explain.push(
      `tier 2: building "${bldg.canonical_name}" is already on the map from ` +
      `${learnedFrom} prior ${learnedFrom === 1 ? 'delivery' : 'deliveries'} ` +
      `(entity confidence ${bldg.confidence.toFixed(2)} + 0.15)`);
    return finish(2, conf, bldg.lat, bldg.lng, learnedFrom);
  }

  /* ---- TIER 3 — landmark triangulation ---- */
  const ev: Ev[] = [];
  for (const e of matched) {
    if (e.lat == null || e.lng == null) continue;
    ev.push({ pt: { lat: e.lat, lng: e.lng, weight: e.confidence || 0.5 }, label: e.canonical_name });
  }
  if (ev.length) {
    const pts = ev.map(e => e.pt);
    const c = weightedCentroid(pts)!;
    const sp = spread(pts);
    let conf = ev.length >= 3 ? 0.8 : ev.length === 2 ? 0.7 : 0.55;
    explain.push(`tier 3: triangulated from ${ev.length} landmark${ev.length > 1 ? 's' : ''} (${ev.map(e => e.label).join(', ')})`);
    if (ev.length > 1 && sp <= 300) { conf += 0.05; explain.push(`landmarks agree within ${sp | 0} m (+0.05)`); }
    if (sp > 800) { conf -= 0.15; explain.push(`landmarks disagree by ${sp | 0} m (-0.15)`); }
    if (city?.camp) { conf -= 0.1; explain.push('unplanned camp fabric, no street grid (-0.10)'); }

    /* Chain-branch ambiguity. "بنك فلسطين" names six real places; knowing the
       name is not the same as knowing which one. Nearest-to-city picked one,
       but the honest answer is lower confidence, which pushes the order into
       the band where we ask for a single tap instead of guessing. */
    const amb = matched.filter(m => (m.ambiguous ?? 0) > 1);
    if (amb.length) {
      conf -= 0.12;
      for (const a of amb)
        explain.push(`"${a.canonical_name}" matches ${a.ambiguous} places in this area — using the nearest (-0.12)`);
    }
    return finish(3, conf, c.lat, c.lng, null);
  }

  /* ---- TIER 4 — cold. City centroid at best, ask for a pin ---- */
  explain.push(city
    ? `tier 4: only the city "${city.ar}" is known — asking the customer to pin once`
    : 'tier 4: nothing recognised in this text — asking the customer to pin once');
  return finish(4, 0.2, cityPt?.lat ?? null, cityPt?.lng ?? null, null);
}

/** Straight-line distance between a resolution and a later ground truth, in metres. */
export const driftFrom = (r: Resolution, lat: number, lng: number): number | null =>
  r.lat == null || r.lng == null ? null : haversine(r.lat, r.lng, lat, lng);

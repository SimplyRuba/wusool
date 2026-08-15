/**
 * Location accuracy benchmark.
 *
 *   DB_PATH=/tmp/bench.db npm run seed
 *   DB_PATH=/tmp/bench.db npm run bench
 *
 * Location accuracy is 30% of the hackathon score and it is the one claim that
 * should never be argued from a screenshot. This measures it, in metres,
 * against known ground truth, and prints the three numbers that matter:
 *
 *   1. BASELINE      what a normal mapping app returns for a colloquial
 *                    address — the city, because there is no street address to
 *                    geocode. This is the status quo we are replacing.
 *   2. COLD          Wusool with no history at all: landmark triangulation
 *                    from the text alone.
 *   3. AFTER ONE PIN Wusool once a single customer has confirmed the building.
 *                    Every later order to that building — anyone's — inherits it.
 *
 * The gap between 2 and 3 is the flywheel, in metres.
 *
 * WHY THIS IS RUN ON A SCRATCH DATABASE: the cold pass has to un-learn each
 * building (strip its position, hide its verified addresses) to measure what
 * the engine knows from text alone. That is destructive, so it must never touch
 * the demo database.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, run, DB_PATH } from '../db/index.ts';
import { resolve } from '../services/cascade.ts';
import { haversine } from '../lib/geo.ts';
import { setEntityPosition } from '../services/entities.ts';
import { POSITIONED_CONFIDENCE } from '../services/verify.ts';
import { findCity } from '../services/rules.ts';
import { normalizeArabic } from '../lib/arabic.ts';

if (!process.env.DB_PATH) {
  console.error('refusing to run on the demo database.');
  console.error('  DB_PATH=/tmp/bench.db npm run seed && DB_PATH=/tmp/bench.db npm run bench');
  process.exit(1);
}
console.log(`benchmarking against ${DB_PATH}\n`);

type Sample = {
  building: string; entityId: number;
  truthLat: number; truthLng: number;
  coldText: string; warmText: string;
};

/* One sample per seeded building, using two DIFFERENTLY WORDED addresses:
   the cold probe and the warm probe must not be the same string, or the warm
   pass would be measuring text recall rather than the entity graph. */
const buildings = all<any>(
  `SELECT id, canonical_name, lat, lng FROM entities
    WHERE kind = 'building' AND source = 'learned' AND lat IS NOT NULL`);

/* Two seeded buildings can end up with the same name — the generator draws
   from 4 stems x 17 family names. A duplicate name makes tier 2 legitimately
   ambiguous, which is a real behaviour but not what this benchmark measures,
   so those buildings are excluded and the exclusion is reported. */
const nameCount = new Map<string, number>();
for (const b of buildings) {
  const k = normalizeArabic(b.canonical_name);
  nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
}

const samples: Sample[] = [];
let skippedDup = 0, skippedThin = 0;
for (const b of buildings) {
  if ((nameCount.get(normalizeArabic(b.canonical_name)) ?? 0) > 1) { skippedDup++; continue; }
  const texts = all<{ raw_text: string }>(
    'SELECT DISTINCT raw_text FROM addresses WHERE building_entity_id = ?', b.id)
    .map(r => r.raw_text);
  if (texts.length < 2) { skippedThin++; continue; }
  samples.push({
    building: b.canonical_name, entityId: b.id,
    truthLat: b.lat, truthLng: b.lng,
    coldText: texts[0], warmText: texts[texts.length - 1],
  });
}
console.log(`${samples.length} buildings measured` +
  `  (excluded: ${skippedDup} with a duplicate name, ${skippedThin} with only one phrasing)\n`);

const err = { baseline: [] as number[], cold: [] as number[], warm: [] as number[] };
const coldTiers: Record<number, number> = {};
const warmTiers: Record<number, number> = {};
let phoneSeq = 700000;
const freshPhone = () => `0599${phoneSeq++}`;

/* A real pin is a finger on a phone map: GPS-assisted, but not perfect.
   Pinning at the exact truth would make the warm number 0 m by construction,
   which is a measurement artefact, not a result. Deterministic so the
   benchmark is reproducible. */
let noiseSeed = 424242;
const noise = () => ((noiseSeed = (noiseSeed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const PIN_ERROR_M = 12;
function jitterPin(lat: number, lng: number): [number, number] {
  const ang = noise() * 2 * Math.PI;
  const r = PIN_ERROR_M * Math.sqrt(noise());
  return [lat + (r * Math.cos(ang)) / 111_320,
          lng + (r * Math.sin(ang)) / (111_320 * Math.cos(lat * Math.PI / 180))];
}

/* ---- PHASE 0 — baseline ------------------------------------------------ */
for (const s of samples) {
  const city = findCity(s.coldText);
  if (city) err.baseline.push(haversine(city.lat, city.lng, s.truthLat, s.truthLng));
}

/* ---- PHASE 1 — cold: un-learn EVERY building, then resolve --------------
   Un-learning one building at a time leaked: by the time building 30 was
   measured, buildings 1-29 had already been pinned by this same loop, so a
   shared name could resolve at tier 2 and the "cold" number was quietly
   contaminated. Stripping the whole graph first removes the ordering effect. */
run(`UPDATE entities SET lat = NULL, lng = NULL, confidence = 0.3
      WHERE kind = 'building' AND source = 'learned'`);
run(`UPDATE addresses SET status = 'unverified'`);

for (const s of samples) {
  const cold = await resolve({ rawText: s.coldText, phone: freshPhone() });
  coldTiers[cold.tier] = (coldTiers[cold.tier] ?? 0) + 1;
  if (cold.lat != null && cold.lng != null)
    err.cold.push(haversine(cold.lat, cold.lng, s.truthLat, s.truthLng));
}

/* ---- PHASE 2 — one pin each, then resolve a different phrasing ---------- */
for (const s of samples) {
  const [plat, plng] = jitterPin(s.truthLat, s.truthLng);
  setEntityPosition(s.entityId, plat, plng, POSITIONED_CONFIDENCE);
  run(`UPDATE addresses SET status = 'pinned'
        WHERE id = (SELECT MIN(id) FROM addresses WHERE building_entity_id = ?)`, s.entityId);
}
for (const s of samples) {
  const warm = await resolve({ rawText: s.warmText, phone: freshPhone() });
  warmTiers[warm.tier] = (warmTiers[warm.tier] ?? 0) + 1;
  if (warm.lat != null && warm.lng != null)
    err.warm.push(haversine(warm.lat, warm.lng, s.truthLat, s.truthLng));
}

/* ------------------------------------------------------------------ */
const pct = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const within = (a: number[], m: number) => a.length ? a.filter(x => x <= m).length / a.length : 0;
const m = (x: number) => (Number.isNaN(x) ? '   —  ' : x >= 1000
  ? (x / 1000).toFixed(1).padStart(5) + ' km' : Math.round(x).toString().padStart(5) + ' m ');

const rows: [string, number[]][] = [
  ['Mapping app (city centroid)', err.baseline],
  ['Wusool - cold, text only', err.cold],
  [`Wusool - after ONE pin`, err.warm],
];

console.log('                                median      p90    <=100m   <=250m   <=500m');
console.log('                                ------   ------    ------   ------   ------');
for (const [label, a] of rows) {
  console.log(
    label.padEnd(30) +
    m(pct(a, 0.5)) + ' ' + m(pct(a, 0.9)) + '   ' +
    (within(a, 100) * 100).toFixed(0).padStart(4) + '%   ' +
    (within(a, 250) * 100).toFixed(0).padStart(4) + '%   ' +
    (within(a, 500) * 100).toFixed(0).padStart(4) + '%');
}

const tierLine = (t: Record<number, number>) =>
  [1, 2, 3, 4].map(k => `T${k}:${t[k] ?? 0}`).join('  ');
console.log(`\ntiers  cold   ${tierLine(coldTiers)}`);
console.log(`tiers  warm   ${tierLine(warmTiers)}`);

const medCold = pct(err.cold, 0.5), medWarm = pct(err.warm, 0.5);
const medBase = pct(err.baseline, 0.5);
console.log(`\nheadline: one customer tap moves the median error from ` +
  `${Math.round(medCold)} m to ${Math.round(medWarm)} m ` +
  `(${(medCold / Math.max(medWarm, 1)).toFixed(0)}x better), ` +
  `against ${Math.round(medBase)} m for a city-centroid geocode.`);
console.log(`every later order to that building inherits it — nobody pins twice.`);

/* Publish the result so the dashboard can show a measured number instead of a
   claim. Written next to the seed data and committed, because the benchmark
   runs against a scratch database that the demo machine will not have. */
const report = {
  measured_at: new Date().toISOString().slice(0, 10),
  sample_size: samples.length,
  excluded: { duplicate_name: skippedDup, single_phrasing: skippedThin },
  pin_error_m: PIN_ERROR_M,
  rows: rows.map(([label, a]) => ({
    label,
    median_m: Math.round(pct(a, 0.5)),
    p90_m: Math.round(pct(a, 0.9)),
    within_100m: +within(a, 100).toFixed(3),
    within_250m: +within(a, 250).toFixed(3),
    within_500m: +within(a, 500).toFixed(3),
  })),
  tiers: { cold: coldTiers, warm: warmTiers },
};
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'accuracy.json');
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nwrote ${OUT} — the dashboard reads this.`);

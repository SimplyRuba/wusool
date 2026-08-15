import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, insert, run, resetAll, DB_PATH } from '../db/index.ts';
import { normalizeArabic } from '../lib/arabic.ts';
import { phoneHash, haversine } from '../lib/geo.ts';
import { addAlias } from '../services/entities.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => JSON.parse(readFileSync(join(HERE, f), 'utf8'));

/* Deterministic RNG so every seed produces the same demo numbers. */
let s = 20260815;
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const jitter = (v: number, m: number) => v + (rnd() - 0.5) * m;

console.log('seeding ->', DB_PATH);
resetAll();

/* ---------- 1 · checkpoints ---------- */
const cps = read('checkpoints.json') as any[];
for (const c of cps)
  insert(`INSERT INTO checkpoints (name_ar, name_en, lat, lng, aliases) VALUES (?,?,?,?,?)`,
         c.name_ar, c.name_en, c.lat, c.lng, JSON.stringify(c.aliases ?? []));
console.log(`  checkpoints: ${cps.length}`);

/* ---------- 2 · landmarks from the OSM extract ----------
   Built by `npm run osm` from a live Overpass query, then committed. Curated
   anchors were hand-checked against satellite imagery and outrank OSM, so
   they carry a higher starting confidence. */
const lms = read('landmarks.ramallah.json') as any[];
const entityIdByName = new Map<string, number>();
let aliasCount = 0;
for (const l of lms) {
  const conf = l.source === 'curated' ? 0.85 : 0.7;
  const id = insert(
    `INSERT INTO entities (kind, canonical_name, lat, lng, source, confidence)
     VALUES (?,?,?,?,?,?)`, l.kind, l.name, l.lat, l.lng, l.source ?? 'osm', conf);
  for (const a of (l.aliases?.length ? l.aliases : [l.name, l.name_en])) {
    if (a) { addAlias(id, a); aliasCount++; }
  }
  entityIdByName.set(l.name, id);
}
const nCur = lms.filter(l => l.source === 'curated').length;
console.log(`  landmark entities: ${lms.length} (${nCur} curated, ${lms.length - nCur} OSM) / ${aliasCount} aliases`);

/* ---------- 3 · synthetic delivery history ----------
   40 buildings near real landmarks, 2-12 orders each, each order phrased
   differently, all delivery_verified. This is what gives tier 1/2 something to
   hit and what makes the dashboard's learning curve real rather than drawn.

   DEMO BUILDING EXCLUDED: "عمارة زيدان" is deliberately absent. It has to be
   learned live on stage, otherwise the neighbour-effect moment is a replay. */
const DEMO_BUILDING = 'عمارة زيدان';

const BUILDING_STEMS = ['عمارة','بناية','برج','مجمع'];
/* 'زيدان' is deliberately absent: the demo building must be genuinely unknown
   until it is learned live on stage. */
const FAMILY = ['النتشة','الحاج','عبد الهادي','شحادة','الطويل','الجعبري','قنديل','ياسين',
                'الشريف','أبو ديّة','حمدان','السلطان','الخطيب','مرار','دار صالح','العمري','نصار'];
const AREAS = ['التحتا','الطيرة','الماصيون','عين مصباح','بطن الهوى','الإرسال','الشرفة','المصايف'];
const TEMPLATES = [
  (b: string, l: string) => `رام الله، قرب ${l}، ${b}`,
  (b: string, l: string) => `رام الله، جنب ${l}، ${b}، الطابق الثاني`,
  (b: string, l: string) => `رام الله، خلف ${l}، ${b}`,
  (b: string, l: string) => `رام الله، ${b}، مقابل ${l}، ط٣`,
  (b: string, l: string) => `رام الله، بعد ${l} على طول، ${b}`,
  (b: string, l: string) => `${b} فوق ${l} رام الله الطابق الرابع`,
];

/* The OSM pull covers the whole delivery zone out to Birzeit and Jifna, but
   the synthetic history belongs to ONE merchant in central Ramallah. Anchoring
   fake deliveries in Jifna would scatter the fleet map across the West Bank and
   make the dashboard read as noise. 3.5 km around Al-Manara is the real
   catchment. */
const RAMALLAH = { lat: 31.90332, lng: 35.20583 };            // دوار المنارة
const km = (a: any) => haversine(RAMALLAH.lat, RAMALLAH.lng, a.lat, a.lng) / 1000;
const realLandmarks = lms.filter(l => l.kind === 'landmark' && km(l) <= 3.5);
console.log(`  ${realLandmarks.length} landmarks within 3.5 km of Al-Manara anchor the synthetic history`);
let orders = 0, addresses = 0, openOrders = 0;

for (let i = 0; i < 40; i++) {
  const name = `${pick(BUILDING_STEMS)} ${pick(FAMILY)}`;
  if (normalizeArabic(name) === normalizeArabic(DEMO_BUILDING)) continue;

  const anchor = pick(realLandmarks);
  const lat = jitter(anchor.lat, 0.0016);
  const lng = jitter(anchor.lng, 0.0016);

  const bId = insert(
    `INSERT INTO entities (kind, canonical_name, lat, lng, source, confidence, confirmations)
     VALUES ('building', ?, ?, ?, 'learned', ?, ?)`,
    name, lat, lng, 0.55 + rnd() * 0.3, 2 + Math.floor(rnd() * 6));
  addAlias(bId, name);

  const n = 2 + Math.floor(rnd() * 11);
  for (let k = 0; k < n; k++) {
    const phone = `059${(1000000 + Math.floor(rnd() * 8999999))}`;
    const raw = pick(TEMPLATES)(name, anchor.name);
    const aLat = jitter(lat, 0.00025), aLng = jitter(lng, 0.00025);
    const aId = insert(
      `INSERT INTO addresses
        (phone_hash, raw_text, normalized_text, lat, lng, building_entity_id,
         status, verified_count, official_neighborhood)
       VALUES (?,?,?,?,?,?, 'delivery_verified', ?, ?)`,
      phoneHash(phone), raw, normalizeArabic(raw), aLat, aLng, bId,
      1 + Math.floor(rnd() * 3), pick(AREAS));
    addresses++;

    const rId = insert(
      `INSERT INTO resolutions
        (raw_text, phone_hash, parsed_json, engine, tier, matched_address_id,
         matched_entity_ids, lat, lng, confidence, status)
       VALUES (?,?,?, 'rules', ?, ?, ?, ?, ?, ?, 'resolved')`,
      raw, phoneHash(phone), JSON.stringify({ building: name, city: 'رام الله' }),
      rnd() < 0.55 ? 2 : rnd() < 0.7 ? 1 : 3, aId, JSON.stringify([bId]),
      aLat, aLng, 0.78 + rnd() * 0.2);

    insert(
      `INSERT INTO orders (items_json, phone, raw_address, resolution_id, address_id, status)
       VALUES (?,?,?,?,?, 'delivered')`,
      JSON.stringify([{ name: 'طلب', qty: 1 }]), phone, raw, rId, aId);
    orders++;
    // leave a handful open so the driver screen has a real manifest
    if (openOrders < 5 && k === 0 && i % 7 === 3) {
      const oId = insert(
        `INSERT INTO orders (items_json, phone, raw_address, resolution_id, address_id, status)
         VALUES (?,?,?,?,?, 'ready')`,
        JSON.stringify([{ name: 'طلب', qty: 1 }]), phone, raw, rId, aId);
      openOrders++;
    }
  }
}
console.log(`  synthetic: ${addresses} addresses / ${orders} delivered + ${openOrders} open orders across 40 buildings`);
console.log(`  demo building "${DEMO_BUILDING}" intentionally NOT seeded - it is learned live`);

/* ---------- 4 · a little live road chatter so the map is not empty ---------- */
const cpRows = db.prepare('SELECT id, name_ar FROM checkpoints').all() as any[];
const seedEvents: [string, 'open'|'congested'|'closed', 'telegram'|'driver'|'whatsapp', number][] = [
  ['حاجز قلنديا', 'congested', 'telegram', 25],
  ['حاجز قلنديا', 'congested', 'driver', 12],
  ['حاجز الكونتينر', 'closed', 'telegram', 40],
  ['حاجز الكونتينر', 'closed', 'whatsapp', 18],
  ['حاجز عطارة', 'open', 'driver', 8],
  ['حاجز جبع', 'open', 'telegram', 95],
  ['حاجز حوارة', 'congested', 'telegram', 55],
];
for (const [nm, st, src, agoMin] of seedEvents) {
  const cp = cpRows.find(c => c.name_ar === nm);
  if (!cp) continue;
  run(`INSERT INTO road_events (checkpoint_id, status, source, raw_text, reported_at)
       VALUES (?,?,?,?,?)`, cp.id, st, src, null, Date.now() - agoMin * 60000);
}
console.log(`  road events: ${seedEvents.length}`);

console.log('seed complete.');

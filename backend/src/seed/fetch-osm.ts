/**
 * Pull every named feature in the Ramallah / Al-Bireh delivery zone from
 * OpenStreetMap and write the landmark seed file.
 *
 *   npm run osm          # needs internet, run once, commit the result
 *
 * WHY A SCRIPT AND NOT A LIVE CALL: Overpass rate-limits hard and the venue
 * wifi cannot be trusted. This runs once, the JSON is committed, and the demo
 * machine never talks to Overpass again.
 *
 * WHAT SURVIVES THE FILTER: only things a person would actually say out loud
 * in an address — "قرب مسجد X", "جنب سوبرماركت Y", "خلف مدرسة Z". A feature
 * whose name is purely generic ("Supermarket", "مسجد", "Church") is dropped:
 * it carries no identity, so it can only ever produce a wrong match.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArabic } from '../lib/arabic.ts';
import { distinctiveTokens, distinctiveKey } from '../lib/placename.ts';
import { haversine } from '../lib/geo.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'landmarks.ramallah.json');
const CURATED = join(HERE, 'landmarks.curated.json');

/* Ramallah + Al-Bireh + Beitunia + Kufr Aqab + Qalandia + Jifna + Birzeit.
   This is the real service area, not just the two city centres. */
const BBOX = [31.85, 35.13, 32.00, 35.28] as const;   // S, W, N, E

const QUERY = `[out:json][timeout:120];
(
  node["name"](${BBOX.join(',')});
  way["name"]["building"](${BBOX.join(',')});
  way["name"]["amenity"](${BBOX.join(',')});
  way["name"]["shop"](${BBOX.join(',')});
  way["name"]["leisure"](${BBOX.join(',')});
);
out center tags;`;

/* ------------------------------------------------------------------ *
 * Classification. Anything not listed here is dropped.
 * ------------------------------------------------------------------ */

/** Public reference points — the things addresses are given relative to. */
const LANDMARK: Record<string, Set<string>> = {
  amenity: new Set([
    'place_of_worship', 'school', 'university', 'college', 'kindergarten',
    'hospital', 'clinic', 'doctors', 'dentist', 'pharmacy', 'veterinary',
    'bank', 'bureau_de_change', 'post_office', 'police', 'fire_station',
    'townhall', 'courthouse', 'prison', 'library', 'marketplace',
    'bus_station', 'taxi', 'fuel', 'charging_station', 'car_wash',
    'restaurant', 'cafe', 'fast_food', 'ice_cream', 'bar', 'pub',
    'cinema', 'theatre', 'community_centre', 'social_facility',
    'public_building', 'exhibition_centre', 'conference_centre',
  ]),
  shop: new Set([
    'supermarket', 'convenience', 'mall', 'department_store', 'bakery',
    'butcher', 'greengrocer', 'pastry', 'confectionery', 'hardware',
    'doityourself', 'furniture', 'electronics', 'mobile_phone', 'car',
    'car_repair', 'tyres', 'clothes', 'shoes', 'jewelry', 'optician',
    'books', 'stationery', 'florist', 'sports', 'toys',
  ]),
  leisure: new Set(['park', 'garden', 'stadium', 'sports_centre', 'pitch',
    'fitness_centre', 'swimming_pool', 'playground']),
  tourism: new Set(['hotel', 'hostel', 'guest_house', 'museum', 'attraction',
    'gallery', 'viewpoint']),
  office: new Set(['government', 'diplomatic', 'ngo', 'insurance', 'lawyer',
    'telecommunication', 'newspaper']),
  healthcare: new Set(['centre', 'hospital', 'clinic', 'pharmacy']),
  historic: new Set(['ruins', 'monument', 'memorial', 'archaeological_site']),
  building: new Set(['church', 'mosque', 'cathedral', 'chapel', 'university',
    'hospital', 'school', 'college', 'commercial', 'retail', 'civic',
    'government', 'stadium', 'public', 'kindergarten', 'train_station']),
  highway: new Set(['mini_roundabout']),
  junction: new Set(['yes', 'roundabout', 'circular']),
  man_made: new Set(['tower', 'water_tower', 'lighthouse']),
};

/** Named buildings people actually live in — tier 2's raw material. */
const BUILDING: Record<string, Set<string>> = {
  building: new Set(['apartments', 'residential', 'house', 'dormitory',
    'terrace', 'tower', 'yes', 'detached', 'semidetached_house']),
  tourism: new Set(['apartment']),
};

/** Arabic words that mark a name as a residential building even if OSM
    tagged it `building=yes` with no further detail. */
const BUILDING_WORDS = ['عماره', 'بنايه', 'برج', 'مجمع', 'دار', 'مساكن', 'اسكان'];

type Tags = Record<string, string>;

function classify(t: Tags, canonical: string): 'landmark' | 'building' | null {
  for (const [k, vals] of Object.entries(LANDMARK))
    if (t[k] && vals.has(t[k])) return 'landmark';

  const norm = normalizeArabic(canonical);
  if (BUILDING_WORDS.some(w => norm.includes(w))) return 'building';

  for (const [k, vals] of Object.entries(BUILDING))
    if (t[k] && vals.has(t[k])) {
      /* `building=yes` with no residential signal is usually a shed, a shop
         annexe or an unclassified footprint. Too noisy to keep. */
      if (k === 'building' && t[k] === 'yes') return null;
      return 'building';
    }
  return null;
}

/* ------------------------------------------------------------------ *
 * Name selection
 * ------------------------------------------------------------------ */
const hasArabic = (s: string) => /[؀-ۿ]/.test(s);

function names(t: Tags): { canonical: string; en: string | null; aliases: string[] } | null {
  const raw = [t['name:ar'], t.name, t['name:en'], t.alt_name, t['alt_name:ar'],
               t.official_name, t.short_name]
    .filter((x): x is string => !!x && x.trim().length > 1)
    .map(x => x.trim());
  if (!raw.length) return null;

  /* Prefer an Arabic name: this is what customers type. Fall back to the
     Latin one, which still resolves for English input and for the many
     Ramallah businesses that only ever advertise in English. */
  const canonical = raw.find(hasArabic) ?? raw[0];
  const en = raw.find(x => !hasArabic(x)) ?? null;

  /* A name made only of generic stems identifies nothing. "Supermarket",
     "مسجد", "Church" — matching on these sends drivers to whichever one the
     database happened to store first. */
  if (!distinctiveTokens(canonical).length) return null;

  const aliases = [...new Set(raw.map(x => x.trim()))];
  return { canonical, en, aliases };
}

/* ------------------------------------------------------------------ *
 * Fetch, classify, dedup, write
 * ------------------------------------------------------------------ */
type Seed = {
  name: string; name_en: string | null; kind: 'landmark' | 'building';
  lat: number; lng: number; aliases: string[]; source: 'osm' | 'curated';
  osm?: string;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function overpass(): Promise<any[]> {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
  ];
  let lastErr: unknown = null;

  /* Two passes over the mirrors. Overpass answers 429 when a slot is busy,
     which clears in a few seconds — worth waiting for rather than failing
     the whole seed. `data=` form encoding is required: a bare POST body is
     rejected with 406. */
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of endpoints) {
      try {
        console.log(`  querying ${new URL(url).host} …`);
        const r = await fetch(url, {
          method: 'POST',
          /* Overpass answers 406 to Node's default fetch headers. It wants a
             self-identifying User-Agent (their usage policy asks for one) and
             an explicit Accept. Without both, every request is refused. */
          headers: {
            'User-Agent': 'wusool-seed/1.0 (smart addressing prototype; Palestine)',
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ data: QUERY }),
        });
        if (r.status === 429 || r.status === 504) throw new Error(`HTTP ${r.status} (busy)`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as { elements: any[] };
        return j.elements ?? [];
      } catch (e) {
        console.warn(`  ${new URL(url).host} failed: ${(e as Error).message}`);
        lastErr = e;
      }
    }
    if (attempt === 0) { console.log('  all mirrors busy, waiting 20s …'); await sleep(20_000); }
  }
  throw lastErr;
}

const elements = await overpass();
console.log(`  ${elements.length} named elements returned`);

const kept: Seed[] = [];
let dropped = 0, generic = 0, noCoord = 0;

for (const el of elements) {
  const t: Tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) { noCoord++; continue; }

  const nm = names(t);
  if (!nm) { generic++; continue; }

  const kind = classify(t, nm.canonical);
  if (!kind) { dropped++; continue; }

  kept.push({
    name: nm.canonical, name_en: nm.en, kind,
    lat: +lat.toFixed(6), lng: +lng.toFixed(6),
    aliases: nm.aliases, source: 'osm',
    osm: `${el.type}/${el.id}`,
  });
}
console.log(`  kept ${kept.length}  (dropped ${dropped} untagged, ${generic} generic-named, ${noCoord} without coordinates)`);

/* ---- curated anchors win ----------------------------------------------
   The hand-verified downtown landmarks were checked against satellite
   imagery one by one. Where OSM has the same place, the curated coordinate
   is the one to trust, because OSM nodes for large mosques and squares are
   often dropped on a corner of the footprint rather than the entrance. */
let curated: Seed[] = [];
if (existsSync(CURATED)) {
  curated = (JSON.parse(readFileSync(CURATED, 'utf8')) as any[]).map(c => ({
    name: c.name, name_en: c.name_en ?? null, kind: c.kind,
    lat: c.lat, lng: c.lng,
    aliases: [c.name, c.name_en].filter(Boolean) as string[],
    source: 'curated' as const,
  }));
  console.log(`  ${curated.length} curated anchors take priority`);
}

/* ---- dedup ------------------------------------------------------------
   Two entries are the same place when their distinctive tokens match AND
   they sit within 200 m. The distance test matters: Ramallah genuinely has
   several "مسجد عمر بن الخطاب", and merging them would average their
   positions into a point that is near neither. */
const out: Seed[] = [];
const byKey = new Map<string, Seed[]>();
let merged = 0;

for (const s of [...curated, ...kept]) {
  const key = distinctiveKey(s.name);
  const bucket = byKey.get(key);
  if (bucket) {
    const near = bucket.find(b => haversine(b.lat, b.lng, s.lat, s.lng) < 200);
    if (near) {
      for (const a of s.aliases) if (!near.aliases.includes(a)) near.aliases.push(a);
      merged++;
      continue;
    }
    bucket.push(s);
  } else {
    byKey.set(key, [s]);
  }
  out.push(s);
}
console.log(`  merged ${merged} duplicates -> ${out.length} entities`);

const counts = out.reduce<Record<string, number>>((a, s) => {
  a[s.kind] = (a[s.kind] ?? 0) + 1; return a;
}, {});
console.log(`  landmarks: ${counts.landmark ?? 0}   buildings: ${counts.building ?? 0}`);

writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n', 'utf8');
console.log(`wrote ${OUT}`);
console.log('run `npm run seed` to load it.');

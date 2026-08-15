/**
 * Check the hand-entered checkpoint coordinates against OpenStreetMap.
 *
 *   npm run checkpoints          # report only
 *   npm run checkpoints -- --fix # rewrite checkpoints.json with OSM positions
 *
 * WHY THIS EXISTS: checkpoints.json was typed from memory. A checkpoint in the
 * wrong place is worse than a missing one — the router will happily avoid a
 * closure that is 3 km from the actual road, send the driver through the real
 * one, and report success. Every coordinate the demo relies on should be
 * traceable to a source.
 *
 * OSM is not authoritative either, so this NEVER moves a checkpoint more than
 * MAX_CORRECTION_M. A larger disagreement means the two are probably different
 * places, and a human has to look.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArabic } from '../lib/arabic.ts';
import { haversine } from '../lib/geo.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'checkpoints.json');
const FIX = process.argv.includes('--fix');

/** Beyond this, assume it is a different place and refuse to "correct" it. */
const MAX_CORRECTION_M = 8000;
/** Below this the hand-entered value is already good enough. */
const OK_M = 250;

/** Search radius around each hand-entered coordinate. */
const RADIUS_M = 4000;

/**
 * Query per checkpoint, by PROXIMITY rather than by name over a huge bbox.
 *
 * WHY NOT ONE BIG NAME QUERY: Overpass's `["name"~...]` matches the `name` key
 * only. At Qalandia the crossing is tagged `name:ar="حاجز قلنديا"` with a
 * Hebrew `name`, so an Arabic name regex silently missed it — and the script
 * then "matched" مدرسة بنات قلنديا, a girls' school 650 m away. Searching a
 * radius around the coordinate we already have avoids depending on which key
 * happens to hold the Arabic.
 */
const queryFor = (lat: number, lng: number) => `[out:json][timeout:60];
(
  node["barrier"~"^(border_control|checkpoint)$"](around:${RADIUS_M},${lat},${lng});
  way["barrier"~"^(border_control|checkpoint)$"](around:${RADIUS_M},${lat},${lng});
  node["military"="checkpoint"](around:${RADIUS_M},${lat},${lng});
  way["military"="checkpoint"](around:${RADIUS_M},${lat},${lng});
  node["amenity"="border_control"](around:${RADIUS_M},${lat},${lng});
  node["name:ar"~"حاجز|معبر"](around:${RADIUS_M},${lat},${lng});
  way["name:ar"~"حاجز|معبر"](around:${RADIUS_M},${lat},${lng});
  node["name"~"حاجز|معبر|Checkpoint|Crossing",i](around:${RADIUS_M},${lat},${lng});
  way["name"~"حاجز|معبر|Checkpoint|Crossing",i](around:${RADIUS_M},${lat},${lng});
);
out center tags;`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

/**
 * One query, with backoff. Overpass answers 429 when its slots are busy and
 * that is the normal state of the public instance — eight queries in a row
 * will hit it. Backing off and rotating mirrors is the difference between a
 * script that works and one that reports everything as unverified.
 */
async function fetchAround(lat: number, lng: number): Promise<any[]> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'wusool-seed/1.0 (smart addressing prototype; Palestine)',
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ data: queryFor(lat, lng) }),
      });
      if (res.status === 429 || res.status === 504) throw new Error(`HTTP ${res.status} busy`);
      if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
      return ((await res.json()) as { elements: any[] }).elements ?? [];
    } catch (e) {
      lastErr = e;
      await sleep(5000 * (attempt + 1));          // 5s, 10s, 15s
    }
  }
  throw lastErr;
}

type Cand = { names: string[]; lat: number; lng: number; tagged: boolean };

/* A candidate must either be TAGGED as a checkpoint or SAY it is one — the
   name-based part of the query still drags in schools and mosques named after
   the same village. */
const CHECKPOINT_WORD = /حاجز|معبر|نقطه تفتيش|نقطة تفتيش|checkpoint|crossing|terminal|מחסום|מעבר/i;

/* Checkpoint names are short and highly distinctive ("قلنديا", "حوارة"), so a
   substring test on the normalised form beats fuzzy scoring here. */
const keyOf = (s: string) => normalizeArabic(s).replace(/^(حاجز|معبر|نقطه تفتيش|مفرق)\s+/, '');

const cps = JSON.parse(readFileSync(FILE, 'utf8')) as any[];
let fixed = 0, ok = 0, unverified = 0;

for (const [i, cp] of cps.entries()) {
  if (i) await sleep(2000);                       // Overpass usage policy
  const label = `${cp.name_ar}`.padEnd(24);

  let elements: any[];
  try { elements = await fetchAround(cp.lat, cp.lng); }
  catch (e) { console.log(`  ?  ${label} query failed: ${(e as Error).message}`); unverified++; continue; }

  const cands: Cand[] = [];
  for (const e of elements) {
    const t = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    if (lat == null) continue;
    const names = [t['name:ar'], t.name, t['name:en'], t.alt_name]
      .filter((x): x is string => !!x);
    const tagged = ['border_control', 'checkpoint'].includes(t.barrier)
      || t.military === 'checkpoint' || t.amenity === 'border_control';
    if (!tagged && !names.some(n => CHECKPOINT_WORD.test(n))) continue;
    cands.push({ names, lat, lng, tagged });
  }

  const keys = [cp.name_ar, cp.name_en, ...(cp.aliases ?? [])]
    .filter(Boolean).map(keyOf).filter(k => k.length >= 3);

  /* 1 — a feature that carries this checkpoint's own name. Strongest evidence. */
  let best: { lat: number; lng: number; d: number; why: string } | null = null;
  for (const c of cands) {
    if (!c.names.some(n => { const nk = keyOf(n); return keys.some(k => nk.includes(k) || k.includes(nk)); }))
      continue;
    const d = haversine(cp.lat, cp.lng, c.lat, c.lng);
    if (!best || d < best.d) best = { lat: c.lat, lng: c.lng, d, why: `"${c.names[0]}"` };
  }

  /* 2 — no name match, but a cluster of border-control nodes. That cluster IS
     the physical crossing; a lone gate node is not, so require several. */
  if (!best) {
    const tagged = cands.filter(c => c.tagged);
    if (tagged.length >= 3) {
      const lat = tagged.reduce((s, c) => s + c.lat, 0) / tagged.length;
      const lng = tagged.reduce((s, c) => s + c.lng, 0) / tagged.length;
      best = { lat, lng, d: haversine(cp.lat, cp.lng, lat, lng),
               why: `centroid of ${tagged.length} border-control nodes` };
    }
  }

  if (!best) {
    console.log(`  ?  ${label} nothing checkpoint-like within ${RADIUS_M / 1000} km — unverified`);
    unverified++;
  } else if (best.d <= OK_M) {
    console.log(`  ok ${label} agrees with OSM within ${Math.round(best.d)} m  ${best.why}`);
    ok++;
  } else if (best.d > MAX_CORRECTION_M) {
    console.log(`  !  ${label} nearest match ${(best.d / 1000).toFixed(1)} km away — NOT changed`);
    unverified++;
  } else {
    console.log(`  -> ${label} off by ${Math.round(best.d)} m  ` +
                `${cp.lat.toFixed(5)},${cp.lng.toFixed(5)} -> ${best.lat.toFixed(5)},${best.lng.toFixed(5)}  ${best.why}`);
    if (FIX) { cp.lat = +best.lat.toFixed(5); cp.lng = +best.lng.toFixed(5); cp.source = 'osm'; }
    fixed++;
  }
}

console.log(`\n${ok} already correct · ${fixed} ${FIX ? 'corrected' : 'need correction'} · ${unverified} unverified`);
if (FIX && fixed) {
  writeFileSync(FILE, JSON.stringify(cps, null, 2) + '\n', 'utf8');
  console.log(`wrote ${FILE} — re-run \`npm run seed\`.`);
} else if (fixed) {
  console.log('re-run with `-- --fix` to apply.');
}

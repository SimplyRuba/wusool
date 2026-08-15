import type { LineString, RouteResult } from '../contract.ts';
import { distanceToLine, haversine } from '../lib/geo.ts';
import { checkpointStates } from './roads.ts';

const OSRM = process.env.OSRM_URL ?? 'https://router.project-osrm.org';
const NEAR_M = 250;
const PENALTY = { closed: 3600, congested: 900, open: 0 } as const;

const cache = new Map<string, RouteResult>();
const keyOf = (a: number, b: number, c: number, d: number) =>
  [a, b, c, d].map(n => n.toFixed(5)).join(',');

const straightLine = (aLat: number, aLng: number, bLat: number, bLng: number): RouteResult => {
  const geom: LineString = { type: 'LineString', coordinates: [[aLng, aLat], [bLng, bLat]] };
  const dist = haversine(aLat, aLng, bLat, bLng);
  return { chosen: geom, duration_s: Math.round(dist / 8.3), penalty_s: 0,
           distance_m: Math.round(dist), rejected: [], source: 'straight-line' };
};

/** Penalty in seconds for every live closure this geometry passes near. */
function scoreRoute(geom: LineString) {
  let penalty = 0; let worst: { name: string; pen: number } | null = null;
  for (const cp of checkpointStates()) {
    if (cp.status === 'open') continue;
    if (distanceToLine(cp.lat, cp.lng, geom.coordinates) > NEAR_M) continue;
    const pen = PENALTY[cp.status];
    penalty += pen;
    if (!worst || pen > worst.pen) worst = { name: cp.name_ar, pen };
  }
  return { penalty, worst };
}

/**
 * OSRM alternatives scored against live checkpoint status. The rejected routes are
 * returned too — the driver screen shows the road it did NOT take and names the
 * closure that ruled it out, which is the whole story of this feature.
 */
export async function getRoute(aLat: number, aLng: number, bLat: number, bLng: number): Promise<RouteResult> {
  const k = keyOf(aLat, aLng, bLat, bLng);
  const hit = cache.get(k);
  if (hit) return { ...hit, source: 'cache' };

  let routes: any[] = [];
  try {
    const url = `${OSRM}/route/v1/driving/${aLng},${aLat};${bLng},${bLat}` +
                `?alternatives=true&overview=full&geometries=geojson`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'wusool-demo/1.0' } });
    clearTimeout(timer);
    const j: any = await r.json();
    if (j?.code === 'Ok') routes = j.routes ?? [];
  } catch { /* offline or OSRM down - straight line keeps the demo alive */ }

  if (!routes.length) return straightLine(aLat, aLng, bLat, bLng);

  const scored = routes.map((rt: any) => {
    const geom = rt.geometry as LineString;
    const { penalty, worst } = scoreRoute(geom);
    return { geom, duration: rt.duration as number, distance: rt.distance as number, penalty, worst };
  }).sort((x, y) => (x.duration + x.penalty) - (y.duration + y.penalty));

  const best = scored[0];
  const out: RouteResult = {
    chosen: best.geom,
    duration_s: Math.round(best.duration),
    penalty_s: best.penalty,
    distance_m: Math.round(best.distance),
    rejected: scored.slice(1).map(s => ({
      geometry: s.geom,
      blocked_by: s.worst?.name ?? 'slower alternative',
      penalty_s: s.penalty,
    })),
    source: 'osrm',
  };
  cache.set(k, out);
  return out;
}

export const warmRoute = getRoute;

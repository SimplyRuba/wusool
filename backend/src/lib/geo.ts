import { createHash } from 'node:crypto';

export const R_EARTH = 6371008.8;

export function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

export type Pt = { lat: number; lng: number; weight?: number };

export function weightedCentroid(pts: Pt[]): { lat: number; lng: number } | null {
  if (!pts.length) return null;
  let wsum = 0, lat = 0, lng = 0;
  for (const p of pts) { const w = p.weight ?? 1; wsum += w; lat += p.lat * w; lng += p.lng * w; }
  return { lat: lat / wsum, lng: lng / wsum };
}

/** Largest pairwise distance in metres — how spread out the evidence is. */
export function spread(pts: Pt[]): number {
  let m = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      m = Math.max(m, haversine(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng));
  return m;
}

/** Shortest distance from a point to a polyline of [lng,lat] pairs, in metres. */
export function distanceToLine(lat: number, lng: number, line: [number, number][]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = line[i - 1], [x2, y2] = line[i];
    const k = Math.cos((lat * Math.PI) / 180);
    const ax = (x1 - lng) * k, ay = y1 - lat;
    const bx = (x2 - lng) * k, by = y2 - lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const deg = Math.sqrt(px * px + py * py);
    best = Math.min(best, deg * 111320);
  }
  return best;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const phoneHash = (phone: string) => sha256('wusool:' + phone.replace(/\D/g, ''));
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

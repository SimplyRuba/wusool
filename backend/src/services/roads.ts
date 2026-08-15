import type { CheckpointState, CheckpointStatus, RoadEvent } from '../contract.ts';
import { all, get, insert } from '../db/index.ts';
import { normalizeArabic } from '../lib/arabic.ts';
import { samePlace } from '../lib/placename.ts';

export type Checkpoint = {
  id: number; name_ar: string; name_en: string; lat: number; lng: number; aliases: string | null;
};

const SOURCE_WEIGHT: Record<string, number> = { driver: 0.5, telegram: 0.35, whatsapp: 0.3 };
const HALF_LIFE_MIN = 90;
const WINDOW_MS = 6 * 60 * 60 * 1000;

export const listCheckpoints = () => all<Checkpoint>('SELECT * FROM checkpoints ORDER BY id');

/**
 * Current status by evidence weight: source credibility multiplied by freshness
 * decay exp(-ageMinutes / 90).
 *
 * SPEC FIX — reported_at is stored as epoch milliseconds, not a SQLite
 * datetime('now') string. datetime('now') is UTC while Palestine runs UTC+3, so
 * comparing it against a local-time clock made every report look 180 minutes old,
 * decayed its weight to ~0.14, and silently marked every checkpoint "assumed".
 */
export function currentStatus(cpId: number): { status: CheckpointStatus; stalenessMin: number; assumed: boolean } {
  const now = Date.now();
  const evs = all<{ status: string; source: string; reported_at: number }>(
    `SELECT status, source, reported_at FROM road_events
      WHERE checkpoint_id = ? AND reported_at >= ?
      ORDER BY reported_at DESC`, cpId, now - WINDOW_MS);

  if (!evs.length) return { status: 'open', stalenessMin: Infinity, assumed: true };

  const score: Record<string, number> = { open: 0, congested: 0, closed: 0 };
  for (const e of evs) {
    const ageMin = (now - e.reported_at) / 60000;
    score[e.status] = (score[e.status] ?? 0) +
      (SOURCE_WEIGHT[e.source] ?? 0.3) * Math.exp(-ageMin / HALF_LIFE_MIN);
  }
  const status = (Object.entries(score).sort((a, b) => b[1] - a[1])[0][0]) as CheckpointStatus;
  const stalenessMin = Math.round((now - evs[0].reported_at) / 60000);
  return { status, stalenessMin, assumed: false };
}

export function checkpointStates(): CheckpointState[] {
  return listCheckpoints().map(c => {
    const s = currentStatus(c.id);
    return {
      id: c.id, name_ar: c.name_ar, name_en: c.name_en, lat: c.lat, lng: c.lng,
      status: s.status, staleness_min: Number.isFinite(s.stalenessMin) ? s.stalenessMin : -1,
      assumed: s.assumed,
    };
  });
}

/** Fuzzy-match a place name from a community post onto a seeded checkpoint. */
export function matchCheckpoint(place: string): Checkpoint | null {
  const n = normalizeArabic(place);
  if (!n) return null;
  let best: { cp: Checkpoint; score: number } | null = null;
  for (const cp of listCheckpoints()) {
    const names = [cp.name_ar, cp.name_en, ...(cp.aliases ? JSON.parse(cp.aliases) : [])];
    for (const nm of names) {
      const nn = normalizeArabic(nm);
      if (!nn) continue;
      let score = 0;
      if (n === nn || n.includes(nn) || nn.includes(n)) score = 1;
      else score = samePlace(n, nn).same ? samePlace(n, nn).score : 0;
      if (score >= 0.6 && (!best || score > best.score)) best = { cp, score };
    }
  }
  return best?.cp ?? null;
}

export function recordEvent(cpId: number, status: CheckpointStatus,
                            source: 'telegram'|'whatsapp'|'driver', rawText: string | null) {
  return insert(
    `INSERT INTO road_events (checkpoint_id, status, source, raw_text, reported_at)
     VALUES (?,?,?,?,?)`, cpId, status, source, rawText, Date.now());
}

export function recentEvents(limit = 20): RoadEvent[] {
  return all<any>(
    `SELECT r.id, c.name_ar AS checkpoint, r.status, r.source, r.raw_text, r.reported_at
       FROM road_events r LEFT JOIN checkpoints c ON c.id = r.checkpoint_id
      ORDER BY r.reported_at DESC LIMIT ?`, limit)
    .map(r => ({ ...r, reported_at: new Date(r.reported_at).toISOString() }));
}

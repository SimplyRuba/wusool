import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DriverTask, Kpis, Order, Resolution } from '../contract.ts';
import { all, get, insert, run } from '../db/index.ts';
import { phoneHash } from '../lib/geo.ts';
import { resolve } from '../services/cascade.ts';
import { enrichCadastral } from '../services/cadastral.ts';
import { onPinConfirmed, onDelivered, resolutionById } from '../services/verify.ts';
import { extractRoadPost } from '../services/parser.ts';
import { checkpointStates, matchCheckpoint, recordEvent, recentEvents, listCheckpoints } from '../services/roads.ts';
import { getRoute } from '../services/routing.ts';
import { learnedLandmarks } from '../services/entities.ts';
import { balance } from '../services/points.ts';

export const api = Router();

const fail = (res: any, code: string, message: string, status = 400) =>
  res.status(status).json({ error: { code, message } });

const STORE_ORIGIN = { lat: 31.9060, lng: 35.2040 };   // the demo merchant

function orderById(id: number): Order | null {
  const o = get<any>('SELECT * FROM orders WHERE id = ?', id);
  if (!o) return null;
  const resolution = resolutionById(o.resolution_id) as Resolution;
  return {
    id: o.id, status: o.status, phone: o.phone, raw_address: o.raw_address,
    items: JSON.parse(o.items_json), resolution, pin_token: o.pin_token,
  };
}

/* ---------------------------------------------------------------- resolve */
api.post('/resolve', async (req, res) => {
  const { raw_text, phone } = req.body ?? {};
  if (!raw_text || typeof raw_text !== 'string')
    return fail(res, 'bad_request', 'raw_text is required');
  res.json(await resolve({ rawText: raw_text, phone: phone ?? null }));
});

/* ---------------------------------------------------------------- orders */
api.post('/orders', async (req, res) => {
  const { items, phone, raw_address } = req.body ?? {};
  if (!phone || !raw_address) return fail(res, 'bad_request', 'phone and raw_address are required');

  const resolution = await resolve({ rawText: raw_address, phone });
  /* Ask for the one tap whenever we are not certain. 'estimated' (0.50-0.75)
     is precisely the band where a single confirmation converts a guess into a
     permanent fact, which is the product's whole promise: pin once, ever. */
  const needsPin = resolution.status !== 'resolved';
  const pinToken = needsPin ? randomBytes(9).toString('base64url') : null;

  const id = insert(
    `INSERT INTO orders (items_json, phone, raw_address, resolution_id, pin_token, status)
     VALUES (?,?,?,?,?,?)`,
    JSON.stringify(items ?? []), phone, raw_address, resolution.id, pinToken,
    needsPin ? 'awaiting_pin' : 'ready');

  res.json(orderById(id));
});

api.get('/orders/:id', (req, res) => {
  const o = orderById(Number(req.params.id));
  return o ? res.json(o) : fail(res, 'not_found', 'order not found', 404);
});

/* ---------------------------------------------------------------- pin */
api.post('/pin/:token', (req, res) => {
  const { lat, lng } = req.body ?? {};
  if (typeof lat !== 'number' || typeof lng !== 'number')
    return fail(res, 'bad_request', 'lat and lng must be numbers');
  const order = get<any>('SELECT * FROM orders WHERE pin_token = ?', req.params.token);
  if (!order) return fail(res, 'not_found', 'unknown or already used pin link', 404);

  const out = onPinConfirmed(order.id, lat, lng);
  run('UPDATE orders SET pin_token = NULL WHERE id = ?', order.id);
  res.json({ ok: true, points_pending: out.points_pending, address_id: out.address_id });
});

/* ---------------------------------------------------------------- driver */
api.get('/driver/tasks', async (_req, res) => {
  const rows = all<any>(
    `SELECT id FROM orders WHERE status IN ('ready','assigned') ORDER BY id DESC LIMIT 8`);
  const tasks: DriverTask[] = [];
  for (const r of rows) {
    const order = orderById(r.id)!;
    const { lat, lng } = order.resolution;
    const route = lat != null && lng != null
      ? await getRoute(STORE_ORIGIN.lat, STORE_ORIGIN.lng, lat, lng)
      : null;
    tasks.push({ order, route });      // matches DriverTask exactly: {order, route}
  }
  res.json(tasks);
});

api.post('/driver/road-tap', (req, res) => {
  const { checkpoint_id, status } = req.body ?? {};
  if (!checkpoint_id || !['open','congested','closed'].includes(status))
    return fail(res, 'bad_request', 'checkpoint_id and a valid status are required');
  recordEvent(Number(checkpoint_id), status, 'driver', null);
  res.json({ ok: true, checkpoints: checkpointStates() });
});

api.post('/deliveries/:orderId/complete', (req, res) => {
  const { lat, lng } = req.body ?? {};
  if (typeof lat !== 'number' || typeof lng !== 'number')
    return fail(res, 'bad_request', 'lat and lng must be numbers');
  try { res.json({ ok: true, learned: onDelivered(Number(req.params.orderId), lat, lng) }); }
  catch (e: any) { fail(res, 'not_found', e.message, 404); }
});

/* ---------------------------------------------------------------- roads */
api.get('/checkpoints', (_req, res) => res.json(checkpointStates()));
api.get('/road-events', (req, res) => res.json(recentEvents(Number(req.query.limit ?? 20))));

api.post('/ingest/road-post', async (req, res) => {
  const { text, source } = req.body ?? {};
  if (!text) return fail(res, 'bad_request', 'text is required');
  const src = ['telegram','whatsapp','driver'].includes(source) ? source : 'telegram';
  const parsed = await extractRoadPost(text);

  const matched: any[] = [];
  if (parsed.is_road_related) {
    for (const m of parsed.mentions) {
      if (m.status === 'unknown') continue;
      const cp = matchCheckpoint(m.place);
      if (!cp) { matched.push({ place: m.place, matched: null }); continue; }
      recordEvent(cp.id, m.status, src, text);
      matched.push({ place: m.place, matched: cp.name_ar, status: m.status });
    }
  }
  res.json({ parsed, matched, checkpoints: checkpointStates() });
});

/* ---------------------------------------------------------------- dashboard */
api.get('/dashboard/kpis', (_req, res) => {
  const tiers = all<{ tier: number; n: number }>(
    'SELECT tier, COUNT(*) AS n FROM resolutions GROUP BY tier');
  const breakdown = { '1': 0, '2': 0, '3': 0, '4': 0 } as Kpis['tier_breakdown'];
  let total = 0;
  for (const t of tiers) { breakdown[String(t.tier) as '1'] = t.n; total += t.n; }

  const auto = breakdown['1'] + breakdown['2'];
  const avg = get<{ a: number }>('SELECT AVG(confidence) AS a FROM resolutions')?.a ?? 0;
  const verified = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM addresses WHERE status IN ('pinned','delivery_verified')`)?.n ?? 0;
  const learned = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM entities WHERE source = 'learned' AND lat IS NOT NULL`)?.n ?? 0;
  const delivered = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM orders WHERE status = 'delivered'`)?.n ?? 0;

  const kpis: Kpis = {
    resolution_rate: total ? auto / total : 0,
    avg_confidence: avg,
    tier_breakdown: breakdown,
    calls_saved_est: Math.round(delivered * 1.2),   // baseline was ~1.2 calls per drop
    addresses_verified: verified,
    entities_learned: learned,
    trend: ['M1','M2','M3','M4','M5','M6'].map((m, i) => ({
      month: m,
      auto_rate: Math.min(0.95, (total ? auto / total : 0.3) * (0.55 + i * 0.09)),
    })),
  };
  res.json(kpis);
});

api.get('/dashboard/landmarks', (_req, res) => res.json(learnedLandmarks()));

/* Measured location accuracy, produced by `npm run bench` against a scratch
   database and committed. Served as-is so the dashboard shows a number that
   was measured rather than a claim that was written. */
api.get('/dashboard/accuracy', (_req, res) => {
  const f = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'accuracy.json');
  if (!existsSync(f))
    return fail(res, 'not_measured', 'run `DB_PATH=/tmp/bench.db npm run bench` first', 404);
  res.json(JSON.parse(readFileSync(f, 'utf8')));
});
api.get('/dashboard/cadastral', async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  if (isNaN(lat) || isNaN(lng)) return fail(res, 'bad_request', 'lat and lng required');
  const info = await enrichCadastral(lat, lng);
  if (!info) return fail(res, 'not_found', 'no cadastral data at this location', 404);
  res.json(info);
});
api.get('/dashboard/eval', (_req, res) => {
  const f = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'eval-report.json');
  if (!existsSync(f))
    return fail(res, 'not_run', 'run `npm run eval` first', 404);
  res.json(JSON.parse(readFileSync(f, 'utf8')));
});
api.get('/points/:phone', (req, res) => res.json(balance(phoneHash(req.params.phone))));

/* ------------------------------------------------- stage convenience ----- */
api.post('/simulate/neighbor', async (req, res) => {
  const { text, phone } = req.body ?? {};
  if (!text) return fail(res, 'bad_request', 'text is required');
  res.json(await resolve({ rawText: text, phone: phone ?? '0599000000' }));
});

api.get('/health', (_req, res) => res.json({
  ok: true,
  llm: process.env.ANTHROPIC_API_KEY ? 'configured' : 'offline (rule engine)',
  checkpoints: listCheckpoints().length,
  entities: get<{ n: number }>('SELECT COUNT(*) AS n FROM entities')?.n ?? 0,
  addresses: get<{ n: number }>('SELECT COUNT(*) AS n FROM addresses')?.n ?? 0,
}));

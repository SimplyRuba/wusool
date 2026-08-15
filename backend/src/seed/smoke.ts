/* End-to-end smoke test — runs the four demo paths from 03-INTEGRATION section 4
   against a live server. Exits non-zero on failure so it can gate a demo. */

const BASE = process.env.BASE ?? 'http://localhost:4000/api';
let pass = 0, fail = 0;

const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

const post = async (p: string, body: unknown) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json() as any;
};
const getJson = async (p: string) => (await fetch(BASE + p)).json() as any;

console.log('\n=== PATH A — a cold address becomes a pinned one ===');
const A_TEXT = 'رام الله، قرب مسجد جمال عبد الناصر، عمارة زيدان، الطابق الثالث، بجانب سوبر ماركت الأمل';

const health = await getJson('/health');
ok('server is up', health.ok === true, `parser: ${health.llm}`);
ok('landmarks seeded', health.entities > 20, `${health.entities} entities`);

const r1 = await post('/resolve', { raw_text: A_TEXT, phone: '0599111222' });
ok('parsed the dialect address', !!r1.parsed?.city, `engine=${r1.engine} city=${r1.parsed?.city}`);
ok('found the building', r1.parsed?.building?.includes('زيدان'), r1.parsed?.building ?? '');
ok('extracted the floor', r1.parsed?.floor === '3', `floor=${r1.parsed?.floor}`);
ok('tier 3 triangulation', r1.tier === 3, `tier=${r1.tier} conf=${r1.confidence?.toFixed(2)}`);
ok('lands in the estimated band (so a pin is asked for)',
   r1.status === 'estimated' || r1.status === 'needs_pin', `status=${r1.status}`);

const order = await post('/orders', {
  items: [{ name: 'حذاء رياضي', qty: 1 }], phone: '0599111222', raw_address: A_TEXT,
});
ok('order created', !!order.id, `#${order.id} status=${order.status}`);

/* An estimated order is ready without a pin, so pin explicitly to prove the write path. */
let addressId: number | null = null;
if (order.pin_token) {
  const pin = await post(`/pin/${order.pin_token}`, { lat: 31.9052, lng: 35.1994 });
  ok('pin accepted', pin.ok === true, `+${pin.points_pending} points pending`);
  addressId = pin.address_id;
} else {
  ok('order was confident enough to skip the pin', true, `status=${order.status}`);
  const del = await post(`/deliveries/${order.id}/complete`, { lat: 31.9052, lng: 35.1994 });
  ok('delivery recorded', del.ok === true, `learned ${del.learned?.entities_confirmed} entities`);
}

console.log('\n=== PATH B — the neighbour effect (the money shot) ===');
const B_TEXT = 'البيرة عمارة زيدان جنب سوبرماركت الامل ط٢';
const r2 = await post('/simulate/neighbor', { text: B_TEXT, phone: '0598777666' });
ok('DIFFERENT wording + DIFFERENT phone resolves at tier 2',
   r2.tier === 2, `tier=${r2.tier} conf=${r2.confidence?.toFixed(2)} status=${r2.status}`);
ok('badge has a prior-delivery count', (r2.learned_from ?? 0) >= 1, `learned_from=${r2.learned_from}`);
ok('tier 2 is confident enough to skip the pin', r2.status === 'resolved', `status=${r2.status}`);
if (r2.explain?.length) console.log('        why:', r2.explain[r2.explain.length - 1]);

console.log('\n=== PATH C — community road report moves the map ===');
const before = (await getJson('/checkpoints')).find((c: any) => c.name_ar.includes('الكونتينر'));
const post1 = await post('/ingest/road-post', {
  text: 'الوضع عالكونتينر مسكر بالكامل والبديل واد النار أزمة خانقة', source: 'telegram',
});
ok('post recognised as road-related', post1.parsed?.is_road_related === true,
   `engine=${post1.parsed?.engine} mentions=${post1.parsed?.mentions?.length}`);
const matchedCp = post1.matched?.find((m: any) => m.matched?.includes('الكونتينر'));
ok('matched the dialect spelling onto a real checkpoint', !!matchedCp, matchedCp?.matched ?? 'no match');
const after = post1.checkpoints.find((c: any) => c.name_ar.includes('الكونتينر'));
ok('checkpoint reads closed', after?.status === 'closed', `${before?.status} -> ${after?.status}`);
ok('freshness is not stale (UTC bug would show ~180 min)',
   after?.staleness_min >= 0 && after?.staleness_min < 10, `staleness=${after?.staleness_min} min`);

console.log('\n=== PATH D — driver route avoids the closure ===');
const tasks = await getJson('/driver/tasks');
ok('driver has tasks', Array.isArray(tasks) && tasks.length > 0, `${tasks.length} tasks`);
if (tasks[0]) {
  ok('task shape matches the contract {order, route}',
     'order' in tasks[0] && 'route' in tasks[0] && !('resolution' in tasks[0]),
     Object.keys(tasks[0]).join('+'));
  ok('task carries its resolution inside the order', !!tasks[0].order?.resolution?.tier);
  if (tasks[0].route)
    ok('route returned', !!tasks[0].route.chosen,
       `${tasks[0].route.source} ${Math.round(tasks[0].route.distance_m)}m penalty=${tasks[0].route.penalty_s}s rejected=${tasks[0].route.rejected.length}`);
}

console.log('\n=== dashboard ===');
const k = await getJson('/dashboard/kpis');
ok('kpis computed from real rows', k.addresses_verified > 0,
   `auto-rate=${(k.resolution_rate * 100).toFixed(1)}% verified=${k.addresses_verified} learned=${k.entities_learned}`);
ok('tier breakdown populated', Object.values(k.tier_breakdown).some((n: any) => n > 0),
   JSON.stringify(k.tier_breakdown));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

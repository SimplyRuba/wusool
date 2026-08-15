# 02 — FRONTEND SPEC (Vite + React + TS + Tailwind + Leaflet)

One SPA, four routes. Built entirely against `lib/api.ts`, which has `MOCK=true` fixtures until integration (03 §4). Direction: `dir="rtl"`, lang ar; UI copy Arabic-first with small English subtitles where useful for judges.

Design language: white surfaces, 1 accent = teal `#0F6E56` (verified/success), amber `#BA7517` (needs attention), red `#A32D2D` (closed), neutral ink `#20261F`. Font: IBM Plex Sans Arabic (Google Fonts). Rounded-xl cards, generous spacing. Confidence is ALWAYS shown as both a % and a colored badge — confidence is the product's honesty and the demo's protagonist.

Shared map component `<WMap>`: Leaflet, OSM tiles, props: `pins[]`, `route?: GeoJSON`, `rejectedRoutes?: GeoJSON[]`, `checkpoints[]`, `onPick?(latlng)`. Checkpoint markers = colored dots (teal/amber/red) + name tooltip + "آخر تحديث قبل X دقيقة". Rejected routes render dashed gray with a small ✕ label at the blocking checkpoint.

---

## Route 1 — `/` Demo Store Checkout (the SDK screen in disguise)

Purpose on stage: "this is any restaurant's checkout after pasting our widget."

Layout: fake store header ("مطعم الأمل — توصيل"), 2 hardcoded cart items, then **the WASEL address widget** in a visually distinct bordered card labeled `WASEL ✓ عنوان ذكي` (this framing matters — it must look embeddable).

Widget behavior:
1. Phone input + free-text address textarea (placeholder: "اكتب عنوانك كما تحكيه… مثال: رام الله، قرب مسجد جمال عبد الناصر، عمارة زيدان، ط٣").
2. On blur or "تأكيد العنوان" → `POST /api/resolve`. Show inline **parse trace** (this is the AI-visible moment): extracted chips — 🕌 مسجد جمال عبد الناصر · 🏢 عمارة زيدان · ط٣ · جنب سوبرماركت الأمل — animating in.
3. Result states:
   - `resolved` (≥0.75): mini-map with pin + teal badge "دقة عالية ٩X٪" + if tier-2: badge "📍 تم التعرف عليه من X توصيلة سابقة لهذا المبنى" (the neighbor-effect badge — the single most important UI element in the demo).
   - `estimated`: amber badge "موقع تقريبي — سيتأكد المندوب".
   - `needs_pin`: amber card "سنرسل لك رابط تثبيت الموقع مرة واحدة فقط" + points teaser "+١٠ نقاط خصم عند نجاح التوصيل".
4. Submit order → `POST /api/orders` → success screen with order id; if needs_pin, show the pin link visibly (stage convenience: click it to jump to Route 2).

## Route 2 — `/pin/:token` Customer Pin (magic link)

Mobile-first single screen: "ثبّت موقعك مرة واحدة — لن نسألك مرة أخرى".
- Map centered on tier-3 estimate (or Ramallah center), draggable pin, "استخدم موقعي الحالي" (geolocation) button.
- Confirm → `POST /api/pin/:token` → success: "✓ تم الحفظ للأبد · +١٠ نقاط قيد التأكيد" + explainer line "ستتحول لخصم عند نجاح التوصيل" (pending→verified lifecycle made visible).
- Under 10 seconds end-to-end. No login, no fields.

## Route 3 — `/driver` Driver PWA screen

Header: driver name + today count. Body:
- Task list (from `/api/driver/tasks`): each card = customer area, confidence badge, address text, [ابدأ التوصيل].
- Active task view: `<WMap>` with pin + chosen route (teal) + rejected alternative (dashed, "✕ مغلق: حاجز X") + checkpoint dots. Buttons: **توجيه** (deep link `https://www.google.com/maps/dir/?api=1&destination=lat,lng`), **✓ تم التسليم** (→ complete endpoint; toast shows what the system learned: "تم توثيق عمارة زيدان — التوصيلة القادمة فورية"), **⚠ فشل**.
- Road tap bar (persistent bottom): checkpoint selector + three big buttons سالك 🟢 / أزمة 🟡 / مسكر 🔴 → `/api/driver/road-tap` → toast "شكراً — تم تحديث الخريطة للجميع".

## Route 4 — `/dashboard` Company Dashboard

Grid of cards (recharts or plain divs — keep light):
1. KPI row: دقة التحديد % · مكالمات موفَّرة · عناوين موثّقة · معالم مكتشفة (from `/api/dashboard/kpis`; animate count-up).
2. Tier breakdown bar (tier1/2/3/4 share) — the "learning curve" chart: tier1+2 share rising over synthetic months (this chart IS the 30% criterion visualized).
3. Live road feed ticker: recent `road_events` with source icons (Telegram ✈️ / WhatsApp 💬 / Driver 🚗) + parsed status chips; a "محاكاة رسالة" input posts to `/api/ingest/road-post` (stage: paste a real-style dialect post, watch it parse and flip a checkpoint color on the embedded map within 2s).
4. Checkpoint status map (small `<WMap>` with all checkpoints).
5. Fleet/orders table: recent orders with confidence + status.

## Cross-cutting requirements

- Loading: skeletons, never spinners >300ms without text.
- Errors: inline Arabic messages; resolve failure falls back to "أدخل موقعك يدوياً" (pin picker inline) — the demo must not dead-end if LLM is down.
- All API calls typed via `shared/contract.ts` copy; ZERO `any`.
- Responsive: `/pin` and `/driver` designed at 390px width first; `/` and `/dashboard` at desktop.
- A tiny "WASEL" logo header on every route — one brand across all three faces (the "one platform" message).
- Fixtures for MOCK mode: 1 resolved(tier3), 1 tier-2 with learned_from=4, 1 needs_pin, 3 checkpoints (one closed), 1 route+rejected pair, kpis object. Fixture values must look plausible, not round numbers.

/* =============================================================================
   Rule-based Palestinian address parser.
   This is not a stub. It is the offline path: when there is no API key, no
   internet, or the LLM errors, `parseAddress` falls back here and the whole
   cascade keeps working. Weak connectivity is the normal case in Area C, so
   the offline path is a product requirement, not a fixture.
   ============================================================================= */
import type { ParsedAddress } from '../contract.ts';
import { normalizeArabic } from '../lib/arabic.ts';

export type CityRow = { ar: string; en: string; lat: number; lng: number; camp?: boolean };

export const CITIES: CityRow[] = [
  { ar: 'رام الله', en: 'Ramallah', lat: 31.9038, lng: 35.2034 },
  { ar: 'البيرة', en: 'Al-Bireh', lat: 31.9090, lng: 35.2160 },
  { ar: 'بيتونيا', en: 'Beitunia', lat: 31.8930, lng: 35.1690 },
  { ar: 'نابلس', en: 'Nablus', lat: 32.2211, lng: 35.2544 },
  { ar: 'الخليل', en: 'Hebron', lat: 31.5326, lng: 35.0998 },
  { ar: 'بيت لحم', en: 'Bethlehem', lat: 31.7054, lng: 35.2024 },
  { ar: 'بيت جالا', en: 'Beit Jala', lat: 31.7154, lng: 35.1866 },
  { ar: 'بيت ساحور', en: 'Beit Sahour', lat: 31.6997, lng: 35.2270 },
  { ar: 'جنين', en: 'Jenin', lat: 32.4615, lng: 35.3007 },
  { ar: 'طولكرم', en: 'Tulkarm', lat: 32.3104, lng: 35.0286 },
  { ar: 'قلقيلية', en: 'Qalqilya', lat: 32.1897, lng: 34.9706 },
  { ar: 'أريحا', en: 'Jericho', lat: 31.8667, lng: 35.4500 },
  { ar: 'سلفيت', en: 'Salfit', lat: 32.0850, lng: 35.1810 },
  { ar: 'طوباس', en: 'Tubas', lat: 32.3211, lng: 35.3690 },
  { ar: 'القدس', en: 'Jerusalem', lat: 31.7784, lng: 35.2296 },
  { ar: 'مخيم قلنديا', en: 'Qalandia Camp', lat: 31.8617, lng: 35.2221, camp: true },
  { ar: 'مخيم الدهيشة', en: 'Dheisheh Camp', lat: 31.6975, lng: 35.1908, camp: true },
  { ar: 'مخيم بلاطة', en: 'Balata Camp', lat: 32.2130, lng: 35.2870, camp: true },
  { ar: 'مخيم الجلزون', en: 'Jalazone Camp', lat: 31.9560, lng: 35.2110, camp: true },
  { ar: 'مخيم العروب', en: 'Al-Arroub Camp', lat: 31.6180, lng: 35.1330, camp: true },
  { ar: 'مخيم الأمعري', en: 'Amari Camp', lat: 31.8960, lng: 35.2110, camp: true },
  { ar: 'مخيم عسكر', en: 'Askar Camp', lat: 32.2260, lng: 35.2900, camp: true },
];

/** spatial prepositions -> canonical relation */
export const RELATIONS: Record<string, string> = {
  'قرب': 'near', 'بالقرب من': 'near', 'جنب': 'next_to', 'بجانب': 'next_to', 'حدا': 'next_to',
  'خلف': 'behind', 'ورا': 'behind', 'وراء': 'behind',
  'فوق': 'above', 'تحت': 'below',
  'مقابل': 'opposite', 'قبالة': 'opposite', 'أمام': 'opposite', 'امام': 'opposite',
  'بعد': 'after', 'قبل': 'before', 'عند': 'at', 'داخل': 'inside', 'بين': 'between',
  'نزلة': 'downslope', 'طلعة': 'upslope', 'مدخل': 'entrance_of', 'أول': 'start_of', 'اخر': 'end_of',
};
export const RELATIONS_EN: Record<string, string> = {
  'near': 'near', 'next to': 'next_to', 'beside': 'next_to', 'behind': 'behind',
  'above': 'above', 'below': 'below', 'under': 'below', 'opposite': 'opposite',
  'facing': 'opposite', 'in front of': 'opposite', 'after': 'after', 'before': 'before',
  'at': 'at', 'inside': 'inside', 'between': 'between',
};

/** landmark keyword -> contract landmark type */
export const LANDMARK_TYPES: Record<string, string> = {
  'مسجد': 'mosque', 'جامع': 'mosque', 'كنيسة': 'church', 'دير': 'church',
  'مستشفى': 'hospital', 'مشفى': 'hospital', 'عيادة': 'hospital', 'مركز صحي': 'hospital',
  'صيدلية': 'pharmacy', 'مدرسة': 'school', 'جامعة': 'school', 'كلية': 'school', 'روضة': 'school',
  'سوبرماركت': 'supermarket', 'سوبر ماركت': 'supermarket', 'ماركت': 'supermarket',
  'بقالة': 'shop', 'دكان': 'shop', 'محل': 'shop', 'مخبز': 'shop', 'فرن': 'shop',
  'مطعم': 'shop', 'مقهى': 'shop', 'كافيه': 'shop', 'بنك': 'shop', 'صرافة': 'shop',
  'دوار': 'roundabout', 'مفرق': 'roundabout', 'تقاطع': 'roundabout',
  'حاجز': 'other', 'سينما': 'other', 'ملعب': 'other', 'حديقة': 'other', 'كراج': 'other',
  'محطة': 'other', 'مركز': 'other', 'سوق': 'other', 'مخيم': 'other', 'حارة': 'other',
  'شارع': 'other', 'بلدية': 'other', 'بريد': 'other', 'مقبرة': 'other', 'نادي': 'other',
  'برج': 'other', 'مجمع': 'other', 'معهد': 'other',
};
const LANDMARK_EN: Record<string, string> = {
  'mosque': 'mosque', 'church': 'church', 'hospital': 'hospital', 'clinic': 'hospital',
  'pharmacy': 'pharmacy', 'school': 'school', 'university': 'school', 'college': 'school',
  'supermarket': 'supermarket', 'market': 'supermarket', 'grocery': 'shop', 'shop': 'shop',
  'store': 'shop', 'bakery': 'shop', 'restaurant': 'shop', 'cafe': 'shop', 'bank': 'shop',
  'circle': 'roundabout', 'roundabout': 'roundabout', 'junction': 'roundabout',
  'checkpoint': 'other', 'cinema': 'other', 'stadium': 'other', 'park': 'other',
  'garage': 'other', 'station': 'other', 'camp': 'other', 'quarter': 'other', 'street': 'other',
};

export const BUILDING_WORDS = ['عمارة', 'بناية', 'مبنى', 'برج', 'مجمع', 'فيلا', 'بلوك', 'دار', 'بيت'];
const BUILDING_EN = ['building', 'tower', 'block', 'complex', 'villa', 'house'];
/** a building is "named" when a proper noun follows the keyword */
const NAMED_BUILDING = /^(عمارة|بناية|برج|مجمع|فيلا|بلوك)\s+\S+/;

const FLOOR_RE = [
  /(?:ال)?طابق\s*([^\s،,]+)/,
  /ط\s*\.?\s*(\d+)/,
  /\b(\d+)(?:st|nd|rd|th)\s+floor\b/i,
  /\bfloor\s*(\d+)/i,
];
const APT_RE = [
  /(?:ال)?شقة\s*([^\s،,]+)/,
  /(?:ال)?باب\s*([^\s،,]+)/,
  /\b(?:apt|apartment|flat|door)\s*([^\s,،]+)/i,
];
const WORD_NUM: Record<string, string> = {
  'الاول': '1', 'الاولى': '1', 'الثاني': '2', 'التاني': '2', 'الثالث': '3', 'التالت': '3',
  'الرابع': '4', 'الخامس': '5', 'السادس': '6', 'السابع': '7', 'الارضي': '0', 'ارضي': '0',
};

const stripLeadingRelation = (phrase: string): { rel: string | null; rest: string } => {
  const low = phrase.toLowerCase();
  for (const k of Object.keys(RELATIONS).sort((a, b) => b.length - a.length))
    if (phrase.startsWith(k + ' ')) return { rel: RELATIONS[k], rest: phrase.slice(k.length).trim() };
  for (const k of Object.keys(RELATIONS_EN).sort((a, b) => b.length - a.length))
    if (low.startsWith(k + ' ')) return { rel: RELATIONS_EN[k], rest: phrase.slice(k.length).trim() };
  return { rel: null, rest: phrase };
};

const landmarkTypeOf = (s: string): string | null => {
  for (const [k, v] of Object.entries(LANDMARK_TYPES)) if (s.includes(k)) return v;
  const low = s.toLowerCase();
  for (const [k, v] of Object.entries(LANDMARK_EN)) if (low.includes(k)) return v;
  return null;
};
const isBuilding = (s: string): boolean =>
  BUILDING_WORDS.some(k => s.includes(k)) || BUILDING_EN.some(k => s.toLowerCase().includes(k));

export const isNamedBuilding = (s: string): boolean =>
  NAMED_BUILDING.test(s.trim()) || /\b\S+\s+(building|tower|complex)\b/i.test(s);

export function findCity(text: string): CityRow | null {
  const n = normalizeArabic(text), low = text.toLowerCase();
  // longest name first so "مخيم قلنديا" beats a bare city match
  const sorted = [...CITIES].sort((a, b) => b.ar.length - a.ar.length);
  for (const c of sorted)
    if (n.includes(normalizeArabic(c.ar)) || low.includes(c.en.toLowerCase())) return c;
  return null;
}

/** Split on Arabic/Latin commas, newlines, dashes and the connector "و " at phrase start. */
const BREAK_BEFORE = new Set<string>([
  ...Object.keys(RELATIONS).filter(k => !k.includes(' ')).map(normalizeArabic),
  ...BUILDING_WORDS.map(normalizeArabic),
  ...Object.keys(LANDMARK_TYPES).filter(k => !k.includes(' ')).map(normalizeArabic),
  'طابق', 'شقه', 'باب', 'سوبر', 'ابو', 'ام',   // compound prefixes
]);

/** Split on punctuation, then again inside long runs that carry no commas. */
const splitPhrases = (t: string): string[] => {
  const out: string[] = [];
  for (const chunk of t.split(/[،,\n;؛]+|\s+-\s+/).map(s => s.trim()).filter(Boolean)) {
    const toks = chunk.split(/\s+/);
    if (toks.length <= 3) { out.push(chunk); continue; }
    let cur: string[] = [];
    let prevWasStem = false;
    for (const tok of toks) {
      const n = normalizeArabic(tok);
      const bare = n.replace(/^ال/, '');          // الطابق -> طابق
      const isStem = BREAK_BEFORE.has(n) || BREAK_BEFORE.has(bare);
      const isFloorTok = /^ط\d/.test(n);
      /* Do not break inside a compound stem such as "سوبر ماركت" or "مركز صحي" -
         two stems in a row are one name, not two phrases. */
      const breakHere = cur.length && (isFloorTok || (isStem && !prevWasStem));
      if (breakHere) { out.push(cur.join(' ')); cur = []; }
      cur.push(tok);
      prevWasStem = isStem;
    }
    if (cur.length) out.push(cur.join(' '));
  }
  return out.filter(Boolean);
};

const westernDigits = (s: string) => s.replace(/[\u0660-\u0669]/g,
  d => String(d.charCodeAt(0) - 0x0660));

export function parseWithRules(input: string): ParsedAddress {
  const text = westernDigits(input);
  const out: ParsedAddress = {
    city: null, area: null, landmarks: [], building: null,
    floor: null, apartment: null, relations: [], notes: null,
  };
  if (!text?.trim()) return out;

  const phrases = splitPhrases(text);
  const city = findCity(text);
  if (city) out.city = city.ar;

  const leftovers: string[] = [];

  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];

    // the phrase that carried the city is consumed by it
    if (city && (normalizeArabic(phrase).includes(normalizeArabic(city.ar)) ||
                 phrase.toLowerCase().includes(city.en.toLowerCase()))) {
      const residue = phrase
        .replace(new RegExp(city.ar, 'g'), '')
        .replace(new RegExp(city.en, 'ig'), '').trim();
      if (residue.length > 2) leftovers.push(residue);
      continue;
    }

    /* Floor and apartment can sit inside a phrase that also names the building,
       e.g. "عمارة زيدان الطابق الثالث". Extract them, then STRIP them and keep
       parsing the remainder - consuming the whole phrase loses the building. */
    let residual = phrase;
    for (const re of FLOOR_RE) {
      const m = residual.match(re);
      if (m) {
        const raw = normalizeArabic(m[1] ?? '');
        out.floor = WORD_NUM[raw] ?? (raw.match(/\d+/)?.[0] ?? raw);
        residual = residual.replace(m[0], ' ').trim();
      }
    }
    for (const re of APT_RE) {
      const m = residual.match(re);
      if (m) { out.apartment = m[0].trim(); residual = residual.replace(m[0], ' ').trim(); }
    }
    if (!residual || residual.length < 2) continue;

    const { rel, rest } = stripLeadingRelation(residual);
    if (!rest) continue;

    const ltype = landmarkTypeOf(rest);
    if (isBuilding(rest) && !ltype) {
      if (!out.building) out.building = rest;
      if (rel) out.relations.push({ subject: 'target', relation: rel, object: rest });
    } else if (ltype) {
      out.landmarks.push({ name: rest, type: ltype });
      if (rel) out.relations.push({ subject: 'target', relation: rel, object: rest });
    } else if (!out.area && i <= 1 && rest.length <= 30 && !rel) {
      out.area = rest;                       // an early bare phrase is the neighbourhood
    } else {
      // unknown but relation-qualified text is still positional evidence
      if (rel) { out.landmarks.push({ name: rest, type: 'other' });
                 out.relations.push({ subject: 'target', relation: rel, object: rest }); }
      else leftovers.push(rest);
    }
  }

  if (!out.area && leftovers.length) out.area = leftovers.shift()!;
  if (leftovers.length) out.notes = leftovers.join(' · ');
  return out;
}

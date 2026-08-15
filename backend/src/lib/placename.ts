import { normalizeArabic, levenshtein, tokenSetOverlap } from './arabic.ts';

/**
 * Generic place stems. These words say what KIND of thing something is, never
 * WHICH one. "عمارة" means "building" — it carries no identity, so it must be
 * removed before any fuzzy comparison.
 *
 * WHY THIS EXISTS: comparing whole phrases with Levenshtein <= 2 matched
 * "عمارة زيدان" to "عمارة حمدان" — two edits inside the family name, two
 * completely different buildings, one merged entity and a driver sent to the
 * wrong address. The distinguishing information is the proper noun, so that is
 * what gets compared.
 */
export const GENERIC_STEMS = new Set([
  // buildings
  'عماره','بنايه','مبني','برج','مجمع','فيلا','بلوك','دار','بيت','شقه','طابق','باب',
  // worship / civic
  'مسجد','جامع','كنيسه','دير','بلديه','بريد','مقبره','نادي',
  // health / education
  'مستشفي','مشفي','عياده','صيدليه','مدرسه','جامعه','كليه','روضه','مركز','معهد','مجمع',
  // commerce
  'سوبرماركت','سوبر','ماركت','بقاله','دكان','محل','مخبز','فرن','مطعم','مقهي','كافيه','بنك','صرافه','سوق',
  // movement / geography
  'دوار','مفرق','تقاطع','شارع','حاره','مخيم','حاجز','كراج','محطه','ملعب','حديقه','سينما','مسرح',
  // english equivalents
  'building','tower','block','complex','villa','house','mosque','church','hospital','clinic',
  'pharmacy','school','university','college','supermarket','market','grocery','shop','store',
  'bakery','restaurant','cafe','bank','circle','roundabout','junction','street','camp',
  'checkpoint','garage','station','park','the','of','al',
]);

/**
 * A generic stem says nothing about WHICH place — but it does say what KIND of
 * place, and that is enough to rule a match OUT.
 *
 * WHY THIS EXISTS: against 28 hand-picked landmarks every proper noun was
 * unique. Against the real OSM extract, seven different places in Ramallah
 * reduce to the distinctive token "الامل" alone — a supermarket, two
 * pharmacies, a kindergarten and a petrol station. Comparing only the
 * distinctive tokens made all seven the same place, and the flagship demo
 * address started triangulating off a pharmacy 6 km away.
 *
 * `مركز` (centre) and `مجمع` (complex) are deliberately absent: they attach to
 * every kind of thing, so they carry no discriminating power.
 */
const TYPE_GROUPS: Record<string, string[]> = {
  worship:   ['مسجد','جامع','كنيسه','دير','مصلي','mosque','church','cathedral','chapel'],
  health:    ['مستشفي','مشفي','عياده','صيدليه','مختبر','hospital','clinic','pharmacy','lab'],
  education: ['مدرسه','جامعه','كليه','روضه','معهد','حضانه','school','university','college','kindergarten'],
  retail:    ['سوبرماركت','سوبر','ماركت','بقاله','دكان','محل','مخبز','فرن','سوق','ملحمه',
              'supermarket','market','grocery','bakery','store','shop','mall'],
  dining:    ['مطعم','مقهي','كافيه','restaurant','cafe','coffee'],
  finance:   ['بنك','صرافه','bank','exchange'],
  building:  ['عماره','بنايه','مبني','برج','فيلا','بلوك','دار','بيت','مساكن','اسكان',
              'building','tower','block','villa','house','apartments'],
  transit:   ['دوار','مفرق','تقاطع','شارع','محطه','كراج','حاجز','circle','roundabout',
              'junction','street','station','garage','checkpoint'],
  civic:     ['بلديه','بريد','مقبره','شرطه','محكمه','townhall','police','post','court'],
  leisure:   ['ملعب','حديقه','سينما','مسرح','نادي','park','stadium','cinema','theatre','club'],
};

const STEM_TO_GROUP = new Map<string, string>();
for (const [group, stems] of Object.entries(TYPE_GROUPS))
  for (const s of stems) STEM_TO_GROUP.set(s, group);

/** Which categories of place this name declares itself to be. Usually 0 or 1. */
export function placeTypes(name: string): Set<string> {
  const out = new Set<string>();
  for (const t of normalizeArabic(name).split(' ')) {
    const g = STEM_TO_GROUP.get(t);
    if (g) out.add(g);
  }
  return out;
}

/** The tokens that actually identify a place — generic stems removed. */
export function distinctiveTokens(name: string): string[] {
  return normalizeArabic(name)
    .split(' ')
    .filter(t => t.length > 1 && !GENERIC_STEMS.has(t));
}

export const distinctiveKey = (name: string) => distinctiveTokens(name).join(' ');

/**
 * Should these two place names be treated as the same place?
 * Compares only the distinctive parts, so a spelling variant matches but a
 * different proper noun never does.
 */
export function sameePlace(a: string, b: string): { same: boolean; score: number } {
  const A = distinctiveTokens(a), B = distinctiveTokens(b);

  // Nothing distinctive on either side: only identical generics can match,
  // and that is far too weak to merge on.
  if (!A.length || !B.length) return { same: false, score: 0 };

  /* Both sides declare a category and they do not overlap: same proper noun,
     different kind of place. "صيدلية الأمل" is not "سوبرماركت الأمل". */
  const ta = placeTypes(a), tb = placeTypes(b);
  if (ta.size && tb.size && ![...ta].some(t => tb.has(t)))
    return { same: false, score: 0 };

  const ka = A.join(' '), kb = B.join(' ');
  if (ka === kb) return { same: true, score: 1 };

  const overlap = tokenSetOverlap(ka, kb);
  if (overlap >= 0.6) return { same: true, score: overlap };

  // Single distinctive token each: allow ONE edit, and only on longer words.
  // "النتشه" vs "النتشة" already normalises equal; this catches a real typo,
  // not a different family name (زيدان vs حمدان is 2 edits and stays apart).
  if (A.length === 1 && B.length === 1 && ka.length >= 5 && kb.length >= 5) {
    const d = levenshtein(ka, kb, 1);
    if (d <= 1) return { same: true, score: 0.85 };
  }
  return { same: false, score: overlap };
}

/** kept for the old name used in tests/imports */
export const samePlace = sameePlace;

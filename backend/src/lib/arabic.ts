/** Arabic normalization — run before ANY string comparison or alias lookup. */
const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/**
 * Compound name prefixes that get written both joined and separated, with no
 * rule about which: عبد الله / عبدالله, أبو ديّة / أبوديّة, ابن سينا / ابنسينا.
 *
 * WHY THIS MATTERS: token-set overlap treats "عبد الناصر" as two tokens and
 * "عبدالناصر" as one, so "مسجد جمال عبد الناصر" and "مسجد جمال عبدالناصر"
 * overlapped at only 0.33 and were judged to be different mosques. Palestinian
 * place and family names are full of these. Joining the prefix to the word
 * after it makes both spellings converge on a single form.
 */
const JOIN_PREFIX = /(^|\s)(عبد|ابو|ام|ابن|بن)\s+(?=\S)/g;

export function normalizeArabic(s: string): string {
  if (!s) return '';
  return s
    .replace(TASHKEEL, '')                 // strip diacritics and tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))  // ٠١٢ -> 012
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')      // drop punctuation, keep letters+digits
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(JOIN_PREFIX, '$1$2');         // عبد الناصر -> عبدالناصر
}

/** Levenshtein, bounded — returns max+1 once it is certain the distance exceeds max. */
export function levenshtein(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Token-set overlap 0..1 (Jaccard over word sets). */
export function tokenSetOverlap(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / new Set([...A, ...B]).size;
}

/** Similarity used by tier 1 for "is this the same address text". */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeArabic(a), nb = normalizeArabic(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const jac = tokenSetOverlap(na, nb);
  const lev = levenshtein(na, nb, 12);
  const levScore = 1 - Math.min(1, lev / Math.max(na.length, nb.length));
  return Math.max(jac, levScore * 0.9);
}

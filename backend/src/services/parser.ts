import type { ParsedAddress } from '../contract.ts';
import { parseWithRules } from './rules.ts';
import { normalizeArabic } from '../lib/arabic.ts';
import {
  callStructured, ADDRESS_SYSTEM, ADDRESS_SCHEMA,
  ROAD_SYSTEM, ROAD_SCHEMA, llmReady,
} from './llm.ts';

export type ParseOut = {
  parsed: ParsedAddress;
  engine: 'llm' | 'llm-cache' | 'rules';
  note?: string;
};

/**
 * LLM first, rule engine on any failure. The caller always gets a usable parse —
 * there is no code path where a missing key or a dropped connection stops the
 * pipeline. That is the point: weak connectivity is the normal case here.
 */
export async function extractAddress(rawText: string): Promise<ParseOut> {
  try {
    const { data, engine } = await callStructured<ParsedAddress>(
      ADDRESS_SYSTEM, rawText, ADDRESS_SCHEMA, 1024);
    // The rule engine is more reliable on floors and doors, so backfill any gaps.
    const rules = parseWithRules(rawText);
    return {
      engine,
      parsed: {
        ...data,
        floor: data.floor ?? rules.floor,
        apartment: data.apartment ?? rules.apartment,
        area: data.area ?? rules.area,
      },
    };
  } catch (e: any) {
    return {
      parsed: parseWithRules(rawText),
      engine: 'rules',
      note: llmReady() ? 'llm failed: ' + e?.message : 'no api key - offline rule engine',
    };
  }
}

export type RoadMention = {
  place: string;
  kind: 'checkpoint' | 'road' | 'junction';
  status: 'open' | 'congested' | 'closed' | 'unknown';
  severity: 'low' | 'medium' | 'high' | null;
  alternative_route: string | null;
};
export type RoadParse = { is_road_related: boolean; mentions: RoadMention[]; engine: string };

/* ------------------------------------------------------------------ *
 * Road-post vocabulary.
 *
 * These are matched against the NORMALISED text, so each word is written once
 * in its normalised form (ة->ه, أإآ->ا, ى->ي). Writing "أزمة|ازمة" by hand was
 * how spelling variants used to be covered, and it missed every variant nobody
 * thought of.
 * ------------------------------------------------------------------ */
const CLOSED_W = [
  'مسكر','مسكره','سكر','سكروا','مغلق','مغلقه','اغلاق','مقفل','مقفله','مسدود',
  'ممنوع','مقطوع','منع','closed','shut','blocked',
];
const CONGEST_W = [
  'ازمه','عجقه','زحمه','ازدحام','خانقه','بطيء','بطيئه','بطي','تفتيش','طوابير',
  'واقفين','مكدس','تاخير','طيار','طياره','مشدد',
  'congest','jam','heavy','traffic','slow','delay','queue',
];
const OPEN_W = [
  'سالك','سالكه','فاتح','فاتحه','مفتوح','مفتوحه','فتح','فتحوا','طبيعي','طبيعيه',
  'تحسن','حركه','ماشي','سلس','open','clear','flowing','normal',
];

/* Negation. "مافي زحمة" means there is NO traffic, and reading it as
   congestion inverts the report — the single worst failure mode here, because
   a driver is then routed away from the one road that is actually clear.
   A negator scopes over the short noun phrase that follows it, which in
   practice is up to three tokens ("ولا في حواجز طيارة" -> no flying
   checkpoints -> clear). Segments are already split on ، and . first, so
   "مسكر من الصبح، لا تجوا من هون" keeps its closure: the negator is in the
   next segment, not this one. */
const NEGATORS = new Set(['ما','مافي','مافيش','ماكو','مش','مو','بدون','ولا','لا','بلا']);
const NEG_WINDOW = 3;

const CHECKPOINT = /حاجز|معبر|checkpoint|crossing/i;
/* Filler that is never part of a place name. */
const NOISE_W = new Set([
  'الوضع','على','عال','في','عند','الحاجز','طريق','بالكامل','والبديل','اليوم','الحين',
  'من','الى','ساعه','شباب','يا','الله','الحمدلله','انتبهوا','كتير','جدا','شوي','صار',
  'خدوا','خذوا','لا','تجوا','هون','نهاييا','المرور','الجيش','وقتكم','ولا','مافي','و',
  'رجعت','تماما','ابدا','خالص','كمان','برضو','بعد','قبل','كل','هاي','هاد',
]);

type Status = RoadMention['status'];

const wordSet = (ws: string[]) => new Set(ws);
const CLOSED_S = wordSet(CLOSED_W), CONGEST_S = wordSet(CONGEST_W), OPEN_S = wordSet(OPEN_W);

/* The definite article is part of the word in Arabic, so "الحركة" and "حركة"
   are the same status word. Without stripping it, "الحركة رجعت طبيعية" left
   "الحركه" behind and it was reported as an unknown PLACE name. */
const classify = (tok: string): Status | null => {
  const t = tok.length > 3 && tok.startsWith('ال') ? tok.slice(2) : tok;
  for (const w of [tok, t]) {
    if (CLOSED_S.has(w)) return 'closed';
    if (CONGEST_S.has(w)) return 'congested';
    if (OPEN_S.has(w)) return 'open';
  }
  return null;
};

/** Flip a status that sits inside a negation. */
const invert = (st: Status): Status =>
  st === 'open' ? 'congested' : 'open';        // "مش سالك" -> not clear; "مافي زحمة" -> clear

/**
 * Read a status out of one phrase.
 *
 * Precedence is closed > congested > open, applied AFTER negation, because a
 * post that says both ("مسكر بالكامل، خدوا البديل") is reporting a closure.
 */
function statusOf(s: string): Status | null {
  const toks: string[] = normalizeArabic(s).split(' ').filter(Boolean);
  const found: Status[] = [];
  for (let i = 0; i < toks.length; i++) {
    const st = classify(toks[i]);
    if (!st) continue;
    const negated = toks.slice(Math.max(0, i - NEG_WINDOW), i).some((t: string) => NEGATORS.has(t));
    found.push(negated ? invert(st) : st);
  }
  if (!found.length) return null;
  if (found.includes('closed')) return 'closed';
  if (found.includes('congested')) return 'congested';
  return 'open';
}

/** Strip status words and filler, leaving what should be the place name. */
function placeOf(seg: string): string {
  return normalizeArabic(seg)
    .split(' ')
    .filter((t: string) => t && !classify(t) && !NEGATORS.has(t) && !NOISE_W.has(t))
    .join(' ')
    .trim();
}

/** Rule fallback for road posts: a place phrase plus a dialect status word. */
export function parseRoadWithRules(text: string): RoadParse {
  if (!statusOf(text)) return { is_road_related: false, mentions: [], engine: 'rules' };
  const mentions: RoadMention[] = [];
  for (const seg of text.split(/[،,.\n]+/).map(s => s.trim()).filter(Boolean)) {
    const st = statusOf(seg);
    if (!st) continue;
    const place = placeOf(seg);
    if (place.length > 1)
      mentions.push({
        place,
        kind: CHECKPOINT.test(seg) ? 'checkpoint' : 'road',
        status: st, severity: null, alternative_route: null,
      });
  }
  if (!mentions.length) {
    const place = placeOf(text);
    mentions.push({
      place: place.length > 1 ? place : text.trim().slice(0, 40),
      kind: CHECKPOINT.test(text) ? 'checkpoint' : 'road',
      status: statusOf(text)!, severity: null, alternative_route: null,
    });
  }
  return { is_road_related: true, mentions, engine: 'rules' };
}

export async function extractRoadPost(text: string): Promise<RoadParse> {
  try {
    const { data, engine } = await callStructured<Omit<RoadParse, 'engine'>>(
      ROAD_SYSTEM, text, ROAD_SCHEMA, 700);
    return { ...data, engine };
  } catch {
    return parseRoadWithRules(text);
  }
}

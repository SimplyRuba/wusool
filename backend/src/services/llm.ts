import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '..', 'cache', 'llm');
mkdirSync(CACHE_DIR, { recursive: true });

export class LLMUnavailable extends Error {
  constructor(msg: string) { super(msg); this.name = 'LLMUnavailable'; }
}

/* ── Provider detection ─────────────────────────────────────────────── */

const USE_CACHE = process.env.LLM_CACHE !== '0';
const hasGemini = () => !!process.env.GEMINI_API_KEY;
const hasAnthropic = () => !!process.env.ANTHROPIC_API_KEY;

// Prefer Gemini (free) over Anthropic (paid)
type Provider = 'gemini' | 'anthropic' | 'none';
const provider = (): Provider =>
  hasGemini() ? 'gemini' : hasAnthropic() ? 'anthropic' : 'none';

/* ── Anthropic client ─────────────────────────────────────────────── */

const ANTHROPIC_MODEL = process.env.LLM_MODEL ?? 'claude-sonnet-5';
let anthropicClient: Anthropic | null = null;
const getAnthropic = () => (anthropicClient ??= new Anthropic());

/* ── Gemini client ────────────────────────────────────────────────── */

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash';
let geminiClient: GoogleGenAI | null = null;
const getGemini = () => (geminiClient ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }));

/* ── Cache ────────────────────────────────────────────────────────── */

const keyOf = (system: string, user: string, schema: unknown) =>
  createHash('sha1').update(system + ' ' + user + ' ' + JSON.stringify(schema)).digest('hex');

export type LLMResult<T> = { data: T; engine: 'llm' | 'llm-cache' };

/* ── Gemini call ──────────────────────────────────────────────────── */

async function callGemini<T>(
  system: string, user: string, _schema: Record<string, unknown>,
): Promise<T> {
  const ai = getGemini();
  // Use responseMimeType for JSON guarantee but skip responseSchema —
  // Gemini's schema enforcement garbles Arabic text in field values.
  // The system prompt already specifies the exact shape.
  const res = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: user,
    config: {
      systemInstruction: system + '\nReturn ONLY valid JSON matching the schema described above. Preserve all Arabic text exactly as written.',
      responseMimeType: 'application/json',
    },
  });
  const text = res.text;
  if (!text) throw new LLMUnavailable('empty Gemini response');
  return JSON.parse(text) as T;
}

/* ── Anthropic call ───────────────────────────────────────────────── */

async function callAnthropic<T>(
  system: string, user: string, schema: Record<string, unknown>, maxTokens: number,
): Promise<T> {
  const res = await getAnthropic().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  } as any);

  if ((res as any).stop_reason === 'refusal')
    throw new LLMUnavailable('request was declined by safety classifiers');

  const text = (res.content as any[]).find(b => b.type === 'text')?.text;
  if (!text) throw new LLMUnavailable('empty response');
  return JSON.parse(text) as T;
}

/* ── Main entry point ─────────────────────────────────────────────── */

/**
 * One structured call. Cached results never touch the network, so a warmed cache
 * means the demo runs with the wifi off. Throws LLMUnavailable when there is no
 * key and no cache entry — callers fall back to the rule engine.
 */
export async function callStructured<T>(
  system: string, user: string, schema: Record<string, unknown>, maxTokens = 1024,
): Promise<LLMResult<T>> {
  const file = join(CACHE_DIR, keyOf(system, user, schema) + '.json');
  if (USE_CACHE && existsSync(file)) {
    try { return { data: JSON.parse(readFileSync(file, 'utf8')) as T, engine: 'llm-cache' }; }
    catch { /* corrupt entry - fall through and re-fetch */ }
  }

  const p = provider();
  if (p === 'none') throw new LLMUnavailable('no API key set (GEMINI_API_KEY or ANTHROPIC_API_KEY) and no cache entry');

  let data: T;
  try {
    if (p === 'gemini') {
      data = await callGemini<T>(system, user, schema);
    } else {
      data = await callAnthropic<T>(system, user, schema, maxTokens);
    }
  } catch (e: any) {
    if (e instanceof LLMUnavailable) throw e;
    throw new LLMUnavailable(`${p} call failed: ${e?.message ?? e}`);
  }

  if (USE_CACHE) writeFileSync(file, JSON.stringify(data, null, 2));
  return { data, engine: 'llm' };
}

export const llmReady = () => hasGemini() || hasAnthropic();
export const llmProvider = () => provider();

/* ---------------- Prompt A - address extraction ---------------- */
export const ADDRESS_SYSTEM = [
  'You extract structured data from Palestinian descriptive addresses written in',
  'Arabic dialect, MSA, or mixed Arabic/English.',
  'Rules: preserve original Arabic names exactly; landmarks include mosques, shops,',
  'roundabouts, pharmacies, schools and hospitals; a phrase starting with the word',
  'for "building" is a building, not a landmark; floor expressions become a bare',
  'number as a string; convert Arabic-Indic digits to Western digits;',
  'do not invent fields that are not present in the text.',
].join(' ');

export const ADDRESS_SCHEMA = {
  type: 'object',
  properties: {
    city: { type: ['string', 'null'] },
    area: { type: ['string', 'null'] },
    landmarks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['mosque','church','pharmacy','supermarket','school','roundabout','hospital','shop','other'] },
        },
        required: ['name', 'type'], additionalProperties: false,
      },
    },
    building: { type: ['string', 'null'] },
    floor: { type: ['string', 'null'] },
    apartment: { type: ['string', 'null'] },
    relations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          relation: { type: 'string', enum: ['near','next_to','behind','opposite','above','below','after','before','at','inside','between','entrance_of','downslope','upslope','start_of','end_of'] },
          object: { type: 'string' },
        },
        required: ['subject','relation','object'], additionalProperties: false,
      },
    },
    notes: { type: ['string', 'null'] },
  },
  required: ['city','area','landmarks','building','floor','apartment','relations','notes'],
  additionalProperties: false,
};

/* ---------------- Prompt B - road / checkpoint post ---------------- */
export const ROAD_SYSTEM = [
  'You extract road and checkpoint status from Palestinian community posts',
  '(Telegram/WhatsApp style, dialect Arabic).',
  'Dialect vocabulary: words meaning "flowing/open" map to open; words meaning',
  '"crowding/jam" map to congested; words meaning "shut/blocked" map to closed.',
  'A "flying checkpoint" is a temporary checkpoint.',
  'If the post is not about roads, set is_road_related to false and return an empty mentions array.',
].join(' ');

export const ROAD_SCHEMA = {
  type: 'object',
  properties: {
    is_road_related: { type: 'boolean' },
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          place: { type: 'string' },
          kind: { type: 'string', enum: ['checkpoint','road','junction'] },
          status: { type: 'string', enum: ['open','congested','closed','unknown'] },
          severity: { type: ['string','null'], enum: ['low','medium','high', null] },
          alternative_route: { type: ['string','null'] },
        },
        required: ['place','kind','status','severity','alternative_route'],
        additionalProperties: false,
      },
    },
  },
  required: ['is_road_related','mentions'], additionalProperties: false,
};

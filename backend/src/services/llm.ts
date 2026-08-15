import Anthropic from '@anthropic-ai/sdk';
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

/* Model choice: claude-sonnet-5 is the current Sonnet — it supports structured
   outputs (Sonnet 4.6 does not), which is what turns "please return only JSON"
   into a schema guarantee. Two things it requires that 4.6 did not:
     - no `temperature`: non-default sampling parameters are rejected
     - `thinking` must be disabled explicitly, because adaptive thinking is ON by
       default and would add seconds of latency to every parse on stage. */
const MODEL = process.env.LLM_MODEL ?? 'claude-sonnet-5';
const USE_CACHE = process.env.LLM_CACHE !== '0';
const hasKey = () => !!process.env.ANTHROPIC_API_KEY;

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

const keyOf = (system: string, user: string, schema: unknown) =>
  createHash('sha1').update(MODEL + ' ' + system + ' ' + user +
                            ' ' + JSON.stringify(schema)).digest('hex');

export type LLMResult<T> = { data: T; engine: 'llm' | 'llm-cache' };

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
  if (!hasKey()) throw new LLMUnavailable('ANTHROPIC_API_KEY not set and no cache entry');

  let res: any;
  try {
    res = await getClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    } as any);
  } catch (e: any) {
    throw new LLMUnavailable('Anthropic call failed: ' + (e?.message ?? e));
  }

  if (res.stop_reason === 'refusal')
    throw new LLMUnavailable('request was declined by safety classifiers');

  const text = (res.content as any[]).find(b => b.type === 'text')?.text;
  if (!text) throw new LLMUnavailable('empty response');

  let data: T;
  try { data = JSON.parse(text) as T; }
  catch { throw new LLMUnavailable('response was not valid JSON'); }

  if (USE_CACHE) writeFileSync(file, JSON.stringify(data, null, 2));
  return { data, engine: 'llm' };
}

export const llmReady = () => hasKey();

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

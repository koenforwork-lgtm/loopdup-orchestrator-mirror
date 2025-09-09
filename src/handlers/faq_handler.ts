// src/handlers/faq_handler.ts
/**
 * FAQ Handler
 *
 * Looks up FAQ answers via embeddings + trigram fallback.
 *
 * ✅ Only replies to guest via replyFromBot.
 * 🚫 Never changes Chatwoot conversation status here — status is controlled
 *    only via escalation_handler (open/resolved) and adapter safeguards.
 */

import fetch from 'node-fetch';
import { db } from '../repos/db';
import type { HandlerResult } from '../app/types';

type FaqRow = {
  id: string;
  question: string;
  answer: string;
  lang: string;
  sim?: number;
  trgm_sim?: number;
};

/** Generate embeddings from OpenAI */
async function embed(
  text: string,
  apiKey = process.env.OPENAI_API_KEY || ''
): Promise<number[]> {
  if (!apiKey) throw new Error('[faq_handler] OPENAI_API_KEY missing');
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });
  if (!r.ok) throw new Error(`[faq_handler] embed http ${r.status}`);
  const j = (await r.json()) as any;
  return j?.data?.[0]?.embedding as number[];
}

/** FAQ handler — try semantic match, then trigram fallback */
export async function handleFaq(event: any, settings?: any): Promise<HandlerResult> {
  const { propertyId, conversationId, text = '', lang = 'en' } = event;
  const opts = {
    faq_sem_threshold: settings?.faq_sem_threshold ?? 0.78, // semantic similarity (0–1)
    trgm_threshold: settings?.trgm_min_similarity ?? 0.35,  // trigram similarity (0–1)
  };

  let best: FaqRow | null = null;

  // --- 1) Semantic search (pgvector)
  try {
    const v = await embed(text);
    // pgvector requires a bracketed string, not a JS array
    const vStr = `[${v.join(',')}]`;

    const vr = await db.query<FaqRow>(
      `
      SELECT f.id, f.question, f.answer, f.lang,
             (1 - (fe.embedding <=> $1::vector)) AS sim
        FROM faq_embeddings fe
        JOIN faqs f ON f.id = fe.faq_id
       WHERE f.property_id = $2
         AND (f.lang = $3 OR f.lang = 'en')
       ORDER BY fe.embedding <=> $1::vector ASC
       LIMIT 5
      `,
      [vStr, propertyId, lang]
    );

    best = vr.rows?.[0] || null;
    if (best && (best.sim ?? 0) >= opts.faq_sem_threshold) {
      return {
        handled: true,
        reply: best.answer,
        meta: { source: 'vector', id: best.id, score: best.sim },
      };
    }
  } catch (e) {
    console.error('[faq_handler] vector search error', e);
    // fall through to trigram
  }

  // --- 2) Trigram fallback
  const tr = await db.query<FaqRow>(
    `
    SELECT f.id, f.question, f.answer, f.lang,
           similarity(f.question, $1) AS trgm_sim
      FROM faqs f
     WHERE f.property_id = $2
       AND (f.lang = $3 OR f.lang = 'en')
     ORDER BY f.question <-> $1
     LIMIT 5
    `,
    [text, propertyId, lang]
  );
  const tbest = tr.rows?.[0];
  if (tbest && (tbest.trgm_sim ?? 0) >= opts.trgm_threshold) {
    return {
      handled: true,
      reply: tbest.answer,
      meta: { source: 'trgm', id: tbest.id, score: tbest.trgm_sim },
    };
  }

  // --- 3) Nothing confident — let router handle clarification/escalation
  return { handled: false, reason: 'no_confident_match', meta: { source: 'none' } };
}

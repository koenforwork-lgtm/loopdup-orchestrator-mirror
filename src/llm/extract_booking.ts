// src/llm/extract_booking.ts
// Tiny LLM extractor for the FIRST user message only.
// Guard with LLM_SLOT_PREFILL=true so you can switch it off instantly.
// Returns a partial object: {guests?, time?, date?, name?} with values
// as they appear in the original sentence (to be normalized by your parser).
// Model/base are resolved via presets in ../config/llm.

export type BookingEntities = {
  guests?: number | string;
  time?: string;
  date?: string;
  name?: string;
};

import { resolveModel, resolveBaseURL } from '../config/llm';

// If your TypeScript config doesn't include DOM lib, these declarations
// prevent compile-time errors while still using Node 18+ global fetch at runtime.
declare const fetch: any;
declare const AbortController: any;

function isDisabled(): boolean {
  const flag = String(process.env.LLM_SLOT_PREFILL || '').toLowerCase() === 'true';
  const hasKey = !!process.env.OPENAI_API_KEY;
  return !(flag && hasKey);
}

function sanitizeModelJSON(text: string): string {
  if (!text) return '';
  // strip code fences if any
  let t = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  // take largest {...} block
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  return first !== -1 && last !== -1 && last > first ? t.slice(first, last + 1) : t;
}

function keepOnlyKnownKeys(obj: any): BookingEntities {
  const out: BookingEntities = {};
  if (!obj || typeof obj !== 'object') return out;

  if (obj.guests !== undefined) out.guests = obj.guests;
  if (typeof obj.time === 'string' && obj.time.trim()) out.time = obj.time.trim();
  if (typeof obj.date === 'string' && obj.date.trim()) out.date = obj.date.trim();
  if (typeof obj.name === 'string' && obj.name.trim()) out.name = obj.name.trim();
  return out;
}

/** Extract from FIRST user message. Safe-by-default: returns {} if disabled or on error. */
export async function extractBookingEntitiesLLM(message: string, tenantId?: string): Promise<BookingEntities> {
  if (!message || isDisabled()) return {};

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    if (controller) setTimeout(() => controller.abort(), 5000); // 5s hard timeout

    const model = resolveModel('extract_booking', tenantId);
    const base  = resolveBaseURL(tenantId);

    const body: any = {
      model,
      messages: [
        {
          role: 'system',
          content: [
            // TASK
            'You extract booking fields from ONE user sentence for a restaurant/table booking.',
            // OUTPUT CONTRACT
            'Return ONLY compact JSON with up to these keys: guests, time, date, name. No commentary, no extra keys.',
            'If a field is not present, omit it entirely (do NOT invent).',
            // FIELD RULES (keep parser compatibility)
            'guests: Prefer a single total number as a string (e.g., "6"). If the user says "4 adults and 2 kids", SUM them and return "6".',
            'time: Only include if a numeric clock time is provided (e.g., "8", "8pm", "19:30", "7.30", "noon", "midnight"). Do NOT return dayparts like "breakfast/lunch/dinner/evening/tonight" as time.',
            'date: Calendar references only (e.g., "friday", "tomorrow", "1/9", "01-09", "1 september").',
            'name: A short name near cues like "under", "under the name", "name is", or "for". Do not copy the whole sentence.',
            // DISAMBIGUATION GUARDS
            'Never mistake a time like "8pm" for guests. Never mistake a number near "people/pax/guests" for time.',
            'Do not guess missing fields. Be minimal and precise.',
            // EXAMPLES
            'User: "book a table for friday 8pm for 2 people under koen"',
            'Return: {"date":"friday","time":"8pm","guests":"2","name":"koen"}',
            'User: "book a tabe friday 5 in the evening 6 person under Anna"', // typo "tabe"
            'Return: {"date":"friday","time":"5","guests":"6","name":"Anna"}',
            'User: "I want to book for 4 adults and 2 kids tomorrow at 19:30 under Dibbets"',
            'Return: {"date":"tomorrow","time":"19:30","guests":"6","name":"Dibbets"}',
            'User: "table for breakfast tomorrow for 2 under Max"', // no numeric time
            'Return: {"date":"tomorrow","guests":"2","name":"Max"}'
          ].join(' ')
        },
        { role: 'user', content: message }
      ],
      temperature: 0
    };

    // Prefer JSON-mode if the endpoint supports it (ignored by some providers; harmless)
    (body as any).response_format = { type: 'json_object' };

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller?.signal
    });

    if (!res?.ok) return {};

    const data = await res.json();
    const raw: string =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      '';

    const jsonText = sanitizeModelJSON(raw);
    if (!jsonText) return {};

    try {
      const parsed = JSON.parse(jsonText);
      return keepOnlyKnownKeys(parsed);
    } catch {
      return {};
    }
  } catch {
    return {};
  }
}

// src/handlers/service_handler.ts
/**
 * Service Handler
 *
 * Detects and processes service requests (booking, late checkout, spa, etc.).
 *
 * ✅ May add labels, priority, and staff notes.
 * ✅ May return escalate=true to trigger escalation flow.
 * 🚫 Must never update Chatwoot conversation status directly.
 *     Status is controlled only via escalation_handler (open/resolved).
 */

export type ServiceRequest = {
  intent: string;        // e.g. 'SERVICE'
  text: string;          // the raw user message
  norm?: string;         // optional normalized text from router
  tenantId?: string;     // optional, for multi-property support
  conversationId: number | string;   // 🔑 needed for labels/priority/notes
  // optional: future-proof hook if router starts passing language
  // preferred_lang?: string;
};

export type ServiceResult = {
  handled: boolean;
  reply?: string;
  escalate?: boolean;
  reason?: string;       // why we escalated or didn’t handle
  meta?: Record<string, any>;
};

import { findServiceKeyByText, getServiceActions } from '../repos/service_repo';
import {
  addLabels,
  addPrivateMessage,
  updateConversationPriority,
  sendTypingOn,
  sendTypingOff,
  replyFromBot,
  getConversation,
} from '../adapters/chatwoot_adapter';
import { getServiceFlow as getState, setServiceFlow as setState } from '../repos/conv_state_repo';
import {
  parseGuests,
  parseTime,
  parseDate,
  parseName,
  prettyTime,
  prettyDate,
  isDateUnclear,
  normalizeTime,
  normalizeDateToISO,
  isTimeUnclear,
} from '../utils/service_parser';

import { UI } from '../ui';
import { extractBookingEntitiesLLM } from '../llm/extract_booking';
const LLM_SLOT_PREFILL = (process.env.LLM_SLOT_PREFILL || '').toLowerCase() === 'true';
import { validateBookingSlots } from '../ai/validators/when_validator';

// ✅ NEW: Messenger quick replies (same mechanism as smalltalk handler)
import { sendMessengerQuickReplies, sendMessengerButtons, type MessengerQuickReply } from '../adapters/messenger_sender';
import { savePsidMapping } from '../repos/psid_map_repo';

function formatUI(tpl: string, vars: Record<string, string | number | undefined> = {}) {
  let s = tpl;
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`\\{${k}\\}`, 'g');
    s = s.replace(re, v == null ? '' : String(v));
  }
  return s;
}

function resolveLang(reqLang?: string): keyof typeof UI {
  const envLang = (process.env.DEFAULT_LANG || 'en').toLowerCase();
  const cand = (reqLang || envLang) as keyof typeof UI;
  return UI[cand] ? cand : 'en';
}

// Keep minutes when clarifying (e.g., 5:30 → “5:30 pm”)
function extractTimeToken(text: string, fallback: string): string {
  // prefer "H:MM" or "H.MM" if present in the original message
  const m = text.match(/\b(\d{1,2})([:.](\d{2}))\b/);
  return m ? m[0].replace('.', ':') : fallback;
}

// Format AM PM
function formatAmPm(time: string): string {
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return time;
  let hh = parseInt(m[1], 10);
  const mm = m[2];
  const period = hh >= 12 ? "PM" : "AM";
  if (hh === 0) hh = 12;
  if (hh > 12) hh = hh - 12;
  return `${hh}:${mm} ${period}`;
}

// ✅ Uppercase Name
function toTitleCase(name: string): string {
  return name
    .split(/\s+/)
    .map(word =>
      word.length > 0
        ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        : ''
    )
    .join(' ');
}

function buildDetailsSummary(collected: Record<string, any>): string {
  return [
    collected.name ? `Name: ${toTitleCase(String(collected.name))}` : null,
    collected.guests ? `Guests: ${collected.guests}` : null,
    collected.time ? `Time: ${formatAmPm(String(collected.time))}` : null,
    collected.date ? `Date: ${collected.date}` : null,
  ]
    .filter(Boolean)
    .join('\\n');
}

// ✅ Synonym dictionary for clarifier (multi-lang + typos/abbreviations)
const TIME_PERIOD_SYNONYMS: Record<string, { am: string[]; pm: string[] }> = {
  en: {
    am: ['am', 'a.m.', 'morning', 'mrn', 'morn', 'moorning'],
    pm: ['pm', 'p.m.', 'evening', 'eve', 'evng', 'evning', 'night', 'ngt', 'nigt', 'afternoon', 'aft'],
  },
  vi: {
    am: ['sáng', 'buổi sáng'],
    pm: ['chiều', 'buổi chiều', 'tối', 'buổi tối', 'đêm'],
  },
  nl: {
    am: ['ochtend', "'s ochtends", "smorgens"],
    pm: ['middag', "'s middags", 'avond', "'s avonds", 'nacht'],
  },
};

const REGISTRY: Record<string, { patterns: RegExp[]; reply: string }> = {
  BOOK_TABLE: {
    patterns: [
      /reserv(e|ation)/i,
      /book\s+a\s+table/i,
      /book.{0,12}tabl[e]?/i,
      /table\s+for\s+\d+/i,
      /can\s+i\s+book\s+a\s+table/i,
      /book.{0,12}tbale/i,
      /bok.{0,12}table/i,
      /b00k.{0,12}table/i,
    ],
    reply: "I can help with a table booking. Please share: date, time, number of guests, and a name. I’ll confirm availability right away.",
  },
  LATE_CHECKOUT: {
    patterns: [/late\s*check\s*out/i, /extend\s*checkout/i],
    reply: "Late checkout is usually possible. What time would you prefer? I’ll check availability and confirm any fee.",
  },
  SPA_BOOKING: {
    patterns: [/spa.*(book|reserve)/i, /(massage|facial|treatment).*book/i],
    reply: "Great choice! Tell me your preferred date/time and treatment type, and I’ll arrange the spa booking for you.",
  },
};
function matchService(text: string): { key?: string } {
  for (const [key, cfg] of Object.entries(REGISTRY)) {
    if (cfg.patterns.some((rx) => rx.test(text))) {
      return { key };
    }
  }
  return {};
}

const REQUIRED_FIELDS: Record<string, string[]> = {
  BOOK_TABLE: ['guests', 'time', 'date', 'name'],
  LATE_CHECKOUT: ['time', 'name'],
  SPA_BOOKING: ['date', 'time', 'name'],
};
function parseForField(field: string, text: string): any | null {
  switch (field) {
    case 'guests': return parseGuests(text);
    case 'time':   return parseTime(text);
    case 'date':   return parseDate(text);
    case 'name':   return parseName(text);
    default:       return null;
  }
}

function timeNeedsAmPm(userText: string, rawParsed: string): boolean {
  // ✅ Only trigger clarification if unclear or missing AM/PM
  if (isTimeUnclear && isTimeUnclear(userText)) {
    return true;
  }
  if (!rawParsed) return false;

  // already contains am/pm → no clarification needed
  if (/am|pm/i.test(userText)) return false;

  // check if hour is in 1–12 range (ambiguous without AM/PM)
  const m = rawParsed.match(/^(\d{1,2})(?::\d{2})?/);
  if (!m) return false;
  const hour = parseInt(m[1], 10);

  // 13–23 → unambiguous (24h format)
  if (hour >= 13) return false;

  // require clarification if in 1–12 range
  return hour >= 1 && hour <= 12;
}

function askPrompt(field: string, lang: keyof typeof UI): string {
  switch (field) {
    case 'guests': return "How many guests?";
    case 'time':   return UI[lang]?.ask_time ?? "What time would you like?";
    case 'date':   return "📅 Which date?";
    case 'name':   return "Under what name should I put the booking?";
    default:       return "Could you share a few more details?";
  }
}

// Build prompt + optional quick replies for the next question
function buildPrompt(field: string, lang: keyof typeof UI): { text: string; quickReplies?: Array<{ title: string; payload: string }> } {
  if (field === 'date') {
    return {
      text: UI[lang]?.ask_date ?? "📅 Which date?",
      quickReplies: [
        { title: UI[lang]?.qr_today ?? "Today", payload: "today" },
        { title: UI[lang]?.qr_tomorrow ?? "Tomorrow", payload: "tomorrow" },
      ],
    };
  }
  return { text: askPrompt(field, lang) };
}

async function prefillFromMessage(text: string, serviceKey?: string) {
  const out: Record<string, any> = {};
  const g = parseGuests(text);
  if (g) out.guests = g;

  const tRaw = parseTime(text);
  if (tRaw) {
    if (timeNeedsAmPm(text, String(tRaw))) {
      const token = extractTimeToken(text, String(tRaw));
      out.__pending_time_raw = token;
    } else {
      out.time = prettyTime(String(tRaw));
    }
  }

  const iso = normalizeDateToISO(text);
  const dRaw = iso ? iso : parseDate(text);
  if (dRaw && !(dRaw && isDateUnclear(String(dRaw)))) {
    out.date = prettyDate(String(dRaw));
  }

  const n = parseName(text);
  if (n) out.name = n;

  if (LLM_SLOT_PREFILL) {
    try {
      const llm = await extractBookingEntitiesLLM(text);
      const validated = await validateBookingSlots(
        { ...llm, service: serviceKey || (llm as any).service || 'service' },
        { minConfidence: Number(process.env.WHEN_LLM_MIN_CONFIDENCE ?? 0.7), isKnownService: () => true }
      );

      if (!validated.ok && validated.needs_clarify === 'time_period' && (llm as any).time && !out.time && !out.__pending_time_raw) {
        out.__pending_time_raw = String((llm as any).time);
        return out;
      }

      if (validated.ok) {
        const norm = validated.normalized;
        if (llm.guests != null && out.guests == null) {
          const g2 = parseGuests(String(llm.guests));
          if (g2) out.guests = g2;
        }
        if (!out.time && norm.time) out.time = prettyTime(norm.time);
        if (!out.date && norm.date) out.date = prettyDate(norm.date);
        if (llm.name && out.name == null) {
          const n2 = parseName(String(llm.name));
          if (n2) out.name = n2;
        }
      }
    } catch (e) {
      console.warn('[service_handler] LLM prefill/validate failed (non-fatal)', e);
    }
  }
  return out;
}

// ✅ NEW: small helper to ensure typing bubble toggles reliably around slow work
async function withTyping<T>(conversationId: number | string, work: () => Promise<T>): Promise<T> {
  await sendTypingOn(conversationId);
  try {
    return await work();
  } finally {
    try { await sendTypingOff(conversationId); } catch {}
  }
}

// ✅ NEW: PSID extractor (same logic used in smalltalk handler)
function extractPsid(conv: any): string | null {
  return (
    conv?.meta?.sender?.source_id ||
    conv?.contact_inbox?.source_id ||
    conv?.last_non_activity_message?.conversation?.contact_inbox?.source_id ||
    conv?.messages?.[0]?.conversation?.contact_inbox?.source_id ||
    null
  );
}

// ✅ NEW: best-effort Messenger buttons sender (returns true if sent)
async function maybeSendMessengerQR(
  conversationId: number | string,
  text: string,
  quickReplies?: Array<{ title: string; payload: string }>
): Promise<boolean> {
  // Booking flow: use instant text replies by default, not buttons.
  const USE_BUTTONS = (process.env.SERVICE_FLOW_USE_BUTTONS || 'false').toLowerCase() === 'true';
  if (!USE_BUTTONS) return false;
  if (!quickReplies || quickReplies.length === 0) return false;
  try {
    const conv: any = await getConversation(conversationId);
    const psid = extractPsid(conv);
    if (!psid) return false;
    try { await savePsidMapping(psid, conversationId, process.env.PROPERTY_ID || 'default'); } catch {}
    // Send as BUTTONS (not quick replies), per product decision
    await sendMessengerButtons(psid, text, quickReplies.map(q => ({ type: 'postback', title: q.title, payload: q.payload })));
    // Mirror to Chatwoot privately to avoid double public messages
    try { await replyFromBot(conversationId, text, { private: true }); } catch {}
    return true;
  } catch (e) {
    console.warn('[service_handler] messenger quick replies send failed', e);
    return false;
  }
}

type BookingDetails = {
  name?: string;
  guests?: number;
  date?: string;
  time?: string;
};

function normalizeYesNo(text: string): 'yes' | 'no' | null {
  const s = text.trim().toLowerCase();
  if (['yes', 'y', 'yeah', 'yep', 'sure', 'ok', 'okay'].includes(s)) return 'yes';
  if (['no', 'n', 'nope', 'nah'].includes(s)) return 'no';
  return null;
}

function buildConfirmMessage(details: BookingDetails): string {
  return [
    'Please confirm your booking details:',
    `• Name: ${details.name ? toTitleCase(String(details.name)) : '-'}`,
    `• Guests: ${details.guests ?? '-'}`,
    `• Date: ${details.date ?? '-'}`,
    `• Time: ${details.time ? formatAmPm(String(details.time)) : '-'}`,
    "Reply 'Yes' to send, or 'No' to edit.",
  ].join('\n');
}

function tryFieldUpdate(text: string, current: BookingDetails): BookingDetails | null {
  const updated: BookingDetails = { ...current };
  let changed = false;

  const g = parseGuests(text);
  if (g) { updated.guests = g; changed = true; }

  const tRaw = parseTime(text);
  if (tRaw) { updated.time = prettyTime(String(tRaw)); changed = true; }

  const iso = normalizeDateToISO(text);
  const dRaw = iso ? iso : parseDate(text);
  if (dRaw && !(dRaw && isDateUnclear(String(dRaw)))) {
    updated.date = prettyDate(String(dRaw));
    changed = true;
  }

  const n = parseName(text);
  if (n) { updated.name = n; changed = true; }

  return changed ? updated : null;
}

async function notifyStaff(conversationId: number | string, details: BookingDetails) {
  const lines = [
    details.name ? `Name: ${toTitleCase(String(details.name))}` : null,
    details.guests ? `Guests: ${details.guests}` : null,
    details.date ? `Date: ${details.date}` : null,
    details.time ? `Time: ${formatAmPm(String(details.time))}` : null,
  ].filter(Boolean).join('\n');

  await addLabels(conversationId, ['booking-request']);
  await addPrivateMessage(conversationId, lines || 'Booking request received (no details parsed).');
}

export async function handleService(req: ServiceRequest): Promise<ServiceResult> {
  const message = (req.norm || req.text || '').trim();
  const tenantId = req.tenantId || 'default';
  const lang = resolveLang((req as any).preferred_lang);

  if (!message) return { handled: false, escalate: true, reason: 'empty_message' };

  const existingFlow = await getState(req.conversationId);
  if (existingFlow?.pending) {
    const step = (existingFlow as any).step;
    const pending: BookingDetails = { ...(existingFlow as any).pending };
    if (step === 'confirm') {
      const yn = normalizeYesNo(message);
      if (yn === 'yes') {
        await notifyStaff(req.conversationId, pending);
        await setState(req.conversationId, null);
        return {
          handled: true,
          escalate: true,
          reply: '✅ Great! I’ve sent your booking request to our team. We’ll confirm availability shortly.',
          meta: { step: 'confirmed' }
        };
      }
      if (yn === 'no') {
        await setState(req.conversationId, { pending, step: 'ask_change' });
        return {
          handled: true,
          reply: 'No problem. What would you like to change? (name / guests / date / time)',
          meta: { step: 'ask_change' }
        };
      }
      return {
        handled: true,
        reply: buildConfirmMessage(pending),
        meta: { step: 'confirm_repeat' }
      };
    }
    if (step === 'ask_change') {
      const updated = tryFieldUpdate(message, pending);
      if (updated) {
        await setState(req.conversationId, { pending: updated, step: 'confirm' });
        return {
          handled: true,
          reply: buildConfirmMessage(updated),
          meta: { step: 'confirm_after_edit' }
        };
      }
      return {
        handled: true,
        reply: "I didn’t catch that. You can say things like '3 guests', 'time 7:15pm', or 'name is Anna'.",
        meta: { step: 'edit_unrecognized' }
      };
    }
  }
  if (existingFlow?.service_key) {
    const required = existingFlow.required || REQUIRED_FIELDS[existingFlow.service_key] || [];
    const collected = { ...(existingFlow.collected || {}) };

    if (existingFlow.next === 'confirm') {
      const lower = message.toLowerCase();
      const yes = /^y(es)?$/i.test(lower);
      const no = /^n(o)?$/i.test(lower);

      if (yes) {
        const summary = Object.entries(collected)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        try {
          await addLabels(
            req.conversationId,
            ['service_request', `svc_${existingFlow.service_key.toLowerCase()}`, 'needs_staff']
          );
          await updateConversationPriority(req.conversationId, 'high');
          await addPrivateMessage(req.conversationId, `👀 Completed ${existingFlow.service_key} — ${summary}`);
        } catch (e) {
          console.warn('[service_handler] failed to finalize labels/priority/notes (confirm)', e);
        }
          await setState(req.conversationId, null);

        const detailsLines = buildDetailsSummary(collected);
        const confirmation =
          `Got it 👍 I’ve sent this to the team to confirm availability. You’ll get a message shortly.` +
          (detailsLines ? `\n\nDetails:\n${detailsLines}` : '');

        const sent = await maybeSendMessengerQR(req.conversationId, confirmation);
        if (sent) {
          return {
            handled: true,
            reply: undefined,
            meta: {
              service_key: existingFlow.service_key,
              step: 'confirmed_final',
              sent_via_messenger: true,
            },
          };
        }

        return {
          handled: true,
          reply: confirmation,
          meta: { service_key: existingFlow.service_key, step: 'confirmed_final' },
        };
      }

      if (no) {
        const first = required[0];
        const restartFlow: any = { ...existingFlow, collected: {}, required, next: first };
        await setState(req.conversationId, restartFlow);

        const prompt = buildPrompt(first, lang);
        const restartText = `No problem, let’s try again.\n${prompt.text}`;
        const sent = await maybeSendMessengerQR(req.conversationId, restartText, prompt.quickReplies);
        if (sent) {
          return {
            handled: true,
            reply: undefined,
            meta: {
              service_key: existingFlow.service_key,
              step: 'confirm_restart',
              sent_via_messenger: true,
              ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {}),
            },
          };
        }

        return {
          handled: true,
          reply: restartText,
          meta: {
            service_key: existingFlow.service_key,
            step: 'confirm_restart',
            ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {}),
          },
        };
      }

      const detailsLines = buildDetailsSummary(collected);
      const confirmText = `Please confirm:\n${detailsLines}\n\nIs this correct?`;
      const qrs = [
        { title: 'Yes', payload: 'YES' },
        { title: 'No', payload: 'NO' },
      ];
      const sent = await maybeSendMessengerQR(req.conversationId, confirmText, qrs);
      if (sent) {
        return {
          handled: true,
          reply: undefined,
          meta: {
            service_key: existingFlow.service_key,
            step: 'confirm_repeat',
            sent_via_messenger: true,
            quick_replies: qrs,
            quickReplies: qrs,
          },
        };
      }

      return {
        handled: true,
        reply: confirmText,
        meta: {
          service_key: existingFlow.service_key,
          step: 'confirm_repeat',
          quick_replies: qrs,
          quickReplies: qrs,
        },
      };
    }

    const currentMissing = required.filter((f: string) => !collected[f]);
    const currentField = existingFlow.next || currentMissing[0];

    // --- MULTI-LANG CLARIFIER (PATCHED: merge AM/PM, clear pending, confirm, then continue/finalize) ---
    let apClarified = false;
    if ((existingFlow as any).pending_time_raw) {
      const apOnly = message.trim().toLowerCase();
      const hasPending = (existingFlow as any).pending_time_raw;
      if (hasPending) {
        const synonyms = TIME_PERIOD_SYNONYMS[lang] || TIME_PERIOD_SYNONYMS['en'];
        let combined: string | null = null;

        if (synonyms.am.some((s) => apOnly.includes(s)) || /^am$/.test(apOnly)) {
          combined = `${hasPending} am`;
        } else if (synonyms.pm.some((s) => apOnly.includes(s)) || /^pm$/.test(apOnly)) {
          combined = `${hasPending} pm`;
        } else if (/am|pm/.test(apOnly)) {
          combined = `${hasPending} ${apOnly}`;
        } else if (parseTime(apOnly)) {
          // user retyped a full time; accept it
          combined = String(apOnly);
        }

        if (combined) {
          (collected as any).time = prettyTime(combined);
          apClarified = true;

          // compute remaining fields after setting time
          const remaining = required.filter((f: string) => !collected[f]);
          const next = remaining[0] || null;

          // clear pending flag in flow and save updated state
          const flowToSave: any = { ...existingFlow, collected, required, next };
          delete flowToSave.pending_time_raw;
          await setState(req.conversationId, flowToSave);

          // If we still need more info → confirm + ask next (with quick replies when applicable)
          if (next) {
            const prompt = buildPrompt(next, lang);
            const combinedText = `Got it 👍 ${formatAmPm(prettyTime(combined))}\n${prompt.text}`;
            const sent = await maybeSendMessengerQR(req.conversationId, combinedText, prompt.quickReplies);
            if (sent) {
              return {
                handled: true,
                // suppress public echo (Messenger already got it; staff see private mirror)
                reply: undefined,
                meta: {
                  service_key: existingFlow.service_key,
                  step: 'time_clarified_next',
                  sent_via_messenger: true,
                  ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {})
                }
              };
            }
            return {
              handled: true,
              reply: combinedText,
              meta: {
                service_key: existingFlow.service_key,
                step: 'time_clarified_next',
                ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {})
              }
            };
          }

          // Else: all fields present → ask for confirmation
          const flowToConfirm: any = { ...existingFlow, collected, required, next: 'confirm' };
          await setState(req.conversationId, flowToConfirm);

          const detailsLines = buildDetailsSummary(collected);
          const confirmText = `Please confirm:\n${detailsLines}\n\nIs this correct?`;
          const qrs = [
            { title: 'Yes', payload: 'YES' },
            { title: 'No', payload: 'NO' },
          ];
          const sent = await maybeSendMessengerQR(req.conversationId, confirmText, qrs);
          if (sent) {
            return {
              handled: true,
              reply: undefined,
              meta: {
                service_key: existingFlow.service_key,
                step: 'time_clarified_confirm',
                sent_via_messenger: true,
                quick_replies: qrs,
                quickReplies: qrs,
              },
            };
          }
          return {
            handled: true,
            reply: confirmText,
            meta: {
              service_key: existingFlow.service_key,
              step: 'time_clarified_confirm',
              quick_replies: qrs,
              quickReplies: qrs,
            },
          };
        }
      }
    }
    if (currentField && !apClarified) {
      const val = parseForField(currentField, message);

      if (currentField === 'time' && val) {
        const raw = String(val); // e.g., "7", "19:00", "7.30", "7 pm"
        const normalized = normalizeTime(raw);
        if (!normalized && timeNeedsAmPm(message, raw)) {
          // ⚡ Do not set next="time" → otherwise it will ask again after clarification
          await setState(req.conversationId, {
            ...existingFlow,
            collected,            // keep everything else
            required,
            pending_time_raw: raw // remember the raw hour until AM/PM arrives
          });

          const clarifyText = formatUI(
            UI[lang]?.clarify_time_period ??
            "Just to be sure — {time} in the morning or in the evening?",
            { time: raw }
          );

          // ✅ send Morning/Evening quick replies
          const sent = await maybeSendMessengerQR(req.conversationId, clarifyText, [
            { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
            { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
          ]);

          if (sent) {
            return {
              handled: true,
              reply: undefined, // suppress public echo
              meta: {
                service_key: existingFlow.service_key,
                step: 'time_clarify',
                sent_via_messenger: true,
                quick_replies: [
                  { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                  { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
                ],
                quickReplies: [
                  { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                  { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
                ]
              }
            };
          }

          return {
            handled: true,
            reply: clarifyText,
            meta: {
              service_key: existingFlow.service_key,
              step: 'time_clarify',
              quick_replies: [
                { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
              ],
              quickReplies: [
                { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
              ]
            }
          };
        }

        (collected as any).time = prettyTime(raw);
      } else if (currentField === 'date') {
        const iso = normalizeDateToISO(message);
        if (!iso && (!val || isDateUnclear(String(val)))) {
          await setState(req.conversationId, {
            ...existingFlow,
            collected,
            required,
            next: 'date',
          });
          return {
            handled: true,
            reply: "Sorry, I didn’t catch the date — please reply like “1 September” or “today/tomorrow”.",
            meta: { service_key: existingFlow.service_key, step: 'date_clarify' }
          };
        }
        (collected as any).date = iso ? prettyDate(iso) : prettyDate(String(val));
      } else if (val) {
        (collected as any)[currentField] = val;
      }
    }

    // recompute missing after potential update
    const missing = required.filter((f: string) => !collected[f]);

    if (missing.length > 0) {
      const next = missing[0];
      const flowToSave: any = { ...existingFlow, collected, required, next };
      delete flowToSave.pending_time_raw; // clear any leftover pending hour
      await setState(req.conversationId, flowToSave);

      const prompt = buildPrompt(next, lang);
      const sent = await maybeSendMessengerQR(req.conversationId, prompt.text, prompt.quickReplies);

      if (sent) {
        return {
          handled: true,
          reply: undefined, // suppress public echo
          meta: {
            service_key: existingFlow.service_key,
            step: 'slot_filling',
            sent_via_messenger: true,
            ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {})
          }
        };
      }

      return {
        handled: true,
        reply: prompt.text,
        meta: {
          service_key: existingFlow.service_key,
          step: 'slot_filling',
          ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {})
        }
      };
    } else {
      // completed flow → ask user to confirm details
      const flowToConfirm: any = { ...existingFlow, collected, required, next: 'confirm' };
      await setState(req.conversationId, flowToConfirm);

      const detailsLines = buildDetailsSummary(collected);
      const confirmText = `Please confirm:\n${detailsLines}\n\nIs this correct?`;
      const qrs = [
        { title: 'Yes', payload: 'YES' },
        { title: 'No', payload: 'NO' },
      ];
      const sent = await maybeSendMessengerQR(req.conversationId, confirmText, qrs);
      if (sent) {
        return {
          handled: true,
          reply: undefined,
          meta: {
            service_key: existingFlow.service_key,
            step: 'confirm',
            sent_via_messenger: true,
            quick_replies: qrs,
            quickReplies: qrs,
          },
        };
      }

      return {
        handled: true,
        reply: confirmText,
        meta: {
          service_key: existingFlow.service_key,
          step: 'confirm',
          quick_replies: qrs,
          quickReplies: qrs,
        },
      };
    }
  }
  // --- DB-backed lookup first ---
  try {
    const key = await findServiceKeyByText(message, tenantId);
    if (key) {
      const steps = await getServiceActions(key, tenantId);
      const first = steps[0];

      if (first?.action_type === 'ASK_DETAILS' || first?.action_type === 'REPLY') {
        try {
          await addLabels(req.conversationId, [`service_request`, `svc_${key.toLowerCase()}`]);
          await updateConversationPriority(req.conversationId, 'medium');
          const readable = key.replace(/_/g, ' ').toLowerCase();
          await addPrivateMessage(req.conversationId, `👀 Service request: ${readable}`);
        } catch (e) {
          console.warn('[service_handler] failed to apply labels/priority/notes', e);
        }

        if (REQUIRED_FIELDS[key]) {
          // ✅ Wrap LLM prefill with typing bubble
          const pre = await withTyping(req.conversationId, () => prefillFromMessage(message, key));
          const collected: Record<string, any> = {};
          let pending_time_raw: string | undefined;

          if (pre.guests) collected.guests = pre.guests;
          if (pre.time)   collected.time = pre.time;
          if (pre.date)   collected.date = pre.date;
          if (pre.name)   collected.name = pre.name;
          if (pre.__pending_time_raw) pending_time_raw = pre.__pending_time_raw;

          const required = REQUIRED_FIELDS[key];
          const missing = required.filter((f) => !collected[f]);

          await setState(
            req.conversationId,
            {
              service_key: key,
              required,
              collected,
              next: missing[0] || null,
              ...(pending_time_raw ? { pending_time_raw } : {})
            }
          );

          if (pending_time_raw) {
            const clarifyText = formatUI(
              UI[lang]?.clarify_time_period ??
              "Just to be sure — {time} in the morning or in the evening?",
              { time: pending_time_raw }
            );
            const sent = await maybeSendMessengerQR(req.conversationId, clarifyText, [
              { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
              { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
            ]);

            if (sent) {
              return {
                handled: true,
                reply: undefined, // suppress public echo
                meta: {
                  service_key: key,
                  step: 'start_flow_prefill_time_clarify',
                  sent_via_messenger: true,
                  quick_replies: [
                    { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                    { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
                  ],
                  quickReplies: [
                    { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                    { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
                  ]
                }
              };
            }

            return {
              handled: true,
              reply: clarifyText,
              meta: {
                service_key: key,
                step: 'start_flow_prefill_time_clarify',
                quick_replies: [
                  { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                  { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
                ],
                quickReplies: [
                  { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                  { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
                ]
              }
            };
          }

          if (missing.length > 0) {
            const prompt = buildPrompt(missing[0], lang);
            const kickoff = `Yes, I can take your booking.\n${prompt.text}`;

            const sent = await maybeSendMessengerQR(req.conversationId, prompt.text, prompt.quickReplies);

            if (sent) {
              return {
                handled: true,
                reply: undefined, // suppress public echo
                meta: {
                  service_key: key,
                  step: 'start_flow_prefill',
                  sent_via_messenger: true,
                  ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {})
                }
              };
            }

            return {
              handled: true,
              reply: kickoff,
              meta: {
                service_key: key,
                step: 'start_flow_prefill',
                ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {})
              }
            };
          }

          // nothing missing (rare) → ask for confirmation
          await setState(req.conversationId, {
            service_key: key,
            required,
            collected,
            next: 'confirm',
          });

          const detailsLines = buildDetailsSummary(collected);
          const confirmText = `Please confirm:\n${detailsLines}\n\nIs this correct?`;
          const qrs = [
            { title: 'Yes', payload: 'YES' },
            { title: 'No', payload: 'NO' },
          ];
          const sent = await maybeSendMessengerQR(req.conversationId, confirmText, qrs);
          if (sent) {
            return {
              handled: true,
              reply: undefined,
              meta: {
                service_key: key,
                step: 'start_flow_prefill_confirm',
                sent_via_messenger: true,
                quick_replies: qrs,
                quickReplies: qrs,
              },
            };
          }

          return {
            handled: true,
            reply: confirmText,
            meta: {
              service_key: key,
              step: 'start_flow_prefill_confirm',
              quick_replies: qrs,
              quickReplies: qrs,
            },
          };
        }

        // If not a slot-filling service, reply with template
        return {
          handled: true,
          reply: first.reply_template || REGISTRY[key]?.reply,
          meta: { service_key: key, step: first.action_type, requires: first.requires_fields || null }
        };
      }

      if (first?.action_type === 'ESCALATE') {
        return { handled: false, escalate: true, reason: 'db_action_escalate', meta: { service_key: key } };
      }

      if (REGISTRY[key]) {
        return { handled: true, reply: REGISTRY[key].reply, meta: { service_key: key, step: 'FALLBACK' } };
      }
    }
  } catch (e) {
    // DB failure → safe fallback to regex below
  }

  // --- Regex fallback ---
  {
    const { key } = matchService(message);
    if (key) {
      try {
        await addLabels(req.conversationId, [`service_request`, `svc_${key.toLowerCase()}`]);
        await updateConversationPriority(req.conversationId, 'medium');
        const readable = key.replace(/_/g, ' ').toLowerCase();
        await addPrivateMessage(req.conversationId, `👀 Service request: ${readable}`);
      } catch (e) {
        console.warn('[service_handler] failed to apply labels/priority/notes (regex)', e);
      }

      if (REQUIRED_FIELDS[key]) {
        // ✅ Wrap LLM prefill with typing bubble
        const pre = await withTyping(req.conversationId, () => prefillFromMessage(message, key));
        const collected: Record<string, any> = {};
        let pending_time_raw: string | undefined;

        if (pre.guests) collected.guests = pre.guests;
        if (pre.time)   collected.time = pre.time;
        if (pre.date)   collected.date = pre.date;
        if (pre.name)   collected.name = pre.name;
        if (pre.__pending_time_raw) pending_time_raw = pre.__pending_time_raw;

        const required = REQUIRED_FIELDS[key];
        const missing = required.filter((f) => !collected[f]);

        await setState(
          req.conversationId,
          {
            service_key: key,
            required,
            collected,
            next: missing[0] || null,
            ...(pending_time_raw ? { pending_time_raw } : {})
          }
        );

        if (pending_time_raw) {
          const clarifyText = formatUI(
            UI[lang]?.clarify_time_period ??
            "Just to be sure — {time} in the morning or in the evening?",
            { time: pending_time_raw }
          );

          const sent = await maybeSendMessengerQR(req.conversationId, clarifyText, [
            { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
            { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
          ]);

          if (sent) {
            return {
              handled: true,
              reply: undefined, // suppress public echo
              meta: {
                service_key: key,
                step: 'start_flow_regex_prefill_time_clarify',
                sent_via_messenger: true,
                quick_replies: [
                  { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                  { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
                ],
                quickReplies: [
                  { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                  { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
                ]
              }
            };
          }

          return {
            handled: true,
            reply: clarifyText,
            meta: {
              service_key: key,
              step: 'start_flow_regex_prefill_time_clarify',
              quick_replies: [
                { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
              ],
              quickReplies: [
                { title: UI[lang]?.qr_morning ?? "Morning (AM)", payload: "AM" },
                { title: UI[lang]?.qr_evening ?? "Evening (PM)", payload: "PM" },
              ]
            }
          };
        }

        if (missing.length > 0) {
          const prompt = buildPrompt(missing[0], lang);
          const kickoff = `Yes, I can take your booking.\n${prompt.text}`;

          const sent = await maybeSendMessengerQR(req.conversationId, prompt.text, prompt.quickReplies);

          if (sent) {
            return {
              handled: true,
              reply: undefined, // suppress public echo
              meta: {
                service_key: key,
                step: 'start_flow_regex_prefill',
                sent_via_messenger: true,
                ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {})
              }
            };
          }

          return {
            handled: true,
            reply: kickoff,
            meta: {
              service_key: key,
              step: 'start_flow_regex_prefill',
              ...(prompt.quickReplies ? { quick_replies: prompt.quickReplies, quickReplies: prompt.quickReplies } : {})
            }
          };
        }

        // nothing missing → ask for confirmation
        await setState(req.conversationId, {
          service_key: key,
          required,
          collected,
          next: 'confirm',
        });

        const detailsLines = buildDetailsSummary(collected);
        const confirmText = `Please confirm:\n${detailsLines}\n\nIs this correct?`;
        const qrs = [
          { title: 'Yes', payload: 'YES' },
          { title: 'No', payload: 'NO' },
        ];
        const sent = await maybeSendMessengerQR(req.conversationId, confirmText, qrs);
        if (sent) {
          return {
            handled: true,
            reply: undefined,
            meta: {
              service_key: key,
              step: 'start_flow_regex_prefill_confirm',
              sent_via_messenger: true,
              quick_replies: qrs,
              quickReplies: qrs,
            },
          };
        }

        return {
          handled: true,
          reply: confirmText,
          meta: {
            service_key: key,
            step: 'start_flow_regex_prefill_confirm',
            quick_replies: qrs,
            quickReplies: qrs,
          },
        };
      }

      return { handled: true, reply: REGISTRY[key].reply, meta: { service_key: key, step: 'REGEX' } };
    }
  }
  // 3) Unknown service → escalate
  try {
    await addPrivateMessage(req.conversationId, `👀 Service request (unrecognized)\nGuest: "${message}"`);
  } catch (e) {
    console.warn('[service_handler] failed to add unknown-service note', e);
  }

  // ✅ FINAL SAFE RETURN (ensures all code paths return)
  return { handled: false, escalate: true, reason: 'unknown_service' };
}

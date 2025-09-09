// packages/orchestrator/src/app/decision_engine.ts
// v6: classifier-only. Do NOT call handlers here.
// Returns { intent, confidence, negative } and logs for observability.

import { isSmalltalk } from '../handlers/smalltalk_handler';
import { getAiSettings } from '../repos/ai_settings_repo';

export type Intent = 'FAQ' | 'SERVICE' | 'CHITCHAT' | 'UNKNOWN';

type DecideInput = {
  text?: string;
  propertyId?: string;
  conversationId?: number | string;
};

type DecideOutput = {
  intent: Intent;
  confidence?: number;
  negative?: boolean;
};

function normalize(t: string) {
  return (t || '').toLowerCase().trim();
}

function detectNegative(t: string) {
  const s = normalize(t);
  // Expandable list; keep focused on real escalation signals
  const negatives = [
    'not happy', 'angry', 'bad', 'terrible', 'awful',
    'leaking', 'leak', 'broken', 'complaint',
    'refund', 'charge dispute', 'dirty', 'rude'
  ];
  return negatives.some(k => s.includes(k));
}

function detectService(t: string) {
  const s = normalize(t);
  const svc = [
    'booking', 'reservation', 'check-in', 'checkin', 'change my booking',
    'maintenance', 'repair', 'ac', 'aircon', 'key card', 'room move',
    'table', 'spa', 'massage', 'treatment', 'charge', 'refund',
    'bill', 'invoice', 'receipt'
  ];
  return svc.some(k => s.includes(k));
}

function isQuestion(t: string) {
  const s = normalize(t);
  if (!s) return false;
  if (s.endsWith('?')) return true;
  const qStarts = ['what', 'when', 'where', 'how', 'who', 'which'];
  if (qStarts.some(q => s.startsWith(q + ' '))) return true;
  // common info-seeking terms
  if (s.includes('price') || s.includes('time') || s.includes('open') || s.includes('hours')) return true;
  return false;
}

export async function decide(event: DecideInput): Promise<DecideOutput> {
  const text = (event?.text || '').trim();
  const s = normalize(text);

  // Load per-property AI toggles (safe in classifier; no handlers here)
  const settings = await getAiSettings(event?.propertyId || '');
  const chitchatEnabled = settings?.chitchat_enabled !== false; // default true if undefined

  let intent: Intent = 'UNKNOWN';
  let confidence = 0.4;

  const negative = detectNegative(s);
  const service = detectService(s);

  // Strong service/issue signals win
  if (service || negative) {
    intent = 'SERVICE';
    confidence = 0.9;

  } else if (chitchatEnabled && isSmalltalk(text)) {
    // Keep CHITCHAT only when enabled to avoid routing dead-ends
    intent = 'CHITCHAT';
    confidence = 0.99;

  } else if (isQuestion(s)) {
    intent = 'FAQ';
    confidence = 0.85;

  } else {
    intent = 'UNKNOWN';
    confidence = 0.5;
  }

  // Structured log for observability
  try {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      where: 'decision_engine.decide',
      conversationId: event?.conversationId,
      propertyId: event?.propertyId,
      intent,
      confidence,
      negative,
    }));
  } catch {
    // ignore logging failures
  }

  return { intent, confidence, negative };
}

export default { decide };

// src/app/intent_router.ts
import { pauseGate } from '../middleware/pauseGate';
import {
  handleSoftEscalation,
  handleHardPause,
  resumeBot,
  resolveConversation,
} from '../handlers/escalation_handler';
import { replyFromBot } from '../adapters/chatwoot_adapter';
import { getState, incrementClarify, incrementNegative } from '../repos/conv_state_repo';
import { handleFaq } from '../handlers/faq_handler';
import { handleService } from '../handlers/service_handler';
import { handleSmalltalk } from '../handlers/smalltalk_handler';
import { getWelcomeQuickReplies, TENANT_VERTICAL, UI } from '../ui';
import type { HandlerResult } from './types';
import { getServiceFlow } from '../repos/conv_state_repo';

type IntentResult = {
  intent: 'FAQ' | 'SERVICE' | 'CHITCHAT' | 'UNKNOWN';
  confidence?: number;
  negative?: boolean;
};

const DEFAULTS = {
  faq_conf_threshold: 0.78,
  faq_sem_threshold: 0.78,
  trgm_min_similarity: 0.35,
  max_clarify_attempts: 2,
  negative_repeat_threshold: 2,
  auto_resume_minutes: 30,
  escalate_keywords: ['human','agent','staff','manager','real person'],
  chitchat_enabled: true,
};

function pickLang(event: any): keyof typeof UI {
  const l = (event?.lang || process.env.DEFAULT_LANG || 'en').toLowerCase();
  return (UI as any)[l] ? (l as keyof typeof UI) : 'en';
}

function containsEscalateKeyword(t: string, list: string[]) {
  const s = (t || '').toLowerCase();
  return list.some(k => s.includes(k.toLowerCase()));
}

function parseCommand(t: string) {
  const s = (t || '').trim().toLowerCase();
  if (s.startsWith('@boton'))   return 'resume';
  if (s.startsWith('@botoff'))  return 'pause';
  if (s.startsWith('@resolve')) return 'resolve';
  if (s.startsWith('@botstatus')) return 'status';
  return null;
}

export async function intentRouter(
  event: any,
  decide: (e:any)=>Promise<IntentResult>,
  settings?: any
) {
  const opts = { ...DEFAULTS, ...(settings||{}) };
  const { propertyId, conversationId, text = '' } = event;
  const lang = pickLang(event);

  // --- 0) Staff commands (always processed) ----------------------------------
  const cmd = parseCommand(text);
  if (cmd === 'resume') {
    await resumeBot(event); // status → open
    return { escalated: false, mode: 'resume', reason: 'command_resume' };
  }
  if (cmd === 'pause') {
    await handleHardPause(event, opts.auto_resume_minutes); // status → open + pauseGate active
    return { escalated: true, mode: 'hard_pause', reason: 'command_pause' };
  }
  if (cmd === 'resolve') {
    await resolveConversation(event); // status → resolved
    return { escalated: false, mode: 'resolved', reason: 'command_resolve' };
  }
  if (cmd === 'status') {
    return { skipped: true, reason: 'command_status_noop' };
  }

  // --- 1) Respect pause gate (blocks bot replies during hard pause) ----------
  const gate = await pauseGate(propertyId, conversationId);
  if (gate.blocked) return { skipped: true, reason: 'paused' };

  // --- 2a) Welcome menu → direct service kick-off ---------------------------
  // If the user clicked a welcome menu button that maps to a service
  // (e.g., "Book a table"), skip NLU and start the service flow immediately.
  try {
    const welcomeSet = getWelcomeQuickReplies(TENANT_VERTICAL) || [];
    const isWelcomeService = welcomeSet.some(
      (i) => i.payload.toLowerCase() === (text || '').toLowerCase() && !i.payload.startsWith('WELCOME_')
    );
    if (isWelcomeService) {
      const svc = await handleService({
        intent: 'SERVICE',
        text,
        conversationId,
        tenantId: propertyId,
      });
      if (svc?.handled && svc.reply) {
        await replyFromBot(conversationId, svc.reply);
        return { ok: true, intent: 'SERVICE', mode: 'service_from_welcome' };
      }
      // If not handled, fall through to normal routing
    }
  } catch {}

  // --- 2) Decide intent ------------------------------------------------------
  const state = await getState(propertyId, conversationId);
  const result = await decide(event);
  const { intent, confidence = 0, negative = false } = result;

  const inWatch = !!state?.watch_mode;
  const prevClarify = state?.clarify_attempts ?? 0;
  const wantsHuman = containsEscalateKeyword(text, opts.escalate_keywords);
  const negativeCountNow = (state?.negative_count ?? 0) + (negative ? 1 : 0);

  // --- 2b) Force active service flow -----------------------------------------
  const activeFlow = await getServiceFlow(conversationId);
  if (activeFlow?.service_key) {
    const svc = await handleService({
      intent: 'SERVICE',
      text,
      conversationId,
      tenantId: propertyId,
    });
    if (svc?.handled && svc.reply) {
      await replyFromBot(conversationId, svc.reply);
      return { ok: true, intent: 'SERVICE', mode: 'service_flow_active' };
    }
  }

  // --- 3) Explicit human request → soft escalation ---------------------------
  if (wantsHuman) {
    await handleSoftEscalation(event, {
      intent,
      negativeCount: state?.negative_count ?? 0,
      text,
      issue: false,
    });
    await replyFromBot(conversationId, UI[lang].human_escalation);
    return { escalated: true, mode: 'soft_watch', reason: 'keyword_request_human' };
  }

  // --- 4) SERVICE ------------------------------------------------------------
  if (intent === 'SERVICE') {
    if (negative) {
      await handleSoftEscalation(event, {
        intent,
        negativeCount: negativeCountNow,
        text,
        issue: true,
      });
      await incrementNegative(propertyId, conversationId);
      await replyFromBot(conversationId, UI[lang].empathy_reply);
      return { escalated: true, mode: 'soft_watch', reason: 'negative_in_service' };
    }

    const svc = await handleService({
      intent: 'SERVICE',
      text,
      conversationId,
      tenantId: propertyId,
    });
    if (svc?.handled && svc.reply) {
      await replyFromBot(conversationId, svc.reply); // stays open
      return { ok: true, intent, mode: 'service_handled' };
    }
    await handleSoftEscalation(event, {
      intent,
      negativeCount: state?.negative_count ?? 0,
      text,
      issue: false,
    });
    return { escalated: true, mode: 'soft_watch', reason: svc?.reason || 'service_unknown' };
  }

  // --- 5) NEGATIVE -----------------------------------------------------------
  if (negative) {
    await handleSoftEscalation(event, {
      intent,
      negativeCount: negativeCountNow,
      text,
      issue: true,
    });
    await incrementNegative(propertyId, conversationId);
    await replyFromBot(conversationId, UI[lang].empathy_reply);
    return { escalated: true, mode: 'soft_watch', reason: 'negative' };
  }

  // --- 6) Confident FAQ ------------------------------------------------------
  const isConfidentFAQ = intent === 'FAQ' && confidence >= opts.faq_conf_threshold;
  if (isConfidentFAQ) {
    const r: HandlerResult = await handleFaq(event, opts);
    if (r?.handled && r.reply) {
      await replyFromBot(conversationId, r.reply);
      return {
        ok: true,
        intent,
        answered_by: r.meta?.source,
        id: r.meta?.id,
        score: r.meta?.score,
      } as any;
    }
  }

  // --- 7) Low-conf FAQ / Unknown / In-watch ---------------------------------
  if (intent === 'UNKNOWN' || (intent === 'FAQ' && !isConfidentFAQ) || inWatch) {
    await handleSoftEscalation(event, {
      intent,
      negativeCount: state?.negative_count ?? 0,
      text,
    });
    if (prevClarify >= opts.max_clarify_attempts) {
      return { escalated: true, mode: 'soft_watch', reason: 'clarify_exhausted_soft' };
    }
    await incrementClarify(propertyId, conversationId);
    const next = prevClarify + 1;
    const prompt = next === 1
      ? UI[lang].clarify_generic_1
      : UI[lang].clarify_generic_2;
    await replyFromBot(conversationId, prompt);
    return { escalated: true, mode: 'soft_watch', reason: 'clarify' };
  }

  // --- 8) CHITCHAT -----------------------------------------------------------
  if (intent === 'CHITCHAT') {
    if (opts.chitchat_enabled === false) return { skipped: true, reason: 'chitchat_disabled' };
    const r = await handleSmalltalk({ conversationId, text, lang });
    if (r?.handled && r.reply) {
      await replyFromBot(conversationId, r.reply);
    }
    return { ok: true, intent };
  }

  return { ok: true, intent, confidence };
}

// packages/orchestrator/src/webhooks/chatwoot_webhook.ts
import { Router, Request, Response } from 'express';
import { intentRouter } from '../app/intent_router';
import { decide } from '../app/decision_engine';
import { getState, manualPauseForMinutes } from '../repos/conv_state_repo';
import {
  replyFromBot,
  getConversation,
  assignToUser,
  addPrivateMessage,
} from '../adapters/chatwoot_adapter';
import { handleSmalltalk } from '../handlers/smalltalk_handler';
import {
  handleHardPause,
  resumeBot, // ✅ central handler for consistency
} from '../handlers/escalation_handler';

const router = Router();
const BOT_PREFIX = process.env.CW_PREFIX_BOT || '🤖 BOT:';
const PROPERTY_ID = process.env.PROPERTY_ID || 'hotel_demo_1';

// --- SHORT NOTE TEXTS (as requested) ---
const NOTE_PAUSED = '⏸️ Bot paused.';
const NOTE_RESUMED = '▶️ Bot on.'; // (not posted here; resumeBot likely posts its own)

// --- helper to check if a message came from our bot (prefix-agnostic) ---
function isBotMessage(msg: any) {
  return msg?.content_attributes?.loopdup_bot === true;
}

// Some Chatwoot builds don't echo content_attributes back on webhook events.
// Fallback heuristics to identify our bot's public replies by text.
function looksLikeBotOutgoingText(text?: string) {
  if (!text) return false;
  const t = String(text).trim();

  // 1) Exact env/tenant prefix if present
  if (BOT_PREFIX && t.startsWith(BOT_PREFIX)) return true;

  // 2) Tolerate mojibake/emoji loss (e.g., "�� BOT: ...")
  //    If "BOT:" appears within the first ~10 chars, treat as bot.
  const idx = t.toUpperCase().indexOf('BOT:');
  if (idx > -1 && idx <= 10) return true;

  return false;
}

// Fallback matcher to ignore our own auto-pause note text when attributes are missing.
// Keep backward-compat with the old verbose note (second check).
const OLD_AUTO_PAUSE_PREFIX =
  '⏸️ Auto-pause: human/page reply detected. Bot paused for ';
function looksLikeOurAutoPauseNote(text?: string) {
  if (!text) return false;
  return text === NOTE_PAUSED || text.startsWith(OLD_AUTO_PAUSE_PREFIX);
}

function normalizeMessageType(mt: any): 'incoming' | 'outgoing' | 'note' | '' {
  if (typeof mt === 'string') return mt.toLowerCase() as any;
  if (typeof mt === 'number') {
    if (mt === 1) return 'incoming';
    if (mt === 2) return 'outgoing';
    return 'note';
  }
  return '';
}

function eventTypeOf(body: any): string {
  const e = body?.event || body?.name || body?.type || '';
  return String(e || '').toLowerCase();
}

function parseMessage(body: any) {
  const cw = body || {};
  const payload = cw?.payload || cw;

  const evt = eventTypeOf(cw);
  const message =
    payload?.message ||
    (Array.isArray(payload?.messages) ? payload?.messages?.[0] : undefined) ||
    (payload?.content && payload) ||
    payload ||
    {};

  const conversation =
    payload?.conversation ||
    message?.conversation ||
    {};

  const conversationId = String(
    conversation?.id ??
      message?.conversation_id ??
      payload?.conversation_id ??
      ''
  );

  const senderType = String(
    message?.sender_type ||
    message?.sender?.type ||
    payload?.sender_type ||
    ''
  ).toLowerCase();

  let messageType = normalizeMessageType(message?.message_type);
  const isPrivate = Boolean(message?.private);

  const content =
    typeof message?.content === 'string' && message?.content.length > 0
      ? message.content
      : (typeof payload?.content === 'string' ? payload.content : '');

  if (
    !messageType &&
    senderType !== 'agent' &&
    senderType !== 'user' &&
    isPrivate === false &&
    content &&
    content.length > 0
  ) {
    messageType = 'incoming';
  }

  return { eventType: evt, conversationId, senderType, messageType, isPrivate, content, message };
}

async function safetyAssign(conversationId: string | number) {
  try {
    const defaultAssignee =
      Number(process.env.CW_DEFAULT_ASSIGNEE_ID || 0) || undefined;
    const defaultTeam = Number(process.env.CW_TEAM_ID || 0) || undefined;
    if (!defaultAssignee) return;

    const convo = await getConversation(conversationId);
    if (!convo?.assignee_id) {
      await assignToUser(conversationId, defaultAssignee, defaultTeam);
      console.log('[webhook.safetyAssign] assigned', {
        conversationId,
        defaultAssignee,
      });
    }
  } catch (e) {
    console.error('[webhook.safetyAssign] failed', e);
  }
}

router.post('/chatwoot', async (req: Request, res: Response) => {
  try {
    const { eventType, conversationId, senderType, messageType, isPrivate, content, message } =
      parseMessage(req.body);

    console.log('[cw.webhook.in]', {
      eventType,
      conversationId,
      senderType,
      messageType,
      isPrivate,
      len: (content || '').length,
    });

    if (!conversationId) {
      return res.status(200).json({ ok: true, ignored: 'no_conversation_id' });
    }

    if (eventType && eventType !== 'message_created' && !req.body?.payload?.message && !req.body?.message) {
      return res.status(200).json({ ok: true, ignored: `event:${eventType}` });
    }

    const isStaff = senderType === 'agent' || senderType === 'user';

    // --- auto-pause on staff/page public replies (ignore bot & system/timeline) -----------
    if (messageType === 'outgoing' && isPrivate === false) {
      const hasText = typeof content === 'string' && content.trim().length > 0;
      const isOurBot =
        isBotMessage(message) || looksLikeBotOutgoingText(content);

      // Only pause if this is a real human text message to the guest.
      if (isStaff && hasText && !isOurBot) {
        // Only post the pause note on the FIRST pause transition
        const stBefore = await getState(PROPERTY_ID, conversationId);
        const minutes = Number(process.env.MANUAL_REPLY_PAUSE_MINUTES || 30);

        await manualPauseForMinutes(PROPERTY_ID, conversationId, minutes);

        if (!stBefore?.paused) {
          await addPrivateMessage(conversationId, NOTE_PAUSED);
        }
        // else: remain paused silently (no extra notes)
      }
    }

    // --- Staff private commands (@botoff / @boton / @botstatus) -------------
    const isAgentPrivate = isStaff && (messageType === 'note' || isPrivate === true);
    if (isAgentPrivate) {
      // Ignore bot-authored notes OR our known auto-pause note (fallback)
      if (isBotMessage(message) || looksLikeOurAutoPauseNote(content)) {
        return res.json({ ok: true, ignored: 'bot_private_note' });
      }

      const text = String(content || '');
      console.log('[cw.agent.private]', { text });

      if (/@botoff/i.test(text)) {
        const minutes = Number(process.env.AUTO_RESUME_MINUTES || 30);
        await handleHardPause({ conversationId, propertyId: PROPERTY_ID }, minutes);
        return res.json({ ok: true, hard_paused: true, by: 'command' });
      }

      if (/@boton/i.test(text)) {
        await resumeBot({ conversationId, propertyId: PROPERTY_ID });
        return res.json({ ok: true, resumed: true, by: 'command' });
      }

      if (/@botstatus/i.test(text)) {
        const st = await getState(PROPERTY_ID, conversationId);
        await replyFromBot(
          conversationId,
          [
            '📊 Bot status',
            `- paused: ${!!st?.paused}`,
            `- watch_mode: ${!!st?.watch_mode}`,
            `- clarify_attempts: ${st?.clarify_attempts ?? 0}`,
            `- negative_count: ${st?.negative_count ?? 0}`,
          ].join('\n')
        );
        return res.json({ ok: true, status_sent: true });
      }

      return res.json({ ok: true, ignored: 'agent_private_note' });
    }

    // --- Guest message guard -------------------------------------------------
    const inboundLike =
      messageType === 'incoming' ||
      (messageType === '' && !isStaff && isPrivate === false);

    const isGuestInbound =
      inboundLike &&
      typeof content === 'string' &&
      content.trim().length > 0 &&
      !content.startsWith(BOT_PREFIX);

    if (!isGuestInbound) {
      return res.status(200).json({
        ok: true,
        ignored: { senderType, messageType, isPrivate },
      });
    }

    // --- Pause guard ---------------------------------------------------------
    const stNow = await getState(PROPERTY_ID, conversationId);
    if (stNow?.paused) {
      console.log('[cw.router.guard] paused → skip bot reply');
      return res.json({ ok: true, skipped: 'paused' });
    }

    // --- Build event & router settings ---------------------------------------
    const event = {
      propertyId: PROPERTY_ID,
      conversationId,
      text: String(content || ''),
      lang: 'en',
      ts: new Date().toISOString(),
      raw: req.body,
      source: 'chatwoot',
    };

    const settings = {
      faq_conf_threshold: 0.78,
      max_clarify_attempts: Number(process.env.MAX_CLARIFY_ATTEMPTS || 2),
      negative_repeat_threshold: Number(process.env.NEGATIVE_REPEAT_THRESHOLD || 2),
      auto_resume_minutes: Number(process.env.AUTO_RESUME_MINUTES || 30),
      escalate_keywords: (process.env.ESCALATE_KEYWORDS || 'human,agent,staff,manager,real person')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      chitchat_enabled: true,
    };

    const pre = await decide({ text: event.text, propertyId: PROPERTY_ID, conversationId });
    console.log('[cw.decide.pre]', pre);

    // --- SMALLTALK -----------------------------------------------------------
    if (pre.intent === 'CHITCHAT' && settings.chitchat_enabled) {
      await handleSmalltalk({
        conversationId,
        text: event.text,
        lang: event.lang,
      }); // handleSmalltalk now sends its own reply
      await safetyAssign(conversationId);
      return res.json({ ok: true, routed: 'CHITCHAT' });
    }

    console.log('[cw.router.call]', { conversationId, text: event.text });
    const routed = await intentRouter(event, decide, settings);
    console.log('[cw.router.result]', routed);

    try {
      const stAfter = await getState(PROPERTY_ID, conversationId);
      if (stAfter?.watch_mode || stAfter?.paused) {
        await safetyAssign(conversationId);
      }
    } catch (e) {
      console.error('[webhook.safetyAssign] failed', e);
    }

    return res.json({ ok: true, routed });
  } catch (e: any) {
    console.error('[webhooks/chatwoot] error', e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;

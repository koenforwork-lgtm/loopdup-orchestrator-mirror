// packages/orchestrator/src/webhooks/messenger_webhook.ts
import { Router, Request, Response } from 'express';
import { getConversationIdByPsid, savePsidMapping } from '../repos/psid_map_repo';
import { intentRouter } from '../app/intent_router';
import { decide } from '../app/decision_engine';
import { getState } from '../repos/conv_state_repo';
import { replyFromBot } from '../adapters/chatwoot_adapter';

const router = Router();
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || '';
const PROPERTY_ID = process.env.PROPERTY_ID || 'hotel_demo_1';

router.get('/messenger', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[msngr.webhook] verified');
    return res.status(200).send(String(challenge || ''));
  }
  return res.status(403).send('Forbidden');
});

router.post('/messenger', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    if (body.object !== 'page' || !Array.isArray(body.entry)) {
      return res.status(200).json({ ok: true, ignored: 'not_page_event' });
    }

    for (const entry of body.entry) {
      const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const m of messaging) {
        const psid: string | undefined = m?.sender?.id;
        if (!psid) continue;

        // text quick-reply and postback both have payloads; prefer postback
        let text: string = '';
        if (m.postback?.payload) text = String(m.postback.payload);
        else if (m.message?.quick_reply?.payload) text = String(m.message.quick_reply.payload);
        else if (typeof m.message?.text === 'string') text = m.message.text; // fallback

        const conversationId = await getConversationIdByPsid(psid);
        if (!conversationId) {
          console.warn('[msngr.webhook] no conversation mapping for psid', psid);
          continue;
        }

        // Build router settings (align with Chatwoot webhook defaults)
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

        const event = {
          propertyId: PROPERTY_ID,
          conversationId,
          text: String(text || ''),
          lang: 'en',
          ts: new Date().toISOString(),
          raw: m,
          source: 'messenger',
        };

        console.log('[msngr.webhook.in]', { conversationId, text: event.text });

        // Route via the shared intent router (will call replyFromBot when needed)
        const routed = await intentRouter(event as any, decide as any, settings);
        console.log('[msngr.webhook.routed]', routed);

        // If router returned a successful intent but no reply was emitted (rare), send a generic ack
        if ((routed as any)?.ok && (routed as any)?.intent && !(routed as any)?.replied) {
          await replyFromBot(conversationId, 'Okay!');
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[msngr.webhook] error', e);
    return res.status(200).json({ ok: true, error: e?.message || String(e) });
  }
});

export default router;

// packages/orchestrator/src/handlers/smalltalk_handler.ts
import { replyFromBot, getConversation } from '../adapters/chatwoot_adapter';
import { savePsidMapping } from '../repos/psid_map_repo';
import { getWelcomeQuickReplies, TENANT_VERTICAL, UI } from '../ui';
import {
  sendMessengerButtons,
  type MessengerButton,
} from '../adapters/messenger_sender';
import type { HandlerResult } from '../app/types';

export type SmalltalkCtx = { conversationId: number | string; text: string; lang?: string; };

function normalize(s: string) { return (s || '').toLowerCase().trim(); }

export function isSmalltalk(text: string): boolean {
  const t = normalize(text);
  return (
    /(^|\b)(hi|hello|hey|xin chào|chào|good (morning|afternoon|evening))(\b|!|\.|,)/i.test(t) ||
    /(^|\b)(thanks|thank you|cảm ơn)(\b|!|\.|,)/i.test(t)
  );
}

function extractPsid(conv: any): string | null {
  return (
    conv?.meta?.sender?.source_id ||
    conv?.contact_inbox?.source_id ||
    conv?.last_non_activity_message?.conversation?.contact_inbox?.source_id ||
    conv?.messages?.[0]?.conversation?.contact_inbox?.source_id ||
    null
  );
}

function resolveLang(s?: string): keyof typeof UI {
  const l = (s || process.env.DEFAULT_LANG || 'en').toLowerCase();
  return (UI as any)[l] ? (l as keyof typeof UI) : 'en';
}

export async function handleSmalltalk(ctx: SmalltalkCtx): Promise<HandlerResult> {
  const { conversationId } = ctx;
  const t = normalize(ctx.text);
  const lang = resolveLang(ctx.lang);

  if (/(^|\b)(hi|hello|hey|xin chào|chào|good (morning|afternoon|evening))(\b|!|\.|,)/i.test(t)) {
    try {
      const conv: any = await getConversation(conversationId);
      const psid = extractPsid(conv);
      console.log('[smalltalk] PSID resolved:', psid);

      if (psid) {
        // Persist PSID↔Conversation mapping for button postbacks
        try { await savePsidMapping(psid, conversationId, process.env.PROPERTY_ID || 'default'); } catch {}
        // Use centralized welcome set, but render as BUTTONS instead of quick replies
        const uiSet = getWelcomeQuickReplies(TENANT_VERTICAL);
        const buttons: MessengerButton[] = uiSet.map(i => ({
          type: 'postback',
          title: i.title,
          payload: i.payload,
        }));

        await sendMessengerButtons(
          psid,
          UI[lang].chitchat_prompt,
          buttons
        );

        // Mirror in Chatwoot as a private note to avoid guest duplicates
        await replyFromBot(conversationId, UI[lang].chitchat_prompt, { private: true });
        return {
          handled: true,
          meta: { sent_via_messenger: true, quick_replies: uiSet, quickReplies: uiSet },
        };
      }
    } catch (e) {
      console.warn('[smalltalk] messenger buttons send failed', e);
    }

    // Fallback: no PSID found → let router send a normal public message
    return { handled: true, reply: UI[lang].chitchat_prompt };
  }

  if (/(^|\b)(thanks|thank you|cảm ơn)(\b|!|\.|,)/i.test(t)) {
    return { handled: true, reply: UI[lang]?.thanks_reply || 'You\u2019re welcome! Anything else I can help with?' };
  }

  return { handled: true, reply: UI[lang].chitchat_prompt };
}

// packages/orchestrator/src/adapters/chatwoot_adapter.ts
import fetch, { Response } from 'node-fetch';

const BASE = process.env.CHATWOOT_BASE_URL!;
const TOKEN = process.env.CW_API_TOKEN || process.env.CW_CHATWOOT_API_TOKEN || process.env.CHATWOOT_API_TOKEN!;
const ACCOUNT_ID = Number(process.env.CW_ACCOUNT_ID || 1);
const DELIVERY_MODE = (process.env.CW_DELIVERY_MODE || 'send').toLowerCase(); // 'send' | 'mirror'
const BOT_PREFIX = process.env.CW_PREFIX_BOT || '🤖 BOT:';

if (!TOKEN) {
  throw new Error('CHATWOOT_API_TOKEN is missing in .env');
}

function headers() {
  return {
    'api_access_token': TOKEN,
    'Content-Type': 'application/json',
  };
}

async function ok(res: Response, context: string) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[chatwoot.${context}] http`, res.status, res.statusText, 'resp=', text);
    throw new Error(`[chatwoot_adapter] ${context} ${res.status} ${res.statusText}`);
  } else {
    console.log(`[chatwoot.${context}] ok`);
  }
  return res;
}

function cwUrl(path: string) {
  return `${BASE}/api/v1/accounts/${ACCOUNT_ID}${path}`;
}

/** Types for status/priority controls */
// 🚫 Removed pending/snoozed – only open/resolved are allowed
export type ChatwootStatus = 'open' | 'resolved';
export type ChatwootPriority = 'low' | 'medium' | 'high' | 'urgent';

/** Optional UI extras */
export type QuickReply = { title: string; payload: string };
export type BotReplyOptions = {
  quick_replies?: QuickReply[];
  private?: boolean;   // ← added: allow forcing private/public per call
};

/**
 * Reply to the guest as the bot.
 */
import { sendMessengerMessage } from "./messenger_sender"; // ⬅️ make sure path is correct

// Helper: resolve Messenger PSID from a Chatwoot conversation
async function getMessengerPsidForConversation(conversationId: number | string): Promise<string | null> {
  try {
    const conv: any = await getConversation(conversationId);
    // Try common Chatwoot locations for Facebook PSID
    const psid =
      conv?.meta?.sender?.additional_attributes?.psid ||
      conv?.meta?.sender?.identifier ||
      conv?.meta?.contact?.inbox?.source_id ||
      (Array.isArray(conv?.meta?.contact?.inboxes)
        ? conv.meta.contact.inboxes.find((i: any) =>
            String(i?.channel_type || "").toLowerCase().includes("facebook")
          )?.source_id
        : null);

    return (typeof psid === "string" && psid.length > 0) ? psid : null;
  } catch (e) {
    console.warn("[chatwoot.getMessengerPsidForConversation] failed", e);
    return null;
  }
}

export async function replyFromBot(
  conversationId: number | string,
  content: string,
  meta?: Record<string, any>
) {
  // 1) Always send to Chatwoot so staff see what the bot said
  const payload: any = {
    content: `${BOT_PREFIX} ${content}`,
    message_type: 'outgoing',
    private: meta?.private ?? (DELIVERY_MODE === 'mirror'),
    content_attributes: { loopdup_bot: true, v: 1 },
  };

  // Keep passing quick_replies into Chatwoot attrs (ignored by Chatwoot UI, but harmless)
  if (Array.isArray(meta?.quick_replies) && meta!.quick_replies.length > 0) {
    payload.content_attributes.quick_replies = meta!.quick_replies.map((q: any) => ({
      title: q.title,
      payload: q.payload,
    }));
  }

  const url = cwUrl(`/conversations/${conversationId}/messages`);
  console.log('[chatwoot.replyFromBot] →', url, payload);

  const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
  await ok(r as any, 'replyFromBot');

  // 2) If Messenger + we have quick replies, send directly so guest sees buttons
  try {
    if (Array.isArray(meta?.quick_replies) && meta.quick_replies.length > 0) {
      const psid = await getMessengerPsidForConversation(conversationId);
      if (psid) {
        await sendMessengerMessage(psid, content, { quick_replies: meta.quick_replies });
      }
    }
  } catch (e) {
    console.warn('[chatwoot.replyFromBot] messenger quick replies failed', e);
  }
}

/**
 * Add a private staff-only message.
 */
export async function addPrivateMessage(conversationId: number | string, content: string) {
  const url = cwUrl(`/conversations/${conversationId}/messages`);
  const body = {
    content,
    message_type: 'outgoing',
    private: true,
    content_attributes: { loopdup_bot: true, v: 1 }
  };
  console.log('[chatwoot.addPrivateMessage] →', url, body);

  const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  await ok(r as any, 'addPrivateMessage');
}

// Backward-compatible alias
export const addPrivateNote = addPrivateMessage;

/**
 * Add labels.
 */
export async function addLabel(conversationId: number | string, label: string) {
  return addLabels(conversationId, [label]);
}

export async function addLabels(conversationId: number | string, labels: string[]) {
  try {
    const conv = await getConversation(conversationId);
    const current: string[] = Array.isArray((conv as any)?.labels) ? (conv as any).labels : [];
    const merged = Array.from(new Set([...current, ...labels]));

    const url = cwUrl(`/conversations/${conversationId}/labels`);
    const body = { labels: merged };
    console.log('[chatwoot.addLabels] →', url, body);

    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    await ok(r as any, 'addLabels');
  } catch (e) {
    console.error('[chatwoot.addLabels] error', e);
    try {
      const url = cwUrl(`/conversations/${conversationId}/labels`);
      const body = { labels };
      console.log('[chatwoot.addLabels:fallback] →', url, body);
      const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      await ok(r as any, 'addLabels:fallback');
    } catch (e2) {
      console.error('[chatwoot.addLabels:fallback] error', e2);
      throw e2;
    }
  }
}

export async function ensureLabel(conversationId: number | string, label: string) {
  return addLabels(conversationId, [label]);
}

/**
 * Update status.
 * Enforces Open/Resolved only.
 */
export async function updateConversationStatus(
  conversationId: number | string,
  status: ChatwootStatus
) {
  if (status !== 'open' && status !== 'resolved') {
    console.warn(`[chatwoot.updateConversationStatus] blocked invalid status=`, status);
    return { id: conversationId, status: 'open' } as any; // fallback safeguard
  }

  const base = cwUrl(`/conversations/${conversationId}`);

  try {
    console.log('[chatwoot.updateConversationStatus:patch-wrapped] →', base, { conversation: { status } });
    let p = await fetch(base, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ conversation: { status } }),
    });
    if (p.ok) return await p.json();

    console.warn(`[chatwoot.updateConversationStatus] wrapped PATCH failed: ${p.status} ${p.statusText}; trying flat body`);
    p = await fetch(base, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ status }),
    });
    if (p.ok) return await p.json();
    else {
      const txt = await p.text().catch(() => '');
      console.warn('[chatwoot.updateConversationStatus] flat PATCH failed', { status, http: p.status, resp: txt.slice(0, 300) });
      return { id: conversationId, status: 'unknown' } as any;
    }
  } catch (e) {
    console.warn('[chatwoot.updateConversationStatus] PATCH exception', { status, e });
    return { id: conversationId, status: 'unknown' } as any;
  }
}

/**
 * Update priority.
 */
export async function updateConversationPriority(conversationId: number | string, priority: ChatwootPriority) {
  const url = cwUrl(`/conversations/${conversationId}`);
  const body = { priority };
  console.log('[chatwoot.updateConversationPriority] →', url, body);

  const r = await fetch(url, { method: 'PATCH', headers: headers(), body: JSON.stringify(body) });
  await ok(r as any, 'updateConversationPriority');
  return r.json();
}

/**
 * Assign conversation.
 */
export async function assignToUser(
  conversationId: number | string,
  assigneeId: number,
  teamId?: number
) {
  const url = cwUrl(`/conversations/${conversationId}/assignments`);
  const body: any = { assignee_id: assigneeId };
  if (typeof teamId === 'number' && teamId > 0) body.team_id = teamId;

  console.log('[chatwoot.assignToUser] →', url, body);

  const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  await ok(r as any, 'assignToUser');
}

/**
 * Get conversation.
 */
export async function getConversation(conversationId: number | string) {
  const url = cwUrl(`/conversations/${conversationId}`);
  const r = await fetch(url, { method: 'GET', headers: headers() });
  await ok(r as any, 'getConversation');
  return r.json() as Promise<{ assignee_id: number | null; status?: ChatwootStatus; priority?: ChatwootPriority; labels?: string[] }>;
}

/**
 * Messenger typing indicator
 */
export async function sendTypingOn(conversationId: number | string) {
  const url = cwUrl(`/conversations/${conversationId}/messages`);
  const body = {
    content: null,
    message_type: 'outgoing',
    private: false,
    content_attributes: { type: 'typing_on' }
  };
  console.log('[chatwoot.sendTypingOn] →', url, body);

  const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  await ok(r as any, 'sendTypingOn');
}

export async function sendTypingOff(conversationId: number | string) {
  const url = cwUrl(`/conversations/${conversationId}/messages`);
  const body = {
    content: null,
    message_type: 'outgoing',
    private: false,
    content_attributes: { type: 'typing_off' }
  };
  console.log('[chatwoot.sendTypingOff] →', url, body);

  const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  await ok(r as any, 'sendTypingOff');
}

// packages/orchestrator/src/adapters/messenger_sender.ts
// Direct Messenger sender (bypasses Chatwoot for guest-facing UI).
// Only guest sees buttons/quick_replies; staff see guest click in Chatwoot.

import fetch from "node-fetch";

const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_TOKEN!;

export type MessengerQuickReply = {
  content_type: "text";
  title: string;
  payload: string;
};

export async function sendMessengerQuickReplies(
  psid: string,
  text: string,
  quickReplies: MessengerQuickReply[]
) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const body = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: {
      text,
      quick_replies: quickReplies.map((q) => ({
        content_type: q.content_type,
        title: q.title,
        payload: q.payload,
      })),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Messenger send failed:", res.status, errText);
    throw new Error("Messenger send failed");
  }

  return res.json();
}

// -------------------------------
// Button Template sender (NEW)
// -------------------------------

export type MessengerButton = {
  type: "postback" | "web_url";
  title: string;
  payload?: string; // required for postback
  url?: string;     // required for web_url
};

export async function sendMessengerButtons(
  psid: string,
  text: string,
  buttons: MessengerButton[]
) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const body = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text,
          buttons: buttons.map((b) =>
            b.type === "web_url"
              ? { type: "web_url", url: b.url!, title: b.title }
              : { type: "postback", title: b.title, payload: b.payload! }
          ),
        },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Messenger send (buttons) failed:", res.status, errText);
    throw new Error("Messenger send (buttons) failed");
  }

  return res.json();
}

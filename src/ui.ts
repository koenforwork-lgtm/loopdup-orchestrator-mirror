/**
 * Unified UI Module
 *
 * Centralizes quick-reply button sets and multilingual UI strings.
 */

export const WELCOME_SETS: Record<string, { title: string; payload: string }[]> = {
  hotel: [
    { title: "🛎 Book a table",   payload: "Book a table" },
    { title: "📅 Check-in info",    payload: "WELCOME_CHECKIN_INFO" },
    { title: "🍳 Breakfast hours",  payload: "WELCOME_BREAKFAST_HOURS" },
  ],
  // TODO: add 'restaurant', 'spa' when needed
};

// Helpers for quick replies
export function getWelcomeQuickReplies(vertical: string = "hotel") {
  const v = (vertical || "hotel").toLowerCase();
  return WELCOME_SETS[v] ?? WELCOME_SETS["hotel"];
}

// Tenant/env helpers
export const TENANT_VERTICAL = (process.env.TENANT_VERTICAL || "hotel").toLowerCase();
export const TENANT_REVIEW_URL = process.env.TENANT_REVIEW_URL || "";

// -----------------------------
// Multilingual UI dictionary
// -----------------------------
export const UI = {
  en: {
    ask_time: "What time would you like?",
    ask_date: "Which date?",
    clarify_time_period: "Just to be sure — {time} in the morning or in the evening?",
    clarify_generic_1: "Just to be sure I’ve got you right — did you mean X? If it’s easier, you can rephrase and I’ll try again.",
    clarify_generic_2: "I might be off — could you share one extra detail (date/name/room)? I’ll help or loop a teammate in.",
    qr_morning: "in the morning",
    qr_evening: "in the evening",
    qr_today: "Today",
    qr_tomorrow: "Tomorrow",
    thanks_clarify: "Got it, thank you! 😊",
    confirm_booking: "Booked {service} on {date} at {time}. Anything else I can arrange?",
    parse_error:
      "Sorry, I didn’t catch the time. Could you send it like '7 in the evening' or '19:00'?",
    soft_escalation:
      "👀 I’ve asked a teammate to join. Meanwhile, anything else I can help with?",
    empathy_reply:
      "I’m really sorry about that. I can help fix this now — could you share one detail (what happened or when), and I’ll sort it or loop a teammate in?",
    human_escalation:
      "Thanks — I’ve alerted a teammate who’ll get back to you as soon as possible. In the meantime, is there anything else I can help you with?",
    chitchat_prompt: "Happy to chat! How can I help with your stay/visit?",
    thanks_reply: "You’re welcome! Anything else I can help with?",
    fallback_default: "I didn’t quite catch that — could you rephrase?",
  },
  vi: {
    ask_time: "Bạn muốn lúc mấy giờ?",
    ask_date: "Bạn muốn vào ngày nào?",
    clarify_time_period: "Cho chắc nhé — {time} buổi sáng hay buổi tối?",
    clarify_generic_1: "Cho chắc nhé — bạn đang muốn nói về X? Nếu tiện, bạn có thể diễn đạt lại và mình sẽ thử lại ạ.",
    clarify_generic_2: "Có thể mình hiểu chưa đúng — bạn cho mình thêm 1 chi tiết (ngày/tên/phòng) nhé? Mình sẽ hỗ trợ hoặc mời đồng đội vào giúp.",
    qr_morning: "buổi sáng",
    qr_evening: "buổi tối",
    qr_today: "Hôm nay",
    qr_tomorrow: "Ngày mai",
    thanks_clarify: "Đã rõ, cảm ơn bạn! 😊",
    confirm_booking: "Đã đặt {service} vào {date} lúc {time}. Bạn cần hỗ trợ gì thêm không?",
    parse_error:
      "Xin lỗi, mình chưa rõ giờ. Bạn gửi như '7 buổi tối' hoặc '19:00' nhé?",
    soft_escalation:
      "Mình đã mời đồng đội hỗ trợ. Trong lúc chờ, mình giúp gì thêm không?",
    empathy_reply:
      "Rất xin lỗi về việc này. Bạn cho mình một chi tiết (điều gì đã xảy ra/ thời gian) nhé — mình sẽ xử lý hoặc mời đồng đội vào hỗ trợ ngay.",
    human_escalation:
      "Cảm ơn bạn — mình đã báo cho đồng đội, họ sẽ phản hồi sớm nhất. Trong lúc chờ, mình có thể giúp gì thêm không?",
    chitchat_prompt: "Mình sẵn sàng hỗ trợ! Bạn cần mình giúp gì cho kỳ nghỉ/chuyến thăm của bạn?",
    thanks_reply: "Rất vui được giúp! Bạn cần hỗ trợ gì thêm không?",
    fallback_default: "Mình chưa rõ ý bạn — bạn nói lại giúp mình nhé?",
  },
  nl: {
    ask_time: "Om hoe laat wil je?",
    ask_date: "Op welke datum?",
    clarify_time_period: "Voor de zekerheid — {time} in de ochtend of in de avond?",
    clarify_generic_1: "Voor de zekerheid — bedoelde je X? Als het makkelijker is, kun je het herformuleren en dan probeer ik het opnieuw.",
    clarify_generic_2: "Ik twijfel een beetje — kun je één extra detail delen (datum/naam/kamer)? Dan help ik of haal ik een collega erbij.",
    qr_morning: "in de ochtend",
    qr_evening: "in de avond",
    qr_today: "Vandaag",
    qr_tomorrow: "Morgen",
    thanks_clarify: "Helemaal goed, dank je! 😊",
    confirm_booking: "{service} geboekt op {date} om {time}. Kan ik nog iets regelen?",
    parse_error:
      "Sorry, ik kon de tijd niet goed lezen. Stuur het als '7 in de avond' of '19:00'?",
    soft_escalation:
      "Ik heb een collega gevraagd mee te kijken. Kan ik intussen nog helpen?",
    empathy_reply:
      "Het spijt me zeer. Ik kan dit nu voor je oplossen — wil je één detail delen (wat er gebeurde of wanneer)? Dan regel ik het of schakel ik een collega in.",
    human_escalation:
      "Bedankt — ik heb een collega gewaarschuwd die zo snel mogelijk reageert. Kan ik intussen nog ergens mee helpen?",
    chitchat_prompt: "Leuk om te praten! Waarmee kan ik je verblijf/bezoek helpen?",
    thanks_reply: "Graag gedaan! Kan ik nog ergens mee helpen?",
    fallback_default: "Dat heb ik niet helemaal begrepen — kun je het herformuleren?",
  },
} as const;

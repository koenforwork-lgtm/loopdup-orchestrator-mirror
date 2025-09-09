// packages/orchestrator/src/app/events_service.ts
import { replyFromBot } from "../adapters/chatwoot_adapter";
import { handleSoftEscalation } from "../handlers/escalation_handler";

// Local structural type to align with current DecideOutput shape
type DecideOutput = {
  intent: "FAQ" | "SERVICE" | "CHITCHAT" | "UNKNOWN";
  confidence?: number;
  negative?: boolean;
  answer?: string; // optional, some paths set this
};

const DEFAULTS = { faq_conf_threshold: 0.78 };

function isLowConfidenceFAQ(d: DecideOutput): boolean {
  return d.intent === "FAQ" && (d.confidence ?? 0) < DEFAULTS.faq_conf_threshold;
}

export type PlannedAction =
  | { action: "ESCALATE"; intent: DecideOutput["intent"] }
  | { action: "REPLY"; intent: DecideOutput["intent"] };

export function planAction(decision: DecideOutput): PlannedAction {
  const shouldEscalate =
    decision.intent === "SERVICE" ||
    decision.intent === "UNKNOWN" ||
    Boolean(decision.negative) ||
    isLowConfidenceFAQ(decision);

  return shouldEscalate
    ? { action: "ESCALATE", intent: decision.intent }
    : { action: "REPLY", intent: decision.intent };
}

export async function handleInboundEvent(event: {
  propertyId: string;
  conversationId: string | number;
  guestId?: string | number | null;
  text: string;
  lang?: string | null;
}) {
  // Lazy import to match your decide export
  const { decide } = await import("./decision_engine");
  const decision: DecideOutput = await decide(event as any);

  const plan = planAction(decision);

  if (plan.action === "ESCALATE") {
    // Pass only properties that SoftEscalationOpts allows
    await handleSoftEscalation(event.propertyId, {
      intent: decision.intent,
    });
    return { action: "ESCALATE", intent: decision.intent };
  }

  const text = decision.answer || "Thanks! How can I help further?";

  // NOTE: current adapter signature in your codebase expects (conversationId, text)
  await replyFromBot(String(event.conversationId), text);

  return { action: "REPLY", intent: decision.intent };
}

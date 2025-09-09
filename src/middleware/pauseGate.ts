// src/middleware/pauseGate.ts
import { getState } from '../repos/conv_state_repo';

/**
 * PauseGate middleware
 * 
 * Blocks bot replies if the conversation is manually paused (@botoff)
 * or auto-paused after staff replies. 
 * 
 * ✅ Note: This uses only our DB state (st.paused).
 * 🚫 Do NOT rely on Chatwoot statuses like "snoozed" or "pending" —
 * we only ever use "open" and "resolved".
 */
export async function pauseGate(
  propertyId: string,
  conversationId: string
): Promise<{ blocked: boolean }> {
  const st = await getState(propertyId, conversationId);
  if (!st) return { blocked: false };
  if (st.paused) return { blocked: true };
  return { blocked: false };
}

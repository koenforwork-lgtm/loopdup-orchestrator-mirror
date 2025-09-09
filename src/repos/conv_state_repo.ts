// src/repos/conv_state_repo.ts
import { db } from './db';

export type ConvState = {
  property_id: string;
  conversation_id: string;
  paused: boolean;
  resume_at: Date | null;
  escalated: boolean;
  watch_mode: boolean;
  clarify_attempts: number;
  negative_count: number;
};

export async function ensureState(propertyId: string, conversationId: string) {
  await db.query(
    `INSERT INTO conversation_states (property_id, conversation_id, paused, resume_at, escalated, watch_mode, clarify_attempts, negative_count)
     VALUES ($1, $2, false, NULL, false, false, 0, 0)
     ON CONFLICT (property_id, conversation_id) DO NOTHING`,
    [propertyId, conversationId]
  );
}

export async function getState(propertyId: string, conversationId: string): Promise<ConvState | null> {
  const r = await db.query(
    `SELECT property_id, conversation_id, paused, resume_at, escalated, watch_mode, clarify_attempts, negative_count
       FROM conversation_states
      WHERE property_id=$1 AND conversation_id=$2`,
    [propertyId, conversationId]
  );
  return r.rows?.[0] || null;
}

export async function enterSoftWatch(propertyId: string, conversationId: string) {
  await ensureState(propertyId, conversationId);
  await db.query(
    `UPDATE conversation_states SET watch_mode=true WHERE property_id=$1 AND conversation_id=$2`,
    [propertyId, conversationId]
  );
}

export async function incrementClarify(propertyId: string, conversationId: string) {
  await db.query(
    `UPDATE conversation_states SET clarify_attempts=clarify_attempts+1 WHERE property_id=$1 AND conversation_id=$2`,
    [propertyId, conversationId]
  );
}

export async function incrementNegative(propertyId: string, conversationId: string) {
  await db.query(
    `UPDATE conversation_states SET negative_count=negative_count+1 WHERE property_id=$1 AND conversation_id=$2`,
    [propertyId, conversationId]
  );
}

/** Returns true if it had been escalated before (i.e., no update happened now) */
export async function markEscalatedOnce(propertyId: string, conversationId: string): Promise<boolean> {
  await ensureState(propertyId, conversationId);
  const r = await db.query(
    `UPDATE conversation_states SET escalated=true
      WHERE property_id=$1 AND conversation_id=$2 AND escalated=false`,
    [propertyId, conversationId]
  );
  return r.rowCount === 0;
}

export async function enterHardPause(propertyId: string, conversationId: string, minutes: number) {
  const resumeAt = new Date(Date.now() + minutes * 60 * 1000);
  await ensureState(propertyId, conversationId);
  await db.query(
    `UPDATE conversation_states
       SET paused=true, resume_at=$1, watch_mode=false
     WHERE property_id=$2 AND conversation_id=$3`,
    [resumeAt, propertyId, conversationId]
  );
}

export async function resumeNow(propertyId: string, conversationId: string) {
  await ensureState(propertyId, conversationId);
  await db.query(
    `UPDATE conversation_states
       SET paused=false, resume_at=NULL, paused_until=NULL, watch_mode=false, clarify_attempts=0, negative_count=0
     WHERE property_id=$1 AND conversation_id=$2`,
    [propertyId, conversationId]
  );
}

export async function autoResumeDueConversations(): Promise<Array<{ property_id: string; conversation_id: string }>> {
  const r = await db.query(
    `SELECT property_id, conversation_id
       FROM conversation_states
      WHERE paused=true
        AND (
              (resume_at IS NOT NULL AND resume_at <= NOW())
           OR (paused_until IS NOT NULL AND paused_until <= NOW())
        )
      LIMIT 200`
  );
  for (const row of r.rows) {
    await resumeNow(row.property_id, row.conversation_id);
  }
  return r.rows;
}

/** Clear only pause/watch flags (used by resumeBot) */
export async function clearPause(propertyId: string, conversationId: string) {
  console.log('[conv_state_repo.clearPause] →', { propertyId, conversationId });
  await db.query(
    `UPDATE conversation_states
       SET paused=false, resume_at=NULL, paused_until=NULL, watch_mode=false
     WHERE property_id=$1 AND conversation_id=$2`,
    [propertyId, conversationId]
  );
}

/** Fully reset state (used by resolveConversation) */
export async function clearState(propertyId: string, conversationId: string) {
  console.log('[conv_state_repo.clearState] →', { propertyId, conversationId });
  await db.query(
    `UPDATE conversation_states
       SET paused=false,
           resume_at=NULL,
           paused_until=NULL,
           escalated=false,
           watch_mode=false,
           clarify_attempts=0,
           negative_count=0
     WHERE property_id=$1 AND conversation_id=$2`,
    [propertyId, conversationId]
  );
}

// --- ADD: manual pause + clear pause helpers ---
export async function manualPauseForMinutes(
  propertyId: string,
  conversationId: number | string,
  minutes: number
) {
  // set boolean flag and a unified timer using resume_at
  await db.query(
    `UPDATE conversation_states
       SET paused = TRUE,
           resume_at = NOW() + ($1 || ' minutes')::interval,
           paused_until = NULL,
           watch_mode = FALSE
     WHERE property_id = $2 AND conversation_id = $3`,
    [String(minutes), propertyId, String(conversationId)]
  );
}

/**
 * Clear timed/manual pause fields without touching counters.
 * (Renamed from duplicate clearPause to avoid redeclare error.)
 */
export async function clearPauseTimed(
  propertyId: string,
  conversationId: number | string
) {
  await db.query(
    `UPDATE conversation_states
        SET paused = FALSE,
            resume_at = NULL,
            paused_until = NULL
      WHERE property_id = $1 AND conversation_id = $2`,
    [propertyId, String(conversationId)]
  );
}

/** Reset only negative counter */
export async function resetNegativeCount(propertyId: string, conversationId: string | number) {
  await db.query(
    `UPDATE conversation_states
     SET negative_count = 0
     WHERE property_id = $1 AND conversation_id = $2`,
    [propertyId, String(conversationId)]
  );
}

// --- ADD: service_flow helpers ---
export async function getServiceFlow(conversationId: string | number) {
  const r = await db.query(
    `SELECT service_flow FROM conversation_states WHERE conversation_id=$1`,
    [String(conversationId)]
  );
  return r.rows[0]?.service_flow || null;
}

export async function setServiceFlow(conversationId: string | number, flow: any) {
  await db.query(
    `UPDATE conversation_states SET service_flow=$2 WHERE conversation_id=$1`,
    [String(conversationId), flow]
  );
}

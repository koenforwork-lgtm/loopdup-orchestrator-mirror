import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function getConvState(propertyId: string, conversationId: string) {
  const r = await pool.query(
    `SELECT bot_active, paused_until FROM conversation_states WHERE property_id=$1 AND conversation_id=$2`,
    [propertyId, conversationId]
  );
  return r.rows[0] || null;
}

export async function pauseConversation(propertyId: string, conversationId: string, minutes = 30) {
  await pool.query(
    `INSERT INTO conversation_states (property_id, conversation_id, bot_active, paused_until)
     VALUES ($1,$2,false, now() + ($3 || ' minutes')::interval)
     ON CONFLICT (property_id, conversation_id)
     DO UPDATE SET bot_active=false, paused_until=now() + ($3 || ' minutes')::interval, updated_at=now()`,
    [propertyId, conversationId, String(minutes)]
  );
}

export async function resumeConversation(propertyId: string, conversationId: string) {
  await pool.query(
    `INSERT INTO conversation_states (property_id, conversation_id, bot_active, paused_until)
     VALUES ($1,$2,true, NULL)
     ON CONFLICT (property_id, conversation_id)
     DO UPDATE SET bot_active=true, paused_until=NULL, updated_at=now()`,
    [propertyId, conversationId]
  );
}

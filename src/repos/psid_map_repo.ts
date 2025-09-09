// src/repos/psid_map_repo.ts
import { db } from './db';

const ensureSQL = `
  CREATE TABLE IF NOT EXISTS messenger_psid_map (
    psid TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    property_id TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

export async function savePsidMapping(psid: string, conversationId: string | number, propertyId?: string) {
  if (!psid) return;
  await db.query(ensureSQL);
  await db.query(
    `INSERT INTO messenger_psid_map (psid, conversation_id, property_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (psid)
     DO UPDATE SET conversation_id = EXCLUDED.conversation_id,
                   property_id = EXCLUDED.property_id,
                   updated_at = NOW()`,
    [psid, String(conversationId), propertyId || null]
  );
}

export async function getConversationIdByPsid(psid: string): Promise<string | null> {
  if (!psid) return null;
  await db.query(ensureSQL);
  const r = await db.query(
    `SELECT conversation_id FROM messenger_psid_map WHERE psid=$1 LIMIT 1`,
    [psid]
  );
  return r.rows?.[0]?.conversation_id ?? null;
}


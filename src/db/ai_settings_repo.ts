import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type AISettings = {
  faq_conf_threshold: number;
  trgm_min_similarity: number;
  intent_escalate_unknown: boolean;
  chitchat_enabled: boolean;
};

export async function getAISettings(propertyId: string): Promise<AISettings> {
  const r = await pool.query(
    `SELECT
       COALESCE(faq_conf_threshold, 0.55) AS faq_conf_threshold,
       COALESCE(trgm_min_similarity, 0.35) AS trgm_min_similarity,
       COALESCE(intent_escalate_unknown, true) AS intent_escalate_unknown,
       COALESCE(chitchat_enabled, true) AS chitchat_enabled
     FROM ai_settings WHERE property_id=$1 LIMIT 1`,
    [propertyId]
  );
  if (!r.rows[0]) {
    return { faq_conf_threshold: 0.55, trgm_min_similarity: 0.35, intent_escalate_unknown: true, chitchat_enabled: true };
  }
  return r.rows[0];
}

import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type FAQHit = { question: string; answer: string; sim: number; method: "VECTOR" | "TRIGRAM" };

// TODO: wire live embeddings if needed. For now return empty.
export async function vectorSearch(_propertyId: string, _q: string, _limit = 3): Promise<FAQHit[]> {
  return [];
}

export async function trigramSearch(propertyId: string, q: string, limit = 3): Promise<FAQHit[]> {
  const r = await pool.query(
    `SELECT question, answer, similarity(question, $2) AS sim
     FROM faqs
     WHERE property_id=$1
     ORDER BY question <-> $2
     LIMIT $3`,
    [propertyId, q, limit]
  );
  return r.rows.map((row: any) => ({ question: row.question, answer: row.answer, sim: Number(row.sim), method: "TRIGRAM" as const }));
}

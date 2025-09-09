import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function findServiceKeyByText(
  text: string,
  tenantId = 'default'
): Promise<string | undefined> {
  const q = `
    SELECT service_key
    FROM service_map
    WHERE enabled = TRUE
      AND tenant_id = $1
      AND $2 ILIKE '%' || pattern || '%'
    ORDER BY length(pattern) DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [tenantId, text]);
  return rows?.[0]?.service_key;
}

export type ServiceAction = {
  action_type: 'ASK_DETAILS' | 'REPLY' | 'ESCALATE' | string;
  reply_template?: string | null;
  requires_fields?: any | null;
  integration?: any | null;
};

export async function getServiceActions(
  serviceKey: string,
  tenantId = 'default'
): Promise<ServiceAction[]> {
  const q = `
    SELECT action_type, reply_template, requires_fields, integration
    FROM service_actions
    WHERE enabled = TRUE
      AND tenant_id = $1
      AND service_key = $2
    ORDER BY sort_order ASC, id ASC
  `;
  const { rows } = await pool.query(q, [tenantId, serviceKey]);
  return rows as ServiceAction[];
}

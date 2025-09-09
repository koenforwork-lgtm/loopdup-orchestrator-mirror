export const cfg = {
  PORT: process.env.PORT || "3110",
  DATABASE_URL: process.env.DATABASE_URL || "",
  CHATWOOT_BASE_URL: process.env.CHATWOOT_BASE_URL || "",
  CHATWOOT_API_TOKEN: process.env.CHATWOOT_API_TOKEN || "",
  NODE_ENV: process.env.NODE_ENV || "development"
};

export function assertConfig() {
  const missing: string[] = [];
  if (!cfg.DATABASE_URL) missing.push("DATABASE_URL");
  if (!cfg.CHATWOOT_BASE_URL) missing.push("CHATWOOT_BASE_URL");
  if (!cfg.CHATWOOT_API_TOKEN) missing.push("CHATWOOT_API_TOKEN");
  if (missing.length) throw new Error("Missing env: " + missing.join(", "));
}

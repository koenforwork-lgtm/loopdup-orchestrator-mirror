// packages/orchestrator/src/repos/ai_settings_repo.ts

export type AiSettings = {
  chitchat_enabled: boolean;
  faq_conf_threshold?: number;
  negative_repeat_threshold?: number;
  auto_resume_minutes?: number;
  escalate_keywords?: string[];
};

// Defaults come from env with reasonable fallbacks
const DEFAULTS: AiSettings = {
  chitchat_enabled: process.env.CHITCHAT_ENABLED
    ? process.env.CHITCHAT_ENABLED.toLowerCase() === 'true'
    : true,
  faq_conf_threshold: Number(process.env.FAQ_CONF_THRESHOLD || 0.75),
  negative_repeat_threshold: Number(process.env.NEGATIVE_REPEAT_THRESHOLD || 2),
  auto_resume_minutes: Number(process.env.AUTO_RESUME_MINUTES || 30),
  escalate_keywords: (process.env.ESCALATE_KEYWORDS || 'human,agent,staff,manager')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
};

/**
 * Minimal, non-breaking version.
 * Later we can read from DB (ai_settings table) and merge with DEFAULTS.
 */
export async function getAiSettings(propertyId?: string): Promise<AiSettings> {
  // Ignore propertyId for now; return env-driven defaults.
  return DEFAULTS;
}

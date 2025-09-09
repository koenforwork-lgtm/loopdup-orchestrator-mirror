// src/config/modules.ts
// Central feature flags (per property) so we can switch modules on/off safely.
// Essential modules (webhook, adapters, repos) are always on — not listed here.

export type ModuleName =
  | 'faq'
  | 'smalltalk'
  | 'ai_concierge'
  | 'escalation'
  | 'auto_pause';

export type ModuleFlags = Record<ModuleName, boolean>;

// ---- Defaults (safe baseline for all properties) ----
const DEFAULT_FLAGS: ModuleFlags = {
  faq: true,
  smalltalk: false,       // off by default until we improve it
  ai_concierge: true,     // core answer flow
  escalation: true,       // staff takeover
  auto_pause: true,       // pause bot when escalated / rules trigger
};

// ---- Per-property overrides (fill as we onboard clients) ----
// NOTE: Keep keys equal to your "property_id" string in the system.
const FLAGS_BY_PROPERTY: Record<string, Partial<ModuleFlags>> = {
  // Example/demo property
  hotel_demo_1: {
    faq: true,
    smalltalk: false,
    ai_concierge: true,
    escalation: true,
    auto_pause: true,
  },
  // Add more properties here as needed:
  // 'restaurant_demo_1': { faq: true, smalltalk: true, escalation: false },
};

// ---- Optional environment-wide overrides (quick global switches) ----
// Use env like MOD_FAQ=0, MOD_ESCALATION=1 to force features globally.
function envOverride(defaultVal: boolean, envName: string): boolean {
  const v = process.env[envName];
  if (v === undefined) return defaultVal;
  return v === '1' || v?.toLowerCase() === 'true';
}

function applyEnvOverrides(flags: ModuleFlags): ModuleFlags {
  return {
    ...flags,
    faq:          envOverride(flags.faq,          'MOD_FAQ'),
    smalltalk:    envOverride(flags.smalltalk,    'MOD_SMALLTALK'),
    ai_concierge: envOverride(flags.ai_concierge, 'MOD_AI_CONCIERGE'),
    escalation:   envOverride(flags.escalation,   'MOD_ESCALATION'),
    auto_pause:   envOverride(flags.auto_pause,   'MOD_AUTO_PAUSE'),
  };
}

// ---- Public API ----
export function getModuleFlags(propertyId: string): ModuleFlags {
  const overrides = FLAGS_BY_PROPERTY[propertyId] || {};
  const merged: ModuleFlags = { ...DEFAULT_FLAGS, ...overrides } as ModuleFlags;
  return applyEnvOverrides(merged);
}

export function isEnabled(propertyId: string, moduleName: ModuleName): boolean {
  const flags = getModuleFlags(propertyId);
  return !!flags[moduleName];
}

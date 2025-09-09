import type { HandlerResult } from '../app/types';
import { UI } from '../ui';

function resolveLang(s?: string): keyof typeof UI {
  const l = (s || process.env.DEFAULT_LANG || 'en').toLowerCase();
  return (UI as any)[l] ? (l as keyof typeof UI) : 'en';
}

export async function handleFallback(event: any): Promise<HandlerResult> {
  const lang = resolveLang(event?.lang);
  return { handled: true, reply: UI[lang].fallback_default };
}

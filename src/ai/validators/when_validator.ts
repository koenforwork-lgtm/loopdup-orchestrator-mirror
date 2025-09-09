// src/ai/validators/when_validator.ts
// Purpose: Validate LLM booking slots BEFORE we trust them.
// - Checks shape & confidence
// - Verifies date/time ISO formats where present
// - Optionally checks service existence via a predicate you supply
// - Emits a normalized, safe payload or a clear reason to fallback/clarify

export type LlmBookingSlots = {
  service?: string | null;
  date?: string | null;        // e.g., "2025-09-03"
  time?: string | null;        // e.g., "19:00"
  datetime?: string | null;    // e.g., "2025-09-03T19:00:00"
  date_only?: string | null;   // optional alternates used by some LLM prompts
  time_only?: string | null;
  language?: string | null;    // e.g., "en", "vi", "nl"
  ampm_hint?: "AM" | "PM" | null;
  confidence?: number | null;  // 0..1
  flex?: {                     // optional flexibility info
    approx?: boolean;
    delta_minutes?: number;
  } | null;
  // ...other non-critical fields ignored by the validator
};

export type NormalizedBooking = {
  service?: string;
  date?: string;               // ISO "YYYY-MM-DD"
  time?: string;               // "HH:MM" (24h)
  datetime?: string;           // ISO 8601 if both parts available
  language?: string;
  approx?: boolean;
  confidence: number;
};

export type ValidationOutcome =
  | { ok: true; normalized: NormalizedBooking }
  | { ok: false; reason: string; needs_clarify?: "time_period" | "date" | "service" | "unknown" };

export type ValidatorOptions = {
  minConfidence?: number;                  // default 0.70
  // A predicate you provide to confirm the service is known for the tenant.
  // Keep the validator generic: we don't import repos here.
  isKnownService?: (service: string) => boolean | Promise<boolean>;
};

// --------------- helpers ----------------

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;                // YYYY-MM-DD
const ISO_TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;          // HH:MM 00..23
const ISO_DATETIME_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([.+-]?\d{2}:?\d{2}|Z)?$/;

function isIsoDate(s?: string | null): boolean {
  if (!s) return false;
  if (!ISO_DATE_RX.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime());
}

function isIsoTime(s?: string | null): boolean {
  if (!s) return false;
  return ISO_TIME_RX.test(s);
}

function isIsoDateTime(s?: string | null): boolean {
  if (!s) return false;
  if (!ISO_DATETIME_RX.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

// If we have date + time and they’re valid, return combined ISO datetime in naive form.
// We do NOT attach a timezone here; orchestration should apply property TZ later.
function combineDateTime(date?: string | null, time?: string | null): string | null {
  if (!isIsoDate(date) || !isIsoTime(time)) return null;
  // Use seconds for consistency
  return `${date}T${time}:00`;
}

// Detect likely AM/PM ambiguity if time is 1..12 without explicit AM/PM hint.
// Note: we do not have the raw user text at this stage, so this is conservative.
function timeLooksAmbiguous(time?: string | null, ampmHint?: string | null): boolean {
  if (!time) return false;
  if (ampmHint === "AM" || ampmHint === "PM") return false;
  // "7" or "7:00" should not reach here because we require HH:MM,
  // but if a loose normalizer passed "7:00", treat hour<=12 as potentially ambiguous.
  const m = time.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return false;
  const hour = parseInt(m[1], 10);
  if (Number.isNaN(hour)) return false;
  if (hour >= 13) return false;
  return hour >= 1 && hour <= 12;
}

function to24h(time?: string | null, ampmHint?: string | null): string | null {
  if (!time) return null;
  const m = time.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2] ?? "0", 10);

  if (ampmHint === "AM" && hh === 12) hh = 0;
  if (ampmHint === "PM" && hh < 12) hh += 12;

  const out = `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
  return isIsoTime(out) ? out : null;
}

// --------------- main validator ----------------

export async function validateBookingSlots(
  slots: LlmBookingSlots | null | undefined,
  opts: ValidatorOptions = {}
): Promise<ValidationOutcome> {
  const minConf = opts.minConfidence ?? Number(process.env.WHEN_LLM_MIN_CONFIDENCE ?? 0.7);

  // 1) Shape presence
  if (!slots || typeof slots !== "object") {
    return { ok: false, reason: "empty_or_bad_shape", needs_clarify: "unknown" };
  }

  // 2) Confidence gate
  const conf = typeof slots.confidence === "number" ? slots.confidence : 0;
  if (!(conf >= minConf)) {
    // Not necessarily wrong, just not confident → fallback or clarify.
    return { ok: false, reason: "low_confidence" };
  }

  // 3) Normalize language (best-effort)
  const language = (slots.language || "").toString().trim().toLowerCase() || undefined;

  // 4) Normalize service (optional but recommended)
  let service = (slots.service || "").toString().trim();
  if (service.length === 0) {
    // Service is often crucial; allow handlers to ask later if missing.
    // Mark as needs service clarification so handler can choose the next step.
    return { ok: false, reason: "missing_service", needs_clarify: "service" };
  }
  if (opts.isKnownService) {
    const known = await Promise.resolve(opts.isKnownService(service));
    if (!known) {
      return { ok: false, reason: "unknown_service", needs_clarify: "service" };
    }
  }

  // 5) Normalize time & date
  // Prefer explicit ISO datetime; else combine ISO date + time; else accept partials.
  let date = (slots.date || slots.date_only || "").toString().trim() || undefined;
  let timeRaw = (slots.time || slots.time_only || "").toString().trim() || undefined;
  let time = to24h(timeRaw, slots.ampm_hint || null) || undefined;

  // Guard: if time present but off-format, fail early to trigger fallback/clarifier.
  if (timeRaw && !time) {
    return { ok: false, reason: "bad_time_format", needs_clarify: "time_period" };
  }

  let datetime = (slots.datetime || "").toString().trim() || undefined;
  if (datetime && !isIsoDateTime(datetime)) {
    // Some models emit partials like "2025-09-03T19:00"; accept it by appending ":00"
    const patched = datetime.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) ? `${datetime}:00` : null;
    if (patched && isIsoDateTime(patched)) {
      datetime = patched;
    } else {
      // invalid datetime → try to rebuild from separate parts
      datetime = undefined;
    }
  }

  if (!datetime) {
    // If we don't have a good datetime, try to combine date + time
    if (isIsoDate(date) && isIsoTime(time)) {
      datetime = combineDateTime(date, time) || undefined;
    }
  }

  // If we still have nothing, ensure at least date or time is sane.
  if (!datetime) {
    if (date && !isIsoDate(date)) {
      return { ok: false, reason: "bad_date_format", needs_clarify: "date" };
    }
    if (time && !isIsoTime(time)) {
      return { ok: false, reason: "bad_time_format", needs_clarify: "time_period" };
    }
  }

  // 6) Ambiguity: morning/evening clarification if time is 1..12 without hint
  if (timeLooksAmbiguous(time, slots.ampm_hint || null)) {
    return { ok: false, reason: "ambiguous_time_period", needs_clarify: "time_period" };
  }

  // 7) Build normalized output
  const normalized: NormalizedBooking = {
    service,
    date: isIsoDate(date) ? date : undefined,
    time: isIsoTime(time) ? time : undefined,
    datetime: datetime, // if present, it's already ISO 8601
    language,
    approx: !!(slots.flex && slots.flex.approx),
    confidence: conf,
  };

  return { ok: true, normalized };
}

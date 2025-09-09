// Tiny regex/fuzzy extractors for booking flow slot filling.
// NOTE: No imports here—keep it dependency-free.

/* ------------------------------ Helpers --------------------------------- */

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

const WEEKDAY_ABBR: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1, mondy: 1, monady: 1,
  tue: 2, tues: 2, tuesday: 2, tus: 2, tusday: 2, tuesay: 2, teusday: 2,
  wed: 3, weds: 3, wedn: 3, wednesday: 3, wednsday: 3, wensday: 3, wednessday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thurday: 4, thursdayy: 4, thrsday: 4, thrs: 4,
  fri: 5, friday: 5, firday: 5, friyay: 5,
  sat: 6, saturday: 6, saturdy: 6, saturay: 6,
};

const MONTH_ABBR: Record<string, number> = {
  jan: 0, january: 0, janury: 0,
  feb: 1, febr: 1, february: 1, febuary: 1, februrary: 1,
  mar: 2, march: 2,
  apr: 3, april: 3, aprl: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7, agust: 7,
  sep: 8, sept: 8, september: 8, setpember: 8, septermber: 8,
  oct: 9, october: 9, octobr: 9,
  nov: 10, november: 10, novembr: 10,
  dec: 11, december: 11, decemebr: 11
};

const TOMORROW_WORDS = [
  'tomorrow','tmrw','tmr','tomo','tommorow','tomorow','tomoroww','tommorrow','tmrrw'
];

function pad2(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function today(): Date { const d = new Date(); d.setHours(0,0,0,0); return d; }
function addDays(d: Date, days: number) { const x = new Date(d); x.setDate(x.getDate() + days); x.setHours(0,0,0,0); return x; }
function fmtDate(d: Date) { return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]}`; }
function hasWord(s: string, w: string) { return new RegExp(`\\b${w}\\b`, 'i').test(s); }
function hasAnyWord(s: string, arr: string[]) { return arr.some(w => hasWord(s, w)); }

/** Levenshtein distance (tiny, for fuzzy weekday/month matching). */
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function fuzzyWeekday(word: string): number | null {
  const w = word.toLowerCase();
  if (WEEKDAY_ABBR[w] !== undefined) return WEEKDAY_ABBR[w];
  let bestIdx = -1, bestDist = Infinity;
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const dist = lev(w, WEEKDAYS[i]);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestDist <= 2 ? bestIdx : null;
}

function fuzzyMonth(word: string): number | null {
  const w = word.toLowerCase();
  if (MONTH_ABBR[w] !== undefined) return MONTH_ABBR[w];
  for (let i = 0; i < MONTHS.length; i++) {
    const full = MONTHS[i].toLowerCase();
    if (full.startsWith(w) || lev(w, full) <= 2) return i;
  }
  return null;
}
/** Next occurrence of weekday (allowing today if it’s that weekday). */
function nextWeekday(targetDow: number): Date {
  const t = today();
  const diff = (targetDow - t.getDay() + 7) % 7;
  return addDays(t, diff === 0 ? 0 : diff);
}

/** Next-week (strict) occurrence of weekday (always >= +7 days). */
function nextWeekdayStrict(targetDow: number): Date {
  const base = addDays(today(), 7);
  const diff = (targetDow - base.getDay() + 7) % 7;
  return addDays(base, diff);
}

/** Always returns the *next* occurrence (never today) of weekday as ISO (YYYY-MM-DD). */
export function nextWeekdayISO(weekdayName: string, base: Date = new Date()): string {
  const want = WEEKDAYS.indexOf(weekdayName.toLowerCase());
  if (want < 0) throw new Error(`Unknown weekday: ${weekdayName}`);
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  const diff = (want - d.getDay() + 7) % 7;
  const add = diff === 0 ? 7 : diff;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------ Guests ---------------------------------- */

const GUEST_WORDS = '(?:people|persons|person|guests|pax|pers|ppl)';
const CATEGORY_WORDS = '(?:adults?|kids?|children|child|infants?|bab(?:y|ies))';

/**
 * Extract guest count from natural text.
 * Accepts: "3 people", "2ppl", "party of 4", "for 5", "x2", "(3)",
 * and sums category phrases like "4 adults and 2 kids" → 6.
 * A bare number is only accepted if the message is basically just that number.
 */
export function parseGuests(text: string): number | null {
  const s = text.toLowerCase().trim();

  // Guard: "for 5:30" or "for 5 pm" etc. is a time, not guests
if (/\bfor\s+\d{1,2}:\d{2}\b/i.test(s)) return null;
if (/\bfor\s+\d{1,2}\s*(am|pm)\b/i.test(s)) return null;

  // Standalone number reply
  const solo = s.match(/^\(?\s*(\d{1,2})\s*\)?$/);
  if (solo) {
    const n = parseInt(solo[1], 10);
    return n >= 1 && n <= 50 ? n : null;
  }

  // Sum category counts: "4 adults and 2 kids"
  let sum = 0;
  let foundCategory = false;
  const catRe = new RegExp(`(\\d{1,2})\\s*${CATEGORY_WORDS}`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = catRe.exec(s))) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n)) { sum += n; foundCategory = true; }
  }
  if (foundCategory && sum >= 1 && sum <= 50) return sum;

  // Explicit common forms
  const patterns = [
    new RegExp(`\\bparty\\s+of\\s+(\\d{1,2})\\b`, 'i'),
    // Don't match "for 5:30" or "for 5 pm"
    new RegExp(`\\bfor\\s+(\\d{1,2})(?!:\\d{2})(?!\\s*(?:am|pm)\\b)\\b`, 'i'),
    new RegExp(`\\b(\\d{1,2})\\s*${GUEST_WORDS}\\b`, 'i'),
    new RegExp(`\\b(\\d{1,2})ppl\\b`, 'i'),
    /\b(\d{1,2})\s*x\b/i,
    /\bx\s*(\d{1,2})\b/i,
    /\((\d{1,2})\)/
  ];

  // Guard against time-like contexts (8 pm / 8:00 / 8 in the morning)
  const looksLikeTime = /\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}[:h.]\d{2}\b|\b(in|the)\s+(morning|afternoon|evening|tonight)\b/i.test(s);

  for (const re of patterns) {
    const mm = s.match(re);
    if (mm) {
      const n = parseInt(mm[1], 10);
      if (!isNaN(n) && n >= 1 && n <= 50) return n;
    }
  }

  return looksLikeTime ? null : null;
}
/* ------------------------------- Time ----------------------------------- */

/**
 * Accepts 12h ("3 pm", "03:00pm") and 24h ("15:30"),
 * plus casual forms: "7.30", "7h30", "@8", "at 8", "8 o'clock", and words "noon/midday/midnight".
 * Uses daypart hints ("morning/afternoon/evening/tonight/lunch/dinner/brunch") to disambiguate a bare hour.
 * Returns the matched raw time string (to preserve what user typed).
 */
export function parseTime(text: string): string | null {
  const s = text.toLowerCase().trim();

  if (/\b(noon|midday)\b/.test(s)) return '12:00 pm';
  if (/\b(midnight)\b/.test(s)) return '00:00';

  // Remove obvious guest and date snippets so numbers there don't get misread as time.
  let safe = s
    .replace(new RegExp(`\\b(\\d{1,2})\\s*${GUEST_WORDS}\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b(\\d{1,2})\\s*${CATEGORY_WORDS}\\b`, 'gi'), ' ')
    .replace(/\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/g, ' ')
    .replace(/\b(\d{1,2})\s+[a-z]{3,}\b/g, ' '); // 1 september

  const patterns = [
    /\b(@\s*)?(\d{1,2})(?::|\.|h)?([0-5]\d)?\s*(am|pm)\b/i,   // with am/pm
    /\b(@\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/,                 // 24h HH:MM
    /\b(@\s*)?([01]?\d|2[0-3])\.(\d{2})\b/,                  // 7.30
    /\b(@\s*)?([01]?\d|2[0-3])h(\d{2})\b/i,                  // 7h30
    /\b(@\s*)?([01]?\d|2[0-3])\s*o['’]clock\b/i,             // 8 o'clock
    /\b(?:at|@)\s*([01]?\d|2[0-3])\b/,                       // at 8 / @8
    /\b([01]?\d|2[0-3])(?::([0-5]\d))?\b/                    // bare hour or hour:minute
  ];

  for (const re of patterns) {
    const m = safe.match(re);
    if (m) {
      let out = m[0].trim();
      out = out.replace(/^@\s*/, '').replace(/\bat\s*/,'').trim();

      // Disambiguate via dayparts if no am/pm included (use original s for hints)
      if (!/\bam|pm\b/.test(out)) {
        const isMorning = /\b(morning|this\s+morning|in\s+the\s+morning|brunch|breakfast)\b/.test(s);
        const isEvening = /\b(evening|this\s+evening|tonight|dinner)\b/.test(s);
        const isAfternoon = /\b(afternoon|this\s+afternoon|lunch)\b/.test(s);
        if (isMorning) out += ' am';
        else if (isEvening || isAfternoon) out += ' pm';
      }
      return out;
    }
  }
  return null;
}

export function isAmbiguousTime(raw: string): boolean {
  const cleaned = raw.trim().toLowerCase().replace(/^@\s*/, '').replace(/\bat\s*/,'');
  if (/\b(noon|midday|midnight)\b/.test(cleaned)) return false;
  if (/\bam|pm\b/.test(cleaned)) return false;
  const bare = cleaned.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!bare) return false;
  const h = parseInt(bare[1], 10);
  return h >= 1 && h <= 12;
}

export function normalizeTime(text: string): string | null {
  if (!text) return null;
  const s = text.trim().toLowerCase().replace(/^@\s*/, '').replace(/\bat\s*/,'');

  if (/\b(noon|midday)\b/.test(s)) return '12:00';
  if (/\b(midnight)\b/.test(s)) return '00:00';

  let m = s.match(/\b([1-9]|1[0-2])(?:[:\.h]?([0-5]\d))?\s?(am|pm)\b/);
  if (m) {
    let h = parseInt(m[1], 10);
    const mins = m[2] ?? '00';
    const ap = m[3];
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${mins}`;
  }

  m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return `${m[1].padStart(2,'0')}:${m[2]}`;

  m = s.match(/\b([01]?\d|2[0-3])[\.h]([0-5]\d)\b/);
  if (m) return `${m[1].padStart(2,'0')}:${m[2]}`;

  if (/\bo['’]clock\b/.test(s)) return null;

  if (/\b([01]?\d|2[0-3])\b/.test(s) && !/\b(am|pm)\b/.test(s) && !/\d[:\.h]\d{2}/.test(s)) {
    return null; // leave ambiguous for clarifier
  }

  return null;
}

/** Pretty-print any time to 12h with am/pm. */
export function prettyTime(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^@\s*/, '').replace(/\bat\s*/,'');
  if (/\b(noon|midday)\b/.test(s)) return '12:00 pm';
  if (/\b(midnight)\b/.test(s)) return '12:00 am';

  let m = s.match(/^(\d{1,2})(?::|\.|h)?(\d{2})?\s*(am|pm)$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const mins = m[2] ? m[2] : '00';
    const ap = m[3].toLowerCase();
    if (h === 0) h = 12;
    if (h > 12) h = h % 12;
    return `${h}:${mins} ${ap}`;
  }

  m = s.match(/^(\d{1,2})(?::|\.|h)?(\d{2})?$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const mins = m[2] ?? '00';
    if (h === 0) return `12:${mins} am`;
    if (h === 12) return `12:${mins} pm`;
    if (h > 12) return `${h - 12}:${mins} pm`;
    return `${h}:${mins}`;
  }

  return raw;
}

export function isTimeUnclear(text: string): boolean {
  const raw = parseTime(text);
  if (!raw) return true;
  return isAmbiguousTime(raw);
}
/* ------------------------------- Date ----------------------------------- */

/**
 * Parse dates from casual phrases:
 * - "today", "tonight", "this morning/afternoon/evening"
 * - tomorrow variants (tmrw/tmr/tomo/tomorow/tommorow/…)
 * - "next friday" / "friday next week" / "next week friday" → strict next-week
 * - Weekday names & abbreviations (incl. common misspellings) → next occurrence
 * - Numeric "1/9", "01-09" (DD/MM by default)
 * - "1 sep", "01 september" (incl. common month misspellings)
 * Returns formatted "DD Month" or null if not recognized.
 */
export function parseDate(text: string): string | null {
  const s = text.trim().toLowerCase();

  if (/\btoday\b/.test(s) || /\btonight\b/.test(s) || /\bthis\s+(morning|afternoon|evening)\b/.test(s)) {
    return fmtDate(today());
  }

  if (hasAnyWord(s, TOMORROW_WORDS)) return fmtDate(addDays(today(), 1));

  let m = s.match(/\bnext\s+(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (m) {
    const idx = fuzzyWeekday(m[1]);
    if (idx !== null) return fmtDate(nextWeekdayStrict(idx));
  }
  m = s.match(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+next\s+week\b/);
  if (m) {
    const idx = fuzzyWeekday(m[1]);
    if (idx !== null) return fmtDate(nextWeekdayStrict(idx));
  }
  m = s.match(/\bnext\s+week\s+(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (m) {
    const idx = fuzzyWeekday(m[1]);
    if (idx !== null) return fmtDate(nextWeekdayStrict(idx));
  }

  const wd = s.match(/\b([a-z]{3,})\b/);
  if (wd) {
    const w = wd[1];
    if (WEEKDAY_ABBR[w] !== undefined) {
      return fmtDate(nextWeekday(WEEKDAY_ABBR[w]));
    }
    const idx = fuzzyWeekday(w);
    if (idx !== null) return fmtDate(nextWeekday(idx));
  }

  m = s.match(/\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      const now = today();
      const year = m[3] ? (parseInt(m[3], 10) < 100 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : now.getFullYear();
      const d = new Date(year, mm - 1, dd);
      return isNaN(d.getTime()) ? null : fmtDate(d);
    }
  }

  m = s.match(/\b(\d{1,2})\s*([a-z]{3,})\b/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const monIdx = fuzzyMonth(m[2]);
    if (monIdx !== null && dd >= 1 && dd <= 31) {
      const now = today();
      const d = new Date(now.getFullYear(), monIdx, dd);
      return isNaN(d.getTime()) ? null : fmtDate(d);
    }
  }

  return null;
}

/** Normalize common date inputs to ISO (YYYY-MM-DD). */
export function normalizeDateToISO(text: string, base: Date = today()): string | null {
  if (!text) return null;
  const s = text.trim().toLowerCase();

  if (/\btoday\b/.test(s) || /\btonight\b/.test(s) || /\bthis\s+(morning|afternoon|evening)\b/.test(s)) {
    return base.toISOString().slice(0, 10);
  }
  if (hasAnyWord(s, TOMORROW_WORDS)) return addDays(base, 1).toISOString().slice(0, 10);

  let m = s.match(/\b(20\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const dd = parseInt(m[3], 10);
    const d = new Date(y, mo - 1, dd);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  m = s.match(/\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const y = m[3] ? (parseInt(m[3], 10) < 100 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : base.getFullYear();
    const d = new Date(y, mm - 1, dd);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  m = s.match(/\b(\d{1,2})\s*([a-z]{3,})\b/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const monIdx = fuzzyMonth(m[2]);
    if (monIdx !== null && dd >= 1 && dd <= 31) {
      const d = new Date(base.getFullYear(), monIdx, dd);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }

  m = s.match(/\bnext\s+(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (m) {
    const idx = fuzzyWeekday(m[1]);
    if (idx !== null) return nextWeekdayStrict(idx).toISOString().slice(0, 10);
  }
  m = s.match(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+next\s+week\b/);
  if (m) {
    const idx = fuzzyWeekday(m[1]);
    if (idx !== null) return nextWeekdayStrict(idx).toISOString().slice(0, 10);
  }
  m = s.match(/\bnext\s+week\s+(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (m) {
    const idx = fuzzyWeekday(m[1]);
    if (idx !== null) return nextWeekdayStrict(idx).toISOString().slice(0, 10);
  }

  const wd = s.match(/\b([a-z]{3,})\b/);
  if (wd) {
    const w = wd[1];
    if (WEEKDAY_ABBR[w] !== undefined) {
      return nextWeekdayISO(WEEKDAYS[WEEKDAY_ABBR[w]], base);
    }
    const idx = fuzzyWeekday(w);
    if (idx !== null) return nextWeekdayISO(WEEKDAYS[idx], base);
  }

  return null;
}

/* ----------------------------- Name (patched) ---------------------------- */

function cleanPoliteness(n: string) {
  return n
    .replace(/\b(please|pls|plz|thank\s*you|thanks)\b/gi, '')
    .replace(/^[,\-–—.\s]+|[,\-–—.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function looksLikeName(n: string) {
  return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,}$/.test(n);
}

// Helpers to avoid false positives like "for next monday", "for 5 people", etc.
const WEEKDAY_WORDS = new Set(['sunday','monday','tuesday','wednesday','thursday','friday','saturday']);
const MONTH_WORDS = new Set([
  'january','february','march','april','may','june','july','august','september','october','november','december'
]);
function isDateLike(s: string) {
  const t = s.toLowerCase().trim();
  return (
    WEEKDAY_WORDS.has(t) ||
    MONTH_WORDS.has(t) ||
    /\b(today|tomorrow|tonight)\b/.test(t) ||
    /\b(next|this)\s+(week|weekend|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t) ||
    /\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/.test(t) ||
    /\b(\d{1,2})\s+[a-z]{3,}\b/i.test(t)
  );
}
function isTimeOrGuestLike(s: string) {
  const t = s.toLowerCase();
  return (
    /\b(?:am|pm|noon|midday|midnight)\b/.test(t) ||
    /\b([01]?\d|2[0-3])[:.h][0-5]\d\b/.test(t) ||
    new RegExp(`\\b${GUEST_WORDS}\\b`).test(t) ||
    new RegExp(`\\b${CATEGORY_WORDS}\\b`).test(t) ||
    /\b\d+\b/.test(t)
  );
}
/**
 * Extract booking name from natural phrases:
 * - "under Dibbets", "under the name Anna", "name is John"
 * - Polite endings: "Koen please"/"Anna thanks"
 * - "for <Name>" only when it looks like a human name at the end of the sentence,
 *   and NOT a date/time/guest phrase.
 */
export function parseName(text: string): string | null {
  const s = text.trim();

  // Highest confidence: explicit "under ..." or "name is ..."
  const patterns = [
    /\bunder\s+(?:the\s+name\s+)?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,})\b/i,
    /\bname\s+(?:is\s+)?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,})\b/i,
    /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,})\s+(?:please|pls|plz|thanks|thank\s*you)\b/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const cand = cleanPoliteness(m[1]);
      if (looksLikeName(cand)) return cand;
    }
  }

  // Carefully allow "for <Name>" with guards
  let m = s.match(/\bfor\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,})(?:[.!?,\s]|$)/i);
  if (m) {
    const cand = cleanPoliteness(m[1]);
    if (looksLikeName(cand) && !isDateLike(cand) && !isTimeOrGuestLike(cand)) {
      return cand;
    }
  }

  // Only treat whole message as a name if it doesn't look like a sentence
  const sentencey = /(?:\b(book|reserve|table|tomorrow|today|tonight|morning|afternoon|evening|lunch|dinner|breakfast|am|pm|people|guests|pax|kids|adults)\b|\d)/i.test(s);
  if (!sentencey) {
    const cand = cleanPoliteness(s);
    if (looksLikeName(cand) && !isDateLike(cand) && !isTimeOrGuestLike(cand)) {
      return cand;
    }
  }
  return null;
}

/* --------------------------- pretty printers ----------------------------- */

export function prettyDate(input: string): string {
  if (!input) return input;
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return isNaN(dt.getTime()) ? input : fmtDate(dt);
  }
  const pretty = parseDate(s);
  return pretty ?? input;
}

/** Clear/unclear check used by handler. */
export function isDateUnclear(text: string): boolean {
  if (!text) return true;
  const s = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; // ISO is explicit
  return parseDate(s) === null;
}

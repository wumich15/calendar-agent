/**
 * Time-zone aware date helpers built on `Intl`, so the project needs no date
 * library. Everything here works in terms of two shapes:
 *
 *  - an "instant", represented by a `Date`
 *  - a "plain date", represented by a `YYYY-MM-DD` string (used for all-day
 *    events, which have no instant until you pick a zone)
 */

const PART_KEYS = ["year", "month", "day", "hour", "minute", "second"] as const;

export type PlainParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** True when the IANA zone name is one this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading of `instant` in `timeZone`. */
export function partsInZone(instant: Date, timeZone: string): PlainParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const out: Record<string, number> = {};
  for (const part of parts) {
    if ((PART_KEYS as readonly string[]).includes(part.type)) {
      out[part.type] = Number(part.value);
    }
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Offset of `timeZone` from UTC, in minutes, at `instant` (east of UTC is positive). */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/**
 * Interpret a wall-clock reading as an instant in `timeZone`.
 *
 * Two DST cases need care. When a reading occurs twice (the hour repeated at a
 * fall-back), this returns the earlier of the two. When it does not occur at all
 * (the hour skipped at a spring-forward), no instant maps to it, so this shifts
 * forward past the gap rather than backward, matching what date libraries do.
 */
export function zonedTimeToInstant(parts: PlainParts, timeZone: string): Date {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const firstOffset = offsetMinutes(new Date(guess), timeZone);
  const firstCandidate = guess - firstOffset * 60000;
  const secondOffset = offsetMinutes(new Date(firstCandidate), timeZone);
  if (secondOffset === firstOffset) return new Date(firstCandidate);

  // The offset changed between the guess and the candidate, so re-derive the
  // instant from it and keep that only if it round-trips. If it does not, the
  // reading falls in a gap and `firstCandidate` is the value just past it.
  const secondCandidate = guess - secondOffset * 60000;
  return offsetMinutes(new Date(secondCandidate), timeZone) === secondOffset
    ? new Date(secondCandidate)
    : new Date(firstCandidate);
}

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, "0");
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  return `${sign}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/** RFC 3339 timestamp expressing `instant` as local time in `timeZone`. */
export function toRfc3339(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  const off = offsetMinutes(instant, timeZone);
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(off)}`
  );
}

/** `YYYY-MM-DD` for `instant` as seen in `timeZone`. */
export function toPlainDate(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** `HH:MM` for `instant` as seen in `timeZone`. */
export function toPlainTime(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function isPlainDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function plainDateToParts(date: string): PlainParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

/** Add `days` to a `YYYY-MM-DD` string, staying in plain-date space. */
export function addPlainDays(date: string, days: number): string {
  const p = plainDateToParts(date);
  const ts = Date.UTC(p.year, p.month - 1, p.day) + days * 86400000;
  const d = new Date(ts);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function plainDaysBetween(from: string, to: string): number {
  const a = plainDateToParts(from);
  const b = plainDateToParts(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000,
  );
}

/** Day of week for a plain date, 0 = Sunday. */
export function plainWeekday(date: string): number {
  const p = plainDateToParts(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** First day of the week containing `date`. `weekStartsOn` is 0 for Sunday. */
export function startOfWeek(date: string, weekStartsOn = 0): string {
  const diff = (plainWeekday(date) - weekStartsOn + 7) % 7;
  return addPlainDays(date, -diff);
}

export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return toPlainDate(now, timeZone);
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Human label such as `Wed, Mar 4 2026`. */
export function formatPlainDate(date: string): string {
  const p = plainDateToParts(date);
  return `${WEEKDAY_NAMES[plainWeekday(date)]}, ${MONTH_NAMES[p.month - 1]} ${p.day} ${p.year}`;
}

/** Short label such as `Wed 03-04`. */
export function formatPlainDateShort(date: string): string {
  const p = plainDateToParts(date);
  return `${WEEKDAY_NAMES[plainWeekday(date)]} ${pad(p.month)}-${pad(p.day)}`;
}

/** Start of a calendar day in a zone, as an instant. */
export function startOfDayInstant(date: string, timeZone: string): Date {
  return zonedTimeToInstant(plainDateToParts(date), timeZone);
}

/** Parse `HH:MM` or `HH:MM:SS` into minutes past midnight, or null. */
export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Parsing of date and time strings as they appear on web pages.
 *
 * The rule throughout is that we never invent information: a value that only
 * carries a date comes back as a date, a value with no zone comes back with no
 * zone, and anything genuinely ambiguous comes back as `null` so the caller can
 * skip the event instead of guessing.
 */

import type { PlainParts } from "../util/datetime.ts";

export type ParsedDateValue = {
  kind: "date" | "datetime";
  parts: PlainParts;
  /** Offset in minutes when the source stated one; undefined means "no zone given". */
  offsetMinutes?: number;
  /** IANA zone when the source named one (rare in HTML, common in iCal exports). */
  timeZone?: string;
  /** Notes such as an assumed month/day order. */
  notes: string[];
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

function parts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): PlainParts {
  return { year, month, day, hour, minute, second };
}

function validDate(p: PlainParts): boolean {
  if (p.month < 1 || p.month > 12 || p.day < 1 || p.day > 31) return false;
  if (p.hour > 23 || p.minute > 59 || p.second > 59) return false;
  const probe = new Date(Date.UTC(p.year, p.month - 1, p.day));
  return probe.getUTCMonth() === p.month - 1 && probe.getUTCDate() === p.day;
}

function offsetFrom(sign: string, hours: string, minutes: string): number {
  const magnitude = Number(hours) * 60 + Number(minutes || "0");
  return sign === "-" ? -magnitude : magnitude;
}

/** Applies a 12-hour clock suffix, if present, to an hour reading. */
function applyMeridiem(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  const lower = meridiem.toLowerCase().replace(/[.\s]/g, "");
  if (lower === "pm" && hour < 12) return hour + 12;
  if (lower === "am" && hour === 12) return 0;
  return hour;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;
const ICAL_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;
const MONTH_FIRST_RE = new RegExp(
  `^(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s*(\\d{4})?$`,
  "i",
);
const DAY_FIRST_RE = new RegExp(
  `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\.?(?:,)?\\s*(\\d{4})?$`,
  "i",
);
const NUMERIC_RE = /^(\d{1,4})[/.](\d{1,2})[/.](\d{2,4})$/;
const TIME_RE = /(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap]\.?m\.?)?/i;

/**
 * Parses an ISO-8601-ish machine value: what `<time datetime>`, JSON-LD, and
 * microdata normally carry. Returns null when the value is not machine-readable.
 */
export function parseMachineDate(raw: string): ParsedDateValue | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = ISO_RE.exec(value);
  if (iso) {
    const p = parts(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
    );
    if (!validDate(p)) return null;
    if (iso[4] === undefined) return { kind: "date", parts: p, notes: [] };
    const zone = iso[7];
    let offsetMinutes: number | undefined;
    if (zone) {
      if (/^z$/i.test(zone)) offsetMinutes = 0;
      else {
        const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
        if (m) offsetMinutes = offsetFrom(m[1]!, m[2]!, m[3]!);
      }
    }
    return { kind: "datetime", parts: p, offsetMinutes, notes: [] };
  }

  const ical = ICAL_RE.exec(value);
  if (ical) {
    const p = parts(
      Number(ical[1]),
      Number(ical[2]),
      Number(ical[3]),
      Number(ical[4] ?? 0),
      Number(ical[5] ?? 0),
      Number(ical[6] ?? 0),
    );
    if (!validDate(p)) return null;
    if (ical[4] === undefined) return { kind: "date", parts: p, notes: [] };
    return { kind: "datetime", parts: p, offsetMinutes: ical[7] ? 0 : undefined, notes: [] };
  }

  return null;
}

/**
 * Parses a human-written date, optionally with a time: "March 4, 2026 7:30 PM",
 * "4 Mar 2026", "2026/03/04". `referenceYear` fills in a missing year, which
 * listings often omit; that substitution is reported in `notes`.
 */
export function parseHumanDate(
  raw: string,
  options: { referenceYear?: number; dayFirst?: boolean } = {},
): ParsedDateValue | null {
  let value = raw
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return null;

  const notes: string[] = [];

  // Strip a leading weekday name, which carries no information we need.
  value = value.replace(
    /^(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*\.?,?\s+/i,
    "",
  );

  // Split off a trailing time, e.g. "March 4, 2026 at 7:30 PM".
  let timePart: string | undefined;
  const atSplit = /\s+(?:at|@|,)\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*$/i.exec(value);
  if (atSplit) {
    timePart = atSplit[1];
    value = value.slice(0, atSplit.index).trim();
  } else {
    const tail = /\s+(\d{1,2}(?::\d{2})(?::\d{2})?\s*(?:[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?)\s*$/i.exec(value);
    if (tail) {
      timePart = tail[1];
      value = value.slice(0, tail.index).trim();
    }
  }
  value = value.replace(/[,\s]+$/, "");

  let datePart: PlainParts | null = null;

  const monthFirst = MONTH_FIRST_RE.exec(value);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1]!.toLowerCase()]!;
    const year = monthFirst[3] ? Number(monthFirst[3]) : options.referenceYear;
    if (year === undefined) return null;
    if (!monthFirst[3]) notes.push(`the page omitted a year, so ${year} was used`);
    datePart = parts(year, month, Number(monthFirst[2]));
  }

  if (!datePart) {
    const dayFirst = DAY_FIRST_RE.exec(value);
    if (dayFirst) {
      const month = MONTHS[dayFirst[2]!.toLowerCase()]!;
      const year = dayFirst[3] ? Number(dayFirst[3]) : options.referenceYear;
      if (year === undefined) return null;
      if (!dayFirst[3]) notes.push(`the page omitted a year, so ${year} was used`);
      datePart = parts(year, month, Number(dayFirst[1]));
    }
  }

  if (!datePart) {
    const numeric = NUMERIC_RE.exec(value);
    if (numeric) {
      const a = Number(numeric[1]);
      const b = Number(numeric[2]);
      const c = Number(numeric[3]);
      if (String(numeric[1]).length === 4) {
        datePart = parts(a, b, c); // Unambiguous: YYYY/MM/DD.
      } else {
        const year = c < 100 ? 2000 + c : c;
        // A value over 12 in the first slot can only be a day.
        const dayFirstOrder = options.dayFirst || a > 12;
        if (!dayFirstOrder && b > 12 && a <= 12) {
          datePart = parts(year, a, b);
        } else if (dayFirstOrder) {
          datePart = parts(year, b, a);
          if (a <= 12) notes.push("read the numeric date as day/month");
        } else {
          datePart = parts(year, a, b);
          if (b <= 12) notes.push("read the numeric date as month/day");
        }
      }
    }
  }

  if (!datePart || !validDate(datePart)) return null;

  if (timePart) {
    const t = TIME_RE.exec(timePart);
    if (t) {
      const hour = applyMeridiem(Number(t[1]), t[4]);
      const p = parts(
        datePart.year,
        datePart.month,
        datePart.day,
        hour,
        Number(t[2] ?? 0),
        Number(t[3] ?? 0),
      );
      if (validDate(p)) return { kind: "datetime", parts: p, notes };
    }
  }

  return { kind: "date", parts: datePart, notes };
}

/** Machine formats first, then human prose. */
export function parseDateValue(
  raw: string,
  options: { referenceYear?: number; dayFirst?: boolean } = {},
): ParsedDateValue | null {
  return parseMachineDate(raw) ?? parseHumanDate(raw, options);
}

/**
 * Pulls a start (and optional end) time out of prose like
 * "7:00 PM - 9:30 PM" or "19:00–21:00".
 */
export function parseTimeRange(raw: string): {
  start: { hour: number; minute: number };
  end?: { hour: number; minute: number };
} | null {
  const value = raw.replace(/ /g, " ").trim();
  const range =
    /(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(
      value,
    );
  if (range) {
    // "7 - 9 PM": an unmarked first half borrows the second half's meridiem.
    const endMeridiem = range[6];
    const startMeridiem = range[3] ?? endMeridiem;
    const start = {
      hour: applyMeridiem(Number(range[1]), startMeridiem),
      minute: Number(range[2] ?? 0),
    };
    const end = {
      hour: applyMeridiem(Number(range[4]), endMeridiem),
      minute: Number(range[5] ?? 0),
    };
    if (start.hour > 23 || end.hour > 23 || start.minute > 59 || end.minute > 59) return null;
    return { start, end };
  }
  const single = /(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)(?:\s|$)|(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/i.exec(
    value,
  );
  if (!single) return null;
  if (single[1] !== undefined) {
    const hour = applyMeridiem(Number(single[1]), single[3]);
    const minute = Number(single[2] ?? 0);
    if (hour > 23 || minute > 59) return null;
    return { start: { hour, minute } };
  }
  const hour = Number(single[4]);
  const minute = Number(single[5]);
  if (hour > 23 || minute > 59) return null;
  return { start: { hour, minute } };
}

/** Recognizes an explicit all-day marker in page text. */
export function looksAllDay(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(all[-\s]?day|whole day|ganztägig|toute la journée)\b/i.test(text);
}

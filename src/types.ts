/** Shared data shapes used across extraction, the calendar client, and the TUI. */

/** A date-or-datetime endpoint, matching the Google Calendar event time shape. */
export type EventTime =
  | { date: string; dateTime?: undefined; timeZone?: string }
  | { dateTime: string; date?: undefined; timeZone?: string };

/** Raw, still-unvalidated event data pulled off a page. */
export type ExtractedEvent = {
  name?: string;
  /** Untouched start value as written on the page. */
  startRaw?: string;
  endRaw?: string;
  /** Page said so explicitly (e.g. a schema.org date-only startDate). */
  allDay?: boolean;
  timeZone?: string;
  location?: string;
  description?: string;
  /** Canonical link for the event itself, when the page offers one. */
  url?: string;
  /** Stable identifier published by the source, if any. */
  sourceId?: string;
  /** Which extractor produced this record; used for reporting only. */
  via: "json-ld" | "microdata" | "hcalendar" | "html";
};

/** An extracted event that has been normalized far enough to import. */
export type NormalizedEvent = {
  name: string;
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  location?: string;
  description?: string;
  url?: string;
  sourceUrl: string;
  sourceId?: string;
  /** Stable key used for duplicate detection. */
  dedupeKey: string;
  /** Interpretation choices worth telling the user about. */
  assumptions: string[];
  via: ExtractedEvent["via"];
};

/** An event that could not be imported, with the reason why. */
export type SkippedEvent = {
  name: string;
  reason: string;
  via: ExtractedEvent["via"];
};

/** A Google Calendar event as this app models it. */
export type CalendarEvent = {
  id: string;
  etag?: string;
  summary: string;
  description?: string;
  location?: string;
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  status?: string;
  htmlLink?: string;
  /** Present when this is one occurrence of a recurring series. */
  recurringEventId?: string;
  originalStartTime?: EventTime;
  /** The event's own recurrence rules, when it is the series master. */
  recurrence?: string[];
  organizerSelf?: boolean;
  /** False when Google says this specific event cannot be changed. */
  writable: boolean;
  extendedPrivate?: Record<string, string>;
  /** Raw payload, preserved so unedited fields survive a round trip. */
  raw?: Record<string, unknown>;
};

export type CalendarInfo = {
  id: string;
  summary: string;
  timeZone: string;
  accessRole: string;
  primary?: boolean;
};

/** Thrown for problems we can explain to the user without a stack trace. */
export class UserFacingError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UserFacingError";
    this.hint = hint;
  }
}

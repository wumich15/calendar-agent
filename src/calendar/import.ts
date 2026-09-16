import type { CalendarClient } from "./client.ts";
import { explainApiError } from "./client.ts";
import type { NormalizedEvent, SkippedEvent } from "../types.ts";

/** Extended-property keys cal writes on every event it creates. */
export const DEDUPE_PROPERTY = "calDedupeKey";
export const SOURCE_PROPERTY = "calSourceUrl";

export type ImportedEntry = { name: string; when: string; id: string; htmlLink?: string };
export type DuplicateEntry = { name: string; when: string; existingId: string };
export type FailedEntry = { name: string; when: string; error: string };

export type ImportReport = {
  sourceUrl: string;
  dryRun: boolean;
  calendarId: string;
  timeZone: string;
  imported: ImportedEntry[];
  duplicates: DuplicateEntry[];
  skipped: SkippedEvent[];
  failed: FailedEntry[];
  /** Interpretation notes, per event, worth surfacing to the user. */
  assumptions: Array<{ name: string; notes: string[] }>;
};

/** Human-readable schedule line for an event, used throughout the summary. */
export function describeWhen(event: NormalizedEvent): string {
  if (event.allDay) {
    const start = event.start.date!;
    const end = event.end.date!;
    // The stored end date is exclusive; show the last day the event covers.
    const lastDay = new Date(`${end}T00:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    const inclusiveEnd = lastDay.toISOString().slice(0, 10);
    return inclusiveEnd === start ? `${start} (all day)` : `${start} to ${inclusiveEnd} (all day)`;
  }
  const start = event.start.dateTime!;
  const end = event.end.dateTime!;
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  return sameDay
    ? `${start.slice(0, 10)} ${start.slice(11, 16)}-${end.slice(11, 16)} (${event.start.timeZone})`
    : `${start.slice(0, 16).replace("T", " ")} to ${end.slice(0, 16).replace("T", " ")} (${event.start.timeZone})`;
}

/** Builds the Google Calendar request body for a normalized event. */
export function toGoogleEventBody(event: NormalizedEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: event.name,
    description: event.description,
    start: event.allDay ? { date: event.start.date } : { dateTime: event.start.dateTime, timeZone: event.start.timeZone },
    end: event.allDay ? { date: event.end.date } : { dateTime: event.end.dateTime, timeZone: event.end.timeZone },
    source: { title: "Imported by cal", url: event.sourceUrl },
    extendedProperties: {
      private: {
        [DEDUPE_PROPERTY]: event.dedupeKey,
        [SOURCE_PROPERTY]: event.sourceUrl.slice(0, 1024),
      },
    },
  };
  if (event.location) body.location = event.location;
  return body;
}

export type ImportOptions = {
  client: CalendarClient;
  calendarId: string;
  timeZone: string;
  sourceUrl: string;
  dryRun?: boolean;
  /** Called as each event is processed, so the CLI can show progress. */
  onProgress?: (done: number, total: number, name: string) => void;
};

/**
 * Creates each event on the calendar, skipping any that a previous run already
 * imported. Duplicate detection asks Google for an event carrying the same
 * private `calDedupeKey`, which is the same key a re-scrape of an unchanged page
 * produces.
 */
export async function importEvents(
  events: NormalizedEvent[],
  skipped: SkippedEvent[],
  options: ImportOptions,
): Promise<ImportReport> {
  const report: ImportReport = {
    sourceUrl: options.sourceUrl,
    dryRun: Boolean(options.dryRun),
    calendarId: options.calendarId,
    timeZone: options.timeZone,
    imported: [],
    duplicates: [],
    skipped: [...skipped],
    failed: [],
    assumptions: [],
  };

  for (const [index, event] of events.entries()) {
    options.onProgress?.(index + 1, events.length, event.name);
    const when = describeWhen(event);
    if (event.assumptions.length) {
      report.assumptions.push({ name: event.name, notes: [...new Set(event.assumptions)] });
    }

    try {
      const existing = await options.client.findByPrivateProperty({
        calendarId: options.calendarId,
        key: DEDUPE_PROPERTY,
        value: event.dedupeKey,
      });
      const live = existing.find((item) => item.status !== "cancelled");
      if (live) {
        report.duplicates.push({ name: event.name, when, existingId: live.id });
        continue;
      }

      if (options.dryRun) {
        report.imported.push({ name: event.name, when, id: "(dry run)" });
        continue;
      }

      const created = await options.client.createEvent(options.calendarId, toGoogleEventBody(event));
      report.imported.push({
        name: event.name,
        when,
        id: created.id,
        htmlLink: created.htmlLink,
      });
    } catch (err) {
      report.failed.push({ name: event.name, when, error: explainApiError(err) });
    }
  }

  return report;
}

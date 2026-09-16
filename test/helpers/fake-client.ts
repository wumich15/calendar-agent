/**
 * An in-memory stand-in for the Google Calendar API, used by the import, save,
 * and app tests so none of them touch the network.
 */

import { CalendarApiError, type CalendarClient } from "../../src/calendar/client.ts";
import type { CalendarEvent, CalendarInfo } from "../../src/types.ts";

export type FakeEvent = Partial<CalendarEvent> & { id: string };

export type FailureRule = {
  /** Which call to fail. */
  op: "create" | "patch" | "delete" | "list" | "get";
  /** Event id to fail on, or "*" for any. */
  eventId?: string;
  status: number;
  message?: string;
  /** Fail only the first matching call. */
  once?: boolean;
};

export function makeEvent(overrides: FakeEvent): CalendarEvent {
  return {
    etag: `"etag-${overrides.id}"`,
    summary: "Untitled",
    start: { dateTime: "2026-09-15T09:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-09-15T10:00:00-04:00", timeZone: "America/New_York" },
    allDay: false,
    writable: true,
    status: "confirmed",
    ...overrides,
  } as CalendarEvent;
}

export class FakeCalendarClient implements CalendarClient {
  readonly events = new Map<string, CalendarEvent>();
  readonly calendar: CalendarInfo;
  readonly calls: string[] = [];
  failures: FailureRule[] = [];
  #nextId = 1;

  constructor(
    seed: CalendarEvent[] = [],
    calendar: CalendarInfo = {
      id: "primary",
      summary: "Test Calendar",
      timeZone: "America/New_York",
      accessRole: "owner",
      primary: true,
    },
  ) {
    this.calendar = calendar;
    for (const event of seed) this.events.set(event.id, event);
  }

  #check(op: FailureRule["op"], eventId?: string): void {
    const index = this.failures.findIndex(
      (rule) => rule.op === op && (!rule.eventId || rule.eventId === "*" || rule.eventId === eventId),
    );
    if (index === -1) return;
    const rule = this.failures[index]!;
    if (rule.once) this.failures.splice(index, 1);
    throw new CalendarApiError(rule.message ?? `Simulated ${op} failure`, rule.status);
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return [this.calendar];
  }

  async getCalendar(): Promise<CalendarInfo> {
    return this.calendar;
  }

  async listEvents(opts: { timeMin: Date; timeMax: Date }): Promise<CalendarEvent[]> {
    this.calls.push("list");
    this.#check("list");
    const min = opts.timeMin.getTime();
    const max = opts.timeMax.getTime();
    return [...this.events.values()]
      .filter((event) => {
        if (event.status === "cancelled") return false;
        const start = new Date(event.start.date ?? event.start.dateTime ?? "").getTime();
        const end = new Date(event.end.date ?? event.end.dateTime ?? "").getTime();
        return start < max && end > min;
      })
      .map((event) => ({ ...event }));
  }

  async findByPrivateProperty(opts: { key: string; value: string }): Promise<CalendarEvent[]> {
    this.calls.push(`find:${opts.value}`);
    return [...this.events.values()].filter(
      (event) => event.extendedPrivate?.[opts.key] === opts.value,
    );
  }

  async getEvent(_calendarId: string, eventId: string): Promise<CalendarEvent> {
    this.calls.push(`get:${eventId}`);
    this.#check("get", eventId);
    const event = this.events.get(eventId);
    if (!event) throw new CalendarApiError("Not Found", 404);
    return { ...event };
  }

  async createEvent(_calendarId: string, body: Record<string, unknown>): Promise<CalendarEvent> {
    this.calls.push(`create:${String(body.summary)}`);
    this.#check("create");
    const id = `created-${this.#nextId++}`;
    const start = body.start as { date?: string; dateTime?: string; timeZone?: string };
    const end = body.end as { date?: string; dateTime?: string; timeZone?: string };
    const extended = body.extendedProperties as { private?: Record<string, string> } | undefined;
    const event = makeEvent({
      id,
      summary: String(body.summary ?? ""),
      description: body.description as string | undefined,
      location: body.location as string | undefined,
      start: start as CalendarEvent["start"],
      end: end as CalendarEvent["end"],
      allDay: Boolean(start?.date),
      extendedPrivate: extended?.private,
      htmlLink: `https://calendar.google.com/event?eid=${id}`,
    });
    this.events.set(id, event);
    return { ...event };
  }

  async patchEvent(
    _calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
    etag?: string,
  ): Promise<CalendarEvent> {
    this.calls.push(`patch:${eventId}`);
    this.#check("patch", eventId);
    const existing = this.events.get(eventId);
    if (!existing) throw new CalendarApiError("Not Found", 404);
    if (etag && existing.etag && etag !== existing.etag) {
      throw new CalendarApiError("Precondition Failed", 412);
    }
    const start = (body.start as CalendarEvent["start"]) ?? existing.start;
    const updated: CalendarEvent = {
      ...existing,
      ...(body.summary !== undefined ? { summary: String(body.summary) } : {}),
      ...(body.location !== undefined ? { location: String(body.location) } : {}),
      ...(body.description !== undefined ? { description: String(body.description) } : {}),
      start,
      end: (body.end as CalendarEvent["end"]) ?? existing.end,
      allDay: Boolean(start.date),
      etag: `"etag-${eventId}-${Date.now()}"`,
    };
    this.events.set(eventId, updated);
    return { ...updated };
  }

  async deleteEvent(_calendarId: string, eventId: string, etag?: string): Promise<void> {
    this.calls.push(`delete:${eventId}`);
    this.#check("delete", eventId);
    const existing = this.events.get(eventId);
    if (!existing) return; // Already gone counts as deleted.
    if (etag && existing.etag && etag !== existing.etag) {
      throw new CalendarApiError("Precondition Failed", 412);
    }
    this.events.delete(eventId);
  }
}

import type { TokenProvider } from "../auth/google-auth.ts";
import {
  UserFacingError,
  type CalendarEvent,
  type CalendarInfo,
  type EventTime,
} from "../types.ts";

const API_BASE = "https://www.googleapis.com/calendar/v3";

/** A Google API error we can describe precisely, including its HTTP status. */
export class CalendarApiError extends Error {
  readonly status: number;
  readonly reason?: string;
  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
    this.reason = reason;
  }
  /** A 412 means the caller's `If-Match` etag is stale: someone else edited it. */
  get isConflict(): boolean {
    return this.status === 412 || this.status === 409;
  }
  get isNotFound(): boolean {
    return this.status === 404 || this.status === 410;
  }
  get isPermission(): boolean {
    return this.status === 403 && this.reason !== "rateLimitExceeded" &&
      this.reason !== "userRateLimitExceeded";
  }
}

/** The subset of the client the rest of the app depends on, so tests can fake it. */
export type CalendarClient = {
  listCalendars(): Promise<CalendarInfo[]>;
  getCalendar(calendarId: string): Promise<CalendarInfo>;
  listEvents(opts: {
    calendarId: string;
    timeMin: Date;
    timeMax: Date;
    signal?: AbortSignal;
  }): Promise<CalendarEvent[]>;
  findByPrivateProperty(opts: {
    calendarId: string;
    key: string;
    value: string;
  }): Promise<CalendarEvent[]>;
  createEvent(calendarId: string, body: Record<string, unknown>): Promise<CalendarEvent>;
  patchEvent(
    calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
    etag?: string,
  ): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void>;
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent>;
};

type GoogleTime = { date?: string; dateTime?: string; timeZone?: string };

function toEventTime(value: GoogleTime | undefined): EventTime {
  if (value?.date) return { date: value.date, timeZone: value.timeZone };
  return { dateTime: value?.dateTime ?? "", timeZone: value?.timeZone };
}

type GoogleEvent = {
  id: string;
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  status?: string;
  htmlLink?: string;
  recurringEventId?: string;
  originalStartTime?: GoogleTime;
  recurrence?: string[];
  guestsCanModify?: boolean;
  organizer?: { self?: boolean };
  creator?: { self?: boolean };
  extendedProperties?: { private?: Record<string, string> };
};

export function mapGoogleEvent(raw: GoogleEvent, calendarWritable: boolean): CalendarEvent {
  const allDay = Boolean(raw.start?.date);
  return {
    id: raw.id,
    etag: raw.etag,
    summary: raw.summary ?? "(no title)",
    description: raw.description,
    location: raw.location,
    start: toEventTime(raw.start),
    end: toEventTime(raw.end),
    allDay,
    status: raw.status,
    htmlLink: raw.htmlLink,
    recurringEventId: raw.recurringEventId,
    originalStartTime: raw.originalStartTime ? toEventTime(raw.originalStartTime) : undefined,
    recurrence: raw.recurrence,
    organizerSelf: raw.organizer?.self,
    // Google only lets a non-organizer change an event when guestsCanModify is set.
    writable:
      calendarWritable &&
      (raw.organizer?.self !== false || raw.guestsCanModify === true || raw.creator?.self === true),
    extendedPrivate: raw.extendedProperties?.private,
    raw: raw as unknown as Record<string, unknown>,
  };
}

const WRITABLE_ROLES = new Set(["owner", "writer"]);

export function roleIsWritable(accessRole: string | undefined): boolean {
  return WRITABLE_ROLES.has(accessRole ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GoogleCalendarClientOptions = {
  tokens: TokenProvider;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
};

export class GoogleCalendarClient implements CalendarClient {
  readonly #tokens: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  /** accessRole per calendar id, learned on first use and reused. */
  readonly #roleCache = new Map<string, string>();

  constructor(options: GoogleCalendarClientOptions) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxRetries = options.maxRetries ?? 3;
  }

  async #request(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined> } = {},
    attempt = 0,
  ): Promise<Response> {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const token = await this.#tokens.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");

    let res: Response;
    try {
      res = await this.#fetch(url.toString(), { ...init, headers });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      throw new UserFacingError(
        `Could not reach Google Calendar: ${(err as Error).message}`,
        "Check your network connection and try again.",
      );
    }

    if (res.status === 401 && attempt === 0) {
      // The token may have been revoked or rotated; force one refresh and retry.
      await this.#tokens.getAccessToken(true);
      return this.#request(path, init, attempt + 1);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < this.#maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 400 + Math.random() * 200;
      await sleep(delay);
      return this.#request(path, init, attempt + 1);
    }
    return res;
  }

  async #json<T>(path: string, init: RequestInit & { query?: Record<string, string | undefined> } = {}): Promise<T> {
    const res = await this.#request(path, init);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) throw toApiError(res.status, body);
    return body as T;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const body = await this.#json<{ items?: Array<Record<string, unknown>> }>(
      "/users/me/calendarList",
      { query: { minAccessRole: "reader", maxResults: "250" } },
    );
    return (body.items ?? []).map((item) => {
      const info: CalendarInfo = {
        id: String(item.id),
        summary: String(item.summaryOverride ?? item.summary ?? item.id),
        timeZone: String(item.timeZone ?? "UTC"),
        accessRole: String(item.accessRole ?? "reader"),
        primary: item.primary === true,
      };
      this.#roleCache.set(info.id, info.accessRole);
      return info;
    });
  }

  async getCalendar(calendarId: string): Promise<CalendarInfo> {
    const body = await this.#json<Record<string, unknown>>(
      `/users/me/calendarList/${encodeURIComponent(calendarId)}`,
    );
    const info: CalendarInfo = {
      id: String(body.id),
      summary: String(body.summaryOverride ?? body.summary ?? body.id),
      timeZone: String(body.timeZone ?? "UTC"),
      accessRole: String(body.accessRole ?? "reader"),
      primary: body.primary === true,
    };
    this.#roleCache.set(info.id, info.accessRole);
    return info;
  }

  async #writable(calendarId: string): Promise<boolean> {
    let role = this.#roleCache.get(calendarId);
    if (!role) {
      try {
        role = (await this.getCalendar(calendarId)).accessRole;
      } catch {
        role = "owner"; // Assume writable; the API still rejects forbidden writes.
      }
    }
    return roleIsWritable(role);
  }

  async listEvents(opts: {
    calendarId: string;
    timeMin: Date;
    timeMax: Date;
    signal?: AbortSignal;
  }): Promise<CalendarEvent[]> {
    const writable = await this.#writable(opts.calendarId);
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const body = await this.#json<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(opts.calendarId)}/events`,
        {
          signal: opts.signal,
          query: {
            timeMin: opts.timeMin.toISOString(),
            timeMax: opts.timeMax.toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "2500",
            showDeleted: "false",
            pageToken,
          },
        },
      );
      for (const item of body.items ?? []) events.push(mapGoogleEvent(item, writable));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return events;
  }

  async findByPrivateProperty(opts: {
    calendarId: string;
    key: string;
    value: string;
  }): Promise<CalendarEvent[]> {
    const body = await this.#json<{ items?: GoogleEvent[] }>(
      `/calendars/${encodeURIComponent(opts.calendarId)}/events`,
      {
        query: {
          privateExtendedProperty: `${opts.key}=${opts.value}`,
          showDeleted: "false",
          maxResults: "10",
          singleEvents: "false",
        },
      },
    );
    return (body.items ?? []).map((item) => mapGoogleEvent(item, true));
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const writable = await this.#writable(calendarId);
    const body = await this.#json<GoogleEvent>(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    return mapGoogleEvent(body, writable);
  }

  async createEvent(calendarId: string, body: Record<string, unknown>): Promise<CalendarEvent> {
    const created = await this.#json<GoogleEvent>(
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return mapGoogleEvent(created, true);
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
    etag?: string,
  ): Promise<CalendarEvent> {
    const updated = await this.#json<GoogleEvent>(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
        // If-Match turns a concurrent remote edit into a 412 instead of an overwrite.
        headers: etag ? { "if-match": etag } : undefined,
      },
    );
    return mapGoogleEvent(updated, true);
  }

  async deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void> {
    const res = await this.#request(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE", headers: etag ? { "if-match": etag } : undefined },
    );
    // Deleting an already-deleted event is success from the user's point of view.
    if (res.ok || res.status === 404 || res.status === 410) return;
    const text = await res.text();
    throw toApiError(res.status, text ? JSON.parse(text) : null);
  }
}

function toApiError(status: number, body: unknown): CalendarApiError {
  const err = (body as { error?: { message?: string; errors?: Array<{ reason?: string }> } })?.error;
  const reason = err?.errors?.[0]?.reason;
  const message = err?.message ?? `Google Calendar request failed with HTTP ${status}`;
  return new CalendarApiError(message, status, reason);
}

/** Turns an API error into a sentence a user can act on. */
export function explainApiError(err: unknown): string {
  if (err instanceof CalendarApiError) {
    if (err.status === 401) return "Google rejected the stored credentials. Run `cal auth` to reconnect.";
    if (err.isPermission) {
      return `Google denied the request: ${err.message}. You may not have write access to this calendar.`;
    }
    if (err.status === 403) return `Google is rate limiting requests: ${err.message}. Try again shortly.`;
    if (err.isNotFound) return `The event or calendar no longer exists: ${err.message}`;
    if (err.isConflict) return "This event changed in Google Calendar since it was loaded.";
    if (err.status >= 500) return `Google Calendar is having trouble (HTTP ${err.status}). Try again shortly.`;
    return err.message;
  }
  if (err instanceof UserFacingError) return err.message;
  return (err as Error)?.message ?? String(err);
}

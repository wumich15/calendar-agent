/**
 * The view model: turning loaded events plus unsaved drafts into the ordered,
 * annotated list the renderer and the key handlers both work from.
 */

import type { CalendarEvent } from "../types.ts";
import type { DraftStore } from "./draft.ts";
import {
  addPlainDays,
  startOfDayInstant,
  toPlainDate,
  toPlainTime,
} from "../util/datetime.ts";

export type EventState = "clean" | "edited" | "deleted";

export type DisplayEvent = {
  id: string;
  /** The event as Google returned it. */
  base: CalendarEvent;
  /** The event with any staged edit applied, which is what the user sees. */
  shown: CalendarEvent;
  state: EventState;
  readOnly: boolean;
  recurring: boolean;
  /** True when this event's times intersect another timed event on the same day. */
  overlapping: boolean;
  startMs: number;
  endMs: number;
  /** Day this event is listed under, as YYYY-MM-DD in the display zone. */
  dayKey: string;
};

export type ViewMode = "day" | "week";

/** Inclusive-start, exclusive-end day range currently on screen. */
export function visibleRange(
  view: ViewMode,
  anchorDate: string,
  weekStartsOn: number,
): { startDate: string; endDate: string; days: string[] } {
  if (view === "day") {
    return { startDate: anchorDate, endDate: addPlainDays(anchorDate, 1), days: [anchorDate] };
  }
  const diff = (weekdayOf(anchorDate) - weekStartsOn + 7) % 7;
  const startDate = addPlainDays(anchorDate, -diff);
  const days = Array.from({ length: 7 }, (_, i) => addPlainDays(startDate, i));
  return { startDate, endDate: addPlainDays(startDate, 7), days };
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

function instantOf(event: CalendarEvent, which: "start" | "end", timeZone: string): number {
  const time = event[which];
  if (time.date) return startOfDayInstant(time.date, timeZone).getTime();
  return new Date(time.dateTime ?? "").getTime();
}

/**
 * Builds the list shown in the body, in the order `j` and `k` walk: grouped by
 * day, all-day events first within a day, then timed events by start.
 */
export function buildDisplayEvents(options: {
  events: CalendarEvent[];
  drafts: DraftStore;
  timeZone: string;
  days: string[];
  calendarWritable: boolean;
}): DisplayEvent[] {
  const { events, drafts, timeZone, days, calendarWritable } = options;
  const dayIndex = new Map(days.map((day, index) => [day, index]));

  const items: DisplayEvent[] = [];
  for (const base of events) {
    if (base.status === "cancelled") continue;
    const change = drafts.get(base.id);
    const shown = drafts.preview(base);
    const startMs = instantOf(shown, "start", timeZone);
    const endMs = instantOf(shown, "end", timeZone);

    // An event is listed under its start day, or under the first visible day
    // when it began before the window (a multi-day or overnight event).
    const startDay = shown.allDay
      ? (shown.start.date ?? days[0]!)
      : toPlainDate(new Date(startMs), timeZone);
    const dayKey = dayIndex.has(startDay) ? startDay : days[0]!;
    if (!dayIndex.has(startDay) && endMs <= startOfDayInstant(days[0]!, timeZone).getTime()) {
      continue;
    }

    items.push({
      id: base.id,
      base,
      shown,
      state: change?.kind === "delete" ? "deleted" : change?.kind === "edit" ? "edited" : "clean",
      readOnly: !calendarWritable || !base.writable,
      recurring: Boolean(base.recurringEventId || base.recurrence?.length),
      overlapping: false,
      startMs,
      endMs,
      dayKey,
    });
  }

  items.sort((a, b) => {
    const dayDiff = (dayIndex.get(a.dayKey) ?? 0) - (dayIndex.get(b.dayKey) ?? 0);
    if (dayDiff !== 0) return dayDiff;
    if (a.shown.allDay !== b.shown.allDay) return a.shown.allDay ? -1 : 1;
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return a.shown.summary.localeCompare(b.shown.summary);
  });

  markOverlaps(items);
  return items;
}

/** Flags timed events that share a day and intersect in time. */
function markOverlaps(items: DisplayEvent[]): void {
  const timed = items.filter((item) => !item.shown.allDay && item.state !== "deleted");
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      const a = timed[i]!;
      const b = timed[j]!;
      if (b.startMs >= a.endMs) break; // Sorted by start: nothing later can overlap `a`.
      if (a.startMs < b.endMs && b.startMs < a.endMs) {
        a.overlapping = true;
        b.overlapping = true;
      }
    }
  }
}

/** `08:00-09:30`, or `all day`, in the display zone. */
export function formatEventTimes(event: CalendarEvent, timeZone: string): string {
  if (event.allDay) return "all day";
  const start = new Date(event.start.dateTime ?? "");
  const end = new Date(event.end.dateTime ?? "");
  if (Number.isNaN(start.getTime())) return "??:??";
  const startText = toPlainTime(start, timeZone);
  if (Number.isNaN(end.getTime())) return startText;
  const endText = toPlainTime(end, timeZone);
  // Mark an end that lands on a later day so an overnight event reads correctly.
  const crossesDay = toPlainDate(start, timeZone) !== toPlainDate(end, timeZone);
  return `${startText}-${endText}${crossesDay ? "+" : ""}`;
}

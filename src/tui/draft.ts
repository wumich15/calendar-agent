/**
 * Local, unsaved changes.
 *
 * Every edit and every `dd` lands here and nowhere else; nothing reaches Google
 * Calendar until the user runs `:w` or `:wq`. Each mutation pushes its previous
 * state onto an undo stack so `u` can walk back through them.
 */

import type { CalendarEvent, EventTime } from "../types.ts";
import {
  addPlainDays,
  isPlainDate,
  isValidTimeZone,
  parseClockTime,
  plainDateToParts,
  toPlainDate,
  toPlainTime,
  toRfc3339,
  zonedTimeToInstant,
} from "../util/datetime.ts";

/** The fields the edit form exposes, all as strings so they can be typed into. */
export type EditableFields = {
  summary: string;
  location: string;
  description: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timeZone: string;
  allDay: boolean;
};

/** Whether a change applies to one occurrence or the whole recurring series. */
export type ChangeScope = "occurrence" | "series";

export type PendingChange =
  | { kind: "edit"; eventId: string; scope: ChangeScope; fields: EditableFields }
  | { kind: "delete"; eventId: string; scope: ChangeScope };

type UndoEntry = { eventId: string; previous: PendingChange | undefined; label: string };

export const FIELD_ORDER = [
  "summary",
  "startDate",
  "startTime",
  "endDate",
  "endTime",
  "timeZone",
  "allDay",
  "location",
  "description",
] as const;

export type FieldName = (typeof FIELD_ORDER)[number];

export const FIELD_LABELS: Record<FieldName, string> = {
  summary: "Name",
  startDate: "Start date",
  startTime: "Start time",
  endDate: "End date",
  endTime: "End time",
  timeZone: "Time zone",
  allDay: "All day",
  location: "Location",
  description: "Description",
};

/** Reads an event into editable strings, in the given display zone. */
export function fieldsFromEvent(event: CalendarEvent, displayTimeZone: string): EditableFields {
  if (event.allDay) {
    const startDate = event.start.date ?? "";
    // Google stores an exclusive end date; show the last day the event covers.
    const endDate = event.end.date ? addPlainDays(event.end.date, -1) : startDate;
    return {
      summary: event.summary,
      location: event.location ?? "",
      description: event.description ?? "",
      startDate,
      startTime: "",
      endDate: endDate < startDate ? startDate : endDate,
      endTime: "",
      timeZone: event.start.timeZone ?? displayTimeZone,
      allDay: true,
    };
  }
  const zone = event.start.timeZone ?? displayTimeZone;
  const startInstant = new Date(event.start.dateTime ?? "");
  const endInstant = new Date(event.end.dateTime ?? event.start.dateTime ?? "");
  return {
    summary: event.summary,
    location: event.location ?? "",
    description: event.description ?? "",
    startDate: toPlainDate(startInstant, zone),
    startTime: toPlainTime(startInstant, zone),
    endDate: toPlainDate(endInstant, zone),
    endTime: toPlainTime(endInstant, zone),
    timeZone: zone,
    allDay: false,
  };
}

export type ValidationIssue = { field: FieldName; message: string };

/** Checks the form before a save is attempted, so failures happen locally. */
export function validateFields(fields: EditableFields): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!fields.summary.trim()) {
    issues.push({ field: "summary", message: "Name cannot be empty." });
  }
  if (!isPlainDate(fields.startDate)) {
    issues.push({ field: "startDate", message: "Start date must be written as YYYY-MM-DD." });
  }
  if (!isPlainDate(fields.endDate)) {
    issues.push({ field: "endDate", message: "End date must be written as YYYY-MM-DD." });
  }
  if (!isValidTimeZone(fields.timeZone)) {
    issues.push({ field: "timeZone", message: `"${fields.timeZone}" is not a known IANA time zone.` });
  }

  if (fields.allDay) {
    if (issues.some((i) => i.field === "startDate" || i.field === "endDate")) return issues;
    if (fields.endDate < fields.startDate) {
      issues.push({ field: "endDate", message: "End date must not be before the start date." });
    }
    return issues;
  }

  const start = parseClockTime(fields.startTime);
  const end = parseClockTime(fields.endTime);
  if (!start) issues.push({ field: "startTime", message: "Start time must be written as HH:MM." });
  if (!end) issues.push({ field: "endTime", message: "End time must be written as HH:MM." });
  if (issues.length) return issues;

  const startKey = `${fields.startDate}T${fields.startTime}`;
  const endKey = `${fields.endDate}T${fields.endTime}`;
  if (endKey <= startKey) {
    issues.push({ field: "endTime", message: "End must be after the start." });
  }
  return issues;
}

/** Converts validated fields into Google's start/end shape. */
export function fieldsToTimes(fields: EditableFields): { start: EventTime; end: EventTime } {
  if (fields.allDay) {
    return {
      start: { date: fields.startDate },
      // Google's all-day end is exclusive, so the stored value is one day past.
      end: { date: addPlainDays(fields.endDate, 1) },
    };
  }
  const startClock = parseClockTime(fields.startTime)!;
  const endClock = parseClockTime(fields.endTime)!;
  const startParts = { ...plainDateToParts(fields.startDate), ...startClock, second: 0 };
  const endParts = { ...plainDateToParts(fields.endDate), ...endClock, second: 0 };
  return {
    start: {
      dateTime: toRfc3339(zonedTimeToInstant(startParts, fields.timeZone), fields.timeZone),
      timeZone: fields.timeZone,
    },
    end: {
      dateTime: toRfc3339(zonedTimeToInstant(endParts, fields.timeZone), fields.timeZone),
      timeZone: fields.timeZone,
    },
  };
}

function sameTime(a: EventTime, b: EventTime): boolean {
  if (a.date || b.date) return a.date === b.date;
  return (
    new Date(a.dateTime ?? "").getTime() === new Date(b.dateTime ?? "").getTime() &&
    a.timeZone === b.timeZone
  );
}

/**
 * A PATCH body containing only what the user actually changed, so fields the
 * form never touched are left exactly as Google has them.
 */
export function buildPatchBody(
  base: CalendarEvent,
  fields: EditableFields,
  displayTimeZone: string,
): Record<string, unknown> {
  const original = fieldsFromEvent(base, displayTimeZone);
  const patch: Record<string, unknown> = {};

  if (fields.summary.trim() !== original.summary) patch.summary = fields.summary.trim();
  if (fields.location !== original.location) patch.location = fields.location;
  if (fields.description !== original.description) patch.description = fields.description;

  const times = fieldsToTimes(fields);
  if (fields.allDay !== base.allDay || !sameTime(times.start, base.start)) {
    patch.start = fields.allDay
      ? { date: times.start.date }
      : { dateTime: times.start.dateTime, timeZone: times.start.timeZone };
  }
  if (fields.allDay !== base.allDay || !sameTime(times.end, base.end)) {
    patch.end = fields.allDay
      ? { date: times.end.date }
      : { dateTime: times.end.dateTime, timeZone: times.end.timeZone };
  }
  return patch;
}

/** True when the form differs from the event as loaded. */
export function fieldsDiffer(
  base: CalendarEvent,
  fields: EditableFields,
  displayTimeZone: string,
): boolean {
  return Object.keys(buildPatchBody(base, fields, displayTimeZone)).length > 0;
}

/** The set of unsaved changes, keyed by event id. */
export class DraftStore {
  #changes = new Map<string, PendingChange>();
  #undo: UndoEntry[] = [];

  get size(): number {
    return this.#changes.size;
  }

  get hasChanges(): boolean {
    return this.#changes.size > 0;
  }

  get(eventId: string): PendingChange | undefined {
    return this.#changes.get(eventId);
  }

  all(): PendingChange[] {
    return [...this.#changes.values()];
  }

  isDeleted(eventId: string): boolean {
    return this.#changes.get(eventId)?.kind === "delete";
  }

  isEdited(eventId: string): boolean {
    return this.#changes.get(eventId)?.kind === "edit";
  }

  /** Records a change, remembering what it replaced so `u` can restore it. */
  #set(change: PendingChange, label: string): void {
    this.#undo.push({
      eventId: change.eventId,
      previous: this.#changes.get(change.eventId),
      label,
    });
    this.#changes.set(change.eventId, change);
  }

  stageEdit(eventId: string, fields: EditableFields, scope: ChangeScope, label: string): void {
    this.#set({ kind: "edit", eventId, scope, fields }, label);
  }

  stageDelete(eventId: string, scope: ChangeScope, label: string): void {
    this.#set({ kind: "delete", eventId, scope }, label);
  }

  /** Reverts the most recent staged change. Returns a label for the status line. */
  undo(): string | null {
    const entry = this.#undo.pop();
    if (!entry) return null;
    if (entry.previous) this.#changes.set(entry.eventId, entry.previous);
    else this.#changes.delete(entry.eventId);
    return entry.label;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  /** Drops a change that has been saved successfully. */
  resolve(eventId: string): void {
    this.#changes.delete(eventId);
    this.#undo = this.#undo.filter((entry) => entry.eventId !== eventId);
  }

  clear(): void {
    this.#changes.clear();
    this.#undo = [];
  }

  /** Applies a staged edit on top of an event, for display purposes. */
  preview(event: CalendarEvent): CalendarEvent {
    const change = this.#changes.get(event.id);
    if (change?.kind !== "edit") return event;
    const times = fieldsToTimes(change.fields);
    return {
      ...event,
      summary: change.fields.summary,
      location: change.fields.location || undefined,
      description: change.fields.description || undefined,
      start: times.start,
      end: times.end,
      allDay: change.fields.allDay,
    };
  }
}

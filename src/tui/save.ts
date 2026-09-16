/**
 * Writing staged changes back to Google Calendar.
 *
 * Each pending change is applied on its own. A change that succeeds is dropped
 * from the draft store immediately, so a later failure in the same save never
 * causes an already-applied operation to be repeated on retry.
 */

import type { CalendarClient } from "../calendar/client.ts";
import { CalendarApiError, explainApiError } from "../calendar/client.ts";
import type { CalendarEvent } from "../types.ts";
import { buildPatchBody, type DraftStore, type PendingChange } from "./draft.ts";

export type SaveEntry = {
  eventId: string;
  kind: "edit" | "delete";
  name: string;
  scope: "occurrence" | "series";
};

export type SaveFailure = SaveEntry & {
  error: string;
  /** True when the remote copy changed since it was loaded. */
  conflict: boolean;
};

export type SaveOutcome = {
  succeeded: SaveEntry[];
  failed: SaveFailure[];
  /** Ids removed from the calendar, so the caller can drop them from the list. */
  deletedIds: string[];
  /** Events as they came back from Google, to refresh the local copies. */
  updated: CalendarEvent[];
  /** Changes with nothing left to send, e.g. an edit that was undone to a no-op. */
  noops: SaveEntry[];
};

export type SaveOptions = {
  client: CalendarClient;
  calendarId: string;
  timeZone: string;
  drafts: DraftStore;
  /** The events as loaded, keyed by id. */
  baseEvents: Map<string, CalendarEvent>;
  onProgress?: (done: number, total: number, name: string) => void;
};

/**
 * Resolves which Google event a change targets. A series-scoped change is
 * applied to the recurring master; an occurrence-scoped change to the single
 * instance Google returned.
 */
async function resolveTarget(
  change: PendingChange,
  base: CalendarEvent,
  options: SaveOptions,
): Promise<CalendarEvent> {
  if (change.scope !== "series" || !base.recurringEventId) return base;
  // The master carries its own etag, which is what If-Match needs.
  return options.client.getEvent(options.calendarId, base.recurringEventId);
}

export async function savePending(options: SaveOptions): Promise<SaveOutcome> {
  const outcome: SaveOutcome = {
    succeeded: [],
    failed: [],
    deletedIds: [],
    updated: [],
    noops: [],
  };

  const changes = options.drafts.all();
  for (const [index, change] of changes.entries()) {
    const base = options.baseEvents.get(change.eventId);
    const name =
      change.kind === "edit" ? change.fields.summary : (base?.summary ?? change.eventId);
    const entry: SaveEntry = {
      eventId: change.eventId,
      kind: change.kind,
      name,
      scope: change.scope,
    };
    options.onProgress?.(index + 1, changes.length, name);

    if (!base) {
      outcome.failed.push({
        ...entry,
        error: "This event is no longer loaded. Run :refresh and stage the change again.",
        conflict: true,
      });
      continue;
    }

    try {
      const target = await resolveTarget(change, base, options);

      if (change.kind === "delete") {
        await options.client.deleteEvent(options.calendarId, target.id, target.etag);
        options.drafts.resolve(change.eventId);
        outcome.succeeded.push(entry);
        outcome.deletedIds.push(change.eventId);
        continue;
      }

      const patch = buildPatchBody(base, change.fields, options.timeZone);
      if (!Object.keys(patch).length) {
        options.drafts.resolve(change.eventId);
        outcome.noops.push(entry);
        continue;
      }
      const updated = await options.client.patchEvent(
        options.calendarId,
        target.id,
        patch,
        target.etag,
      );
      options.drafts.resolve(change.eventId);
      outcome.succeeded.push(entry);
      outcome.updated.push(change.scope === "series" ? { ...updated, id: updated.id } : updated);
    } catch (err) {
      const conflict = err instanceof CalendarApiError && err.isConflict;
      outcome.failed.push({
        ...entry,
        error: conflict
          ? "Changed in Google Calendar since it was loaded. Run :refresh, then redo this change."
          : explainApiError(err),
        conflict,
      });
    }
  }

  return outcome;
}

/** Lines summarizing a save, for the status area or the report overlay. */
export function describeSave(outcome: SaveOutcome): string[] {
  const lines: string[] = [];
  for (const entry of outcome.succeeded) {
    const verb = entry.kind === "delete" ? "deleted" : "updated";
    const scope = entry.scope === "series" ? " (whole series)" : "";
    lines.push(`ok    ${verb}${scope}: ${entry.name}`);
  }
  for (const entry of outcome.noops) {
    lines.push(`skip  no change left to save: ${entry.name}`);
  }
  for (const entry of outcome.failed) {
    const verb = entry.kind === "delete" ? "delete" : "update";
    lines.push(`FAIL  ${verb}: ${entry.name}`);
    lines.push(`        ${entry.error}`);
  }
  if (outcome.failed.length) {
    lines.push("");
    lines.push("Failed changes are still staged. Fix the problem and run :w again.");
  }
  return lines;
}

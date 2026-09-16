import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DraftStore, fieldsFromEvent } from "../src/tui/draft.ts";
import { describeSave, savePending } from "../src/tui/save.ts";
import type { CalendarEvent } from "../src/types.ts";
import { FakeCalendarClient, makeEvent } from "./helpers/fake-client.ts";

const TZ = "America/New_York";

function seed(): CalendarEvent[] {
  return [
    makeEvent({
      id: "a",
      summary: "Standup",
      start: { dateTime: "2026-09-15T09:00:00-04:00", timeZone: TZ },
      end: { dateTime: "2026-09-15T09:30:00-04:00", timeZone: TZ },
    }),
    makeEvent({
      id: "b",
      summary: "Design review",
      start: { dateTime: "2026-09-15T11:00:00-04:00", timeZone: TZ },
      end: { dateTime: "2026-09-15T12:00:00-04:00", timeZone: TZ },
    }),
    makeEvent({
      id: "c",
      summary: "Weekly sync",
      recurringEventId: "series-1",
      start: { dateTime: "2026-09-15T14:00:00-04:00", timeZone: TZ },
      end: { dateTime: "2026-09-15T15:00:00-04:00", timeZone: TZ },
    }),
    makeEvent({ id: "series-1", summary: "Weekly sync", recurrence: ["RRULE:FREQ=WEEKLY"] }),
  ];
}

function setup() {
  const events = seed();
  const client = new FakeCalendarClient(events);
  const drafts = new DraftStore();
  const baseEvents = new Map(events.map((event) => [event.id, event]));
  return { client, drafts, baseEvents };
}

function run(ctx: ReturnType<typeof setup>) {
  return savePending({
    client: ctx.client,
    calendarId: "primary",
    timeZone: TZ,
    drafts: ctx.drafts,
    baseEvents: ctx.baseEvents,
  });
}

describe("savePending", () => {
  it("applies an edit and a deletion, then clears them from the draft store", async () => {
    const ctx = setup();
    const fields = { ...fieldsFromEvent(ctx.baseEvents.get("a")!, TZ), summary: "Standup (moved)" };
    ctx.drafts.stageEdit("a", fields, "occurrence", "edit Standup");
    ctx.drafts.stageDelete("b", "occurrence", "delete Design review");

    const outcome = await run(ctx);

    assert.equal(outcome.succeeded.length, 2);
    assert.equal(outcome.failed.length, 0);
    assert.deepEqual(outcome.deletedIds, ["b"]);
    assert.equal(ctx.drafts.hasChanges, false);
    assert.equal(ctx.client.events.get("a")!.summary, "Standup (moved)");
    assert.equal(ctx.client.events.has("b"), false);
  });

  it("sends nothing at all until a save is run", async () => {
    const ctx = setup();
    ctx.drafts.stageDelete("b", "occurrence", "delete Design review");
    assert.equal(ctx.client.calls.length, 0);
    assert.equal(ctx.client.events.has("b"), true);

    await run(ctx);
    assert.equal(ctx.client.events.has("b"), false);
  });

  it("targets the series master when the change was staged for the whole series", async () => {
    const ctx = setup();
    ctx.drafts.stageDelete("c", "series", "delete Weekly sync series");
    await run(ctx);
    assert.equal(ctx.client.events.has("series-1"), false);
    assert.equal(ctx.client.events.has("c"), true, "the occurrence itself was not deleted directly");
  });

  it("targets only the occurrence by default", async () => {
    const ctx = setup();
    ctx.drafts.stageDelete("c", "occurrence", "delete Weekly sync");
    await run(ctx);
    assert.equal(ctx.client.events.has("c"), false);
    assert.equal(ctx.client.events.has("series-1"), true);
  });

  it("keeps a failed change staged while dropping the ones that succeeded", async () => {
    const ctx = setup();
    const fields = { ...fieldsFromEvent(ctx.baseEvents.get("a")!, TZ), summary: "Renamed" };
    ctx.drafts.stageEdit("a", fields, "occurrence", "edit Standup");
    ctx.drafts.stageDelete("b", "occurrence", "delete Design review");
    ctx.client.failures = [{ op: "delete", eventId: "b", status: 500 }];

    const outcome = await run(ctx);

    assert.deepEqual(outcome.succeeded.map((e) => e.eventId), ["a"]);
    assert.deepEqual(outcome.failed.map((e) => e.eventId), ["b"]);
    assert.equal(ctx.drafts.size, 1, "only the failed change is still staged");
    assert.equal(ctx.drafts.get("b")!.kind, "delete");
  });

  it("does not repeat a successful operation when the save is retried", async () => {
    const ctx = setup();
    const fields = { ...fieldsFromEvent(ctx.baseEvents.get("a")!, TZ), summary: "Renamed" };
    ctx.drafts.stageEdit("a", fields, "occurrence", "edit Standup");
    ctx.drafts.stageDelete("b", "occurrence", "delete Design review");
    ctx.client.failures = [{ op: "delete", eventId: "b", status: 500, once: true }];

    await run(ctx);
    const callsAfterFirst = [...ctx.client.calls];
    assert.equal(callsAfterFirst.filter((c) => c === "patch:a").length, 1);

    const second = await run(ctx);
    assert.equal(second.succeeded.length, 1);
    assert.equal(
      ctx.client.calls.filter((c) => c === "patch:a").length,
      1,
      "the already-saved edit was not sent again",
    );
    assert.equal(ctx.drafts.hasChanges, false);
  });

  it("reports a remote change as a conflict instead of overwriting it", async () => {
    const ctx = setup();
    const fields = { ...fieldsFromEvent(ctx.baseEvents.get("a")!, TZ), summary: "Mine" };
    ctx.drafts.stageEdit("a", fields, "occurrence", "edit Standup");

    // Someone else edits the event in Google Calendar, changing its etag.
    ctx.client.events.set("a", {
      ...ctx.client.events.get("a")!,
      summary: "Theirs",
      etag: '"etag-changed"',
    });

    const outcome = await run(ctx);
    assert.equal(outcome.failed.length, 1);
    assert.equal(outcome.failed[0]!.conflict, true);
    assert.match(outcome.failed[0]!.error, /changed in Google Calendar/i);
    assert.equal(ctx.client.events.get("a")!.summary, "Theirs", "the remote copy was not overwritten");
    assert.equal(ctx.drafts.size, 1, "the local draft survives for the user to resolve");
  });

  it("flags a staged change whose event is no longer loaded", async () => {
    const ctx = setup();
    ctx.drafts.stageDelete("gone", "occurrence", "delete missing");
    const outcome = await run(ctx);
    assert.equal(outcome.failed.length, 1);
    assert.match(outcome.failed[0]!.error, /no longer loaded/);
  });

  it("treats an edit with nothing left to change as a no-op rather than a write", async () => {
    const ctx = setup();
    ctx.drafts.stageEdit(
      "a",
      fieldsFromEvent(ctx.baseEvents.get("a")!, TZ),
      "occurrence",
      "edit Standup",
    );
    const outcome = await run(ctx);
    assert.equal(outcome.noops.length, 1);
    assert.equal(outcome.succeeded.length, 0);
    assert.equal(ctx.client.calls.some((c) => c.startsWith("patch")), false);
  });

  it("treats an already-deleted event as successfully deleted", async () => {
    const ctx = setup();
    ctx.drafts.stageDelete("b", "occurrence", "delete Design review");
    ctx.client.events.delete("b");
    const outcome = await run(ctx);
    assert.equal(outcome.succeeded.length, 1);
    assert.equal(outcome.failed.length, 0);
  });
});

describe("describeSave", () => {
  it("lists what succeeded, what failed, and what to do next", async () => {
    const ctx = setup();
    const fields = { ...fieldsFromEvent(ctx.baseEvents.get("a")!, TZ), summary: "Renamed" };
    ctx.drafts.stageEdit("a", fields, "occurrence", "edit Standup");
    ctx.drafts.stageDelete("b", "occurrence", "delete Design review");
    ctx.client.failures = [{ op: "delete", eventId: "b", status: 403, message: "Forbidden" }];

    const text = describeSave(await run(ctx)).join("\n");
    assert.match(text, /ok {4}updated: Renamed/);
    assert.match(text, /FAIL {2}delete: Design review/);
    assert.match(text, /Failed changes are still staged/);
  });

  it("says when a change applied to a whole series", async () => {
    const ctx = setup();
    ctx.drafts.stageDelete("c", "series", "delete Weekly sync series");
    const text = describeSave(await run(ctx)).join("\n");
    assert.match(text, /deleted \(whole series\): Weekly sync/);
  });
});

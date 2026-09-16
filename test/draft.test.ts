import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DraftStore,
  buildPatchBody,
  fieldsDiffer,
  fieldsFromEvent,
  fieldsToTimes,
  validateFields,
  type EditableFields,
} from "../src/tui/draft.ts";
import { makeEvent } from "./helpers/fake-client.ts";

const TZ = "America/New_York";

const timed = makeEvent({
  id: "e1",
  summary: "Standup",
  location: "Zoom",
  description: "Daily sync",
  start: { dateTime: "2026-09-15T09:00:00-04:00", timeZone: TZ },
  end: { dateTime: "2026-09-15T09:30:00-04:00", timeZone: TZ },
});

const allDay = makeEvent({
  id: "e2",
  summary: "Company Offsite",
  allDay: true,
  start: { date: "2026-09-15" },
  end: { date: "2026-09-18" },
});

describe("fieldsFromEvent", () => {
  it("splits a timed event into date and time fields in the display zone", () => {
    assert.deepEqual(fieldsFromEvent(timed, TZ), {
      summary: "Standup",
      location: "Zoom",
      description: "Daily sync",
      startDate: "2026-09-15",
      startTime: "09:00",
      endDate: "2026-09-15",
      endTime: "09:30",
      timeZone: TZ,
      allDay: false,
    });
  });

  it("shows an all-day event's end as the last day it covers, not Google's exclusive one", () => {
    const fields = fieldsFromEvent(allDay, TZ);
    assert.equal(fields.allDay, true);
    assert.equal(fields.startDate, "2026-09-15");
    assert.equal(fields.endDate, "2026-09-17");
  });

  it("round-trips an all-day event back to the exclusive end Google expects", () => {
    const times = fieldsToTimes(fieldsFromEvent(allDay, TZ));
    assert.deepEqual(times.start, { date: "2026-09-15" });
    assert.deepEqual(times.end, { date: "2026-09-18" });
  });
});

describe("validateFields", () => {
  const base = fieldsFromEvent(timed, TZ);
  const withFields = (patch: Partial<EditableFields>): EditableFields => ({ ...base, ...patch });

  it("accepts a valid form", () => {
    assert.deepEqual(validateFields(base), []);
  });

  it("rejects an empty name", () => {
    const issues = validateFields(withFields({ summary: "   " }));
    assert.deepEqual(issues.map((i) => i.field), ["summary"]);
    assert.match(issues[0]!.message, /Name cannot be empty/);
  });

  it("rejects an end that is not after the start", () => {
    const issues = validateFields(withFields({ endTime: "09:00" }));
    assert.deepEqual(issues.map((i) => i.field), ["endTime"]);
    assert.match(issues[0]!.message, /End must be after the start/);
  });

  it("accepts an end on a later day", () => {
    assert.deepEqual(validateFields(withFields({ endDate: "2026-09-16", endTime: "01:00" })), []);
  });

  it("rejects malformed dates and times, naming each field", () => {
    const issues = validateFields(withFields({ startDate: "15/09/2026", endTime: "5pm" }));
    assert.deepEqual(issues.map((i) => i.field).sort(), ["endTime", "startDate"]);
  });

  it("rejects an unknown time zone", () => {
    const issues = validateFields(withFields({ timeZone: "Mars/Olympus" }));
    assert.deepEqual(issues.map((i) => i.field), ["timeZone"]);
  });

  it("ignores time fields for an all-day event but still orders the dates", () => {
    const fields = fieldsFromEvent(allDay, TZ);
    assert.deepEqual(validateFields({ ...fields, startTime: "", endTime: "" }), []);
    const issues = validateFields({ ...fields, endDate: "2026-09-14" });
    assert.deepEqual(issues.map((i) => i.field), ["endDate"]);
  });
});

describe("buildPatchBody", () => {
  it("sends only the fields the user actually changed", () => {
    const fields = { ...fieldsFromEvent(timed, TZ), summary: "Standup (moved)" };
    assert.deepEqual(buildPatchBody(timed, fields, TZ), { summary: "Standup (moved)" });
  });

  it("leaves untouched fields out entirely, so Google keeps them", () => {
    const fields = { ...fieldsFromEvent(timed, TZ), startTime: "10:00", endTime: "10:30" };
    const patch = buildPatchBody(timed, fields, TZ);
    assert.deepEqual(Object.keys(patch).sort(), ["end", "start"]);
    assert.equal("description" in patch, false);
    assert.equal("location" in patch, false);
    assert.deepEqual(patch.start, { dateTime: "2026-09-15T10:00:00-04:00", timeZone: TZ });
  });

  it("is empty when nothing changed", () => {
    assert.deepEqual(buildPatchBody(timed, fieldsFromEvent(timed, TZ), TZ), {});
    assert.equal(fieldsDiffer(timed, fieldsFromEvent(timed, TZ), TZ), false);
  });

  it("switches a timed event to all-day by sending dates instead of dateTimes", () => {
    const fields = { ...fieldsFromEvent(timed, TZ), allDay: true };
    const patch = buildPatchBody(timed, fields, TZ);
    assert.deepEqual(patch.start, { date: "2026-09-15" });
    assert.deepEqual(patch.end, { date: "2026-09-16" });
  });
});

describe("DraftStore", () => {
  it("starts empty", () => {
    const drafts = new DraftStore();
    assert.equal(drafts.hasChanges, false);
    assert.equal(drafts.canUndo, false);
    assert.equal(drafts.undo(), null);
  });

  it("stages a deletion without touching the event itself", () => {
    const drafts = new DraftStore();
    drafts.stageDelete("e1", "occurrence", "delete Standup");
    assert.equal(drafts.isDeleted("e1"), true);
    assert.equal(drafts.size, 1);
    assert.equal(drafts.preview(timed).summary, "Standup");
  });

  it("shows a staged edit in the preview while leaving the base event alone", () => {
    const drafts = new DraftStore();
    const fields = { ...fieldsFromEvent(timed, TZ), summary: "Renamed", location: "Room 2" };
    drafts.stageEdit("e1", fields, "occurrence", "edit Standup");

    const preview = drafts.preview(timed);
    assert.equal(preview.summary, "Renamed");
    assert.equal(preview.location, "Room 2");
    assert.equal(timed.summary, "Standup");
  });

  it("undoes the most recent change first", () => {
    const drafts = new DraftStore();
    drafts.stageEdit("e1", fieldsFromEvent(timed, TZ), "occurrence", "edit Standup");
    drafts.stageDelete("e2", "occurrence", "delete Company Offsite");
    assert.equal(drafts.size, 2);

    assert.equal(drafts.undo(), "delete Company Offsite");
    assert.equal(drafts.size, 1);
    assert.equal(drafts.isEdited("e1"), true);

    assert.equal(drafts.undo(), "edit Standup");
    assert.equal(drafts.hasChanges, false);
  });

  it("restores the previous change when one event is changed twice", () => {
    const drafts = new DraftStore();
    const first = { ...fieldsFromEvent(timed, TZ), summary: "First" };
    const second = { ...fieldsFromEvent(timed, TZ), summary: "Second" };
    drafts.stageEdit("e1", first, "occurrence", "edit one");
    drafts.stageEdit("e1", second, "occurrence", "edit two");

    assert.equal(drafts.preview(timed).summary, "Second");
    drafts.undo();
    assert.equal(drafts.preview(timed).summary, "First");
    drafts.undo();
    assert.equal(drafts.hasChanges, false);
  });

  it("drops a resolved change and its undo history", () => {
    const drafts = new DraftStore();
    drafts.stageDelete("e1", "occurrence", "delete Standup");
    drafts.resolve("e1");
    assert.equal(drafts.hasChanges, false);
    assert.equal(drafts.canUndo, false);
  });

  it("records the scope chosen for a recurring event", () => {
    const drafts = new DraftStore();
    drafts.stageDelete("e1", "series", "delete Standup series");
    assert.equal(drafts.get("e1")!.scope, "series");
  });
});

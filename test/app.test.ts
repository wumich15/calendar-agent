import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { App } from "../src/tui/app.ts";
import type { CalendarEvent } from "../src/types.ts";
import { FakeCalendarClient, makeEvent } from "./helpers/fake-client.ts";
import { TestScreen, flush } from "./helpers/test-screen.ts";

const TZ = "America/New_York";
const ESC = "\u001b";
const NOW = () => new Date("2026-09-15T16:00:00Z"); // 12:00 in New York.

function seedEvents(): CalendarEvent[] {
  return [
    makeEvent({
      id: "offsite",
      summary: "Company Offsite",
      allDay: true,
      start: { date: "2026-09-15" },
      end: { date: "2026-09-16" },
    }),
    makeEvent({
      id: "standup",
      summary: "Standup",
      location: "Zoom",
      start: { dateTime: "2026-09-15T09:00:00-04:00", timeZone: TZ },
      end: { dateTime: "2026-09-15T09:30:00-04:00", timeZone: TZ },
    }),
    makeEvent({
      id: "review",
      summary: "Design review",
      location: "Room 2",
      start: { dateTime: "2026-09-15T11:00:00-04:00", timeZone: TZ },
      end: { dateTime: "2026-09-15T12:00:00-04:00", timeZone: TZ },
    }),
    makeEvent({
      id: "overlap",
      summary: "Vendor call",
      start: { dateTime: "2026-09-15T11:30:00-04:00", timeZone: TZ },
      end: { dateTime: "2026-09-15T12:30:00-04:00", timeZone: TZ },
    }),
    makeEvent({
      id: "tomorrow",
      summary: "Retro",
      start: { dateTime: "2026-09-16T10:00:00-04:00", timeZone: TZ },
      end: { dateTime: "2026-09-16T11:00:00-04:00", timeZone: TZ },
    }),
    makeEvent({
      id: "weekly",
      summary: "Weekly sync",
      recurringEventId: "weekly-series",
      start: { dateTime: "2026-09-17T14:00:00-04:00", timeZone: TZ },
      end: { dateTime: "2026-09-17T15:00:00-04:00", timeZone: TZ },
    }),
    makeEvent({
      id: "weekly-series",
      summary: "Weekly sync",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      start: { dateTime: "2026-09-17T14:00:00-04:00", timeZone: TZ },
      end: { dateTime: "2026-09-17T15:00:00-04:00", timeZone: TZ },
    }),
  ];
}

async function start(
  options: { events?: CalendarEvent[]; writable?: boolean; view?: "day" | "week" } = {},
) {
  const events = options.events ?? seedEvents();
  const client = new FakeCalendarClient(events);
  const screen = new TestScreen();
  const app = new App({
    client,
    calendarId: "primary",
    calendarName: "Test Calendar",
    timeZone: TZ,
    calendarWritable: options.writable ?? true,
    account: "user@example.com",
    initialView: options.view ?? "day",
    screen,
    now: NOW,
  });
  const exit = app.run();
  await flush();
  return { app, client, screen, exit };
}

describe("calman view: loading and layout", () => {
  it("shows the calendar, account, time zone, and date", async () => {
    const { screen } = await start();
    assert.match(screen.text, /calman {2}Test Calendar \(user@example\.com\)/);
    assert.match(screen.text, /America\/New_York/);
    assert.match(screen.text, /Tue, Sep 15 2026/);
    assert.match(screen.text, /\[DAY\]/);
  });

  it("lists the day's events in chronological order, all-day first", async () => {
    const { screen } = await start();
    const body = screen.text;
    const order = ["Company Offsite", "Standup", "Design review", "Vendor call"].map((name) =>
      body.indexOf(name),
    );
    assert.ok(order.every((index) => index >= 0), "every event on the day is shown");
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "shown in order");
    assert.equal(body.includes("Retro"), false, "tomorrow's event is not in the daily view");
  });

  it("shows times and locations, and marks all-day and overlapping events", async () => {
    const { screen } = await start();
    assert.match(screen.text, /all day\s+Company Offsite/);
    assert.match(screen.text, /09:00-09:30\s+Standup\s+@ Zoom/);
    assert.match(screen.text, /Design review.*\(overlap\)/);
    assert.match(screen.text, /Vendor call.*\(overlap\)/);
  });

  it("starts in Normal mode with the first event selected", async () => {
    const { screen } = await start();
    assert.match(screen.text, /NORMAL/);
    assert.match(screen.text, /1 of 4/);
  });

  it("copes with an empty calendar", async () => {
    const { screen } = await start({ events: [] });
    assert.match(screen.text, /no events/);
    assert.match(screen.text, /No events in this range/);
  });

  it("redraws at the new size when the terminal is resized", async () => {
    const { screen } = await start();
    await screen.resizeTo(48, 14);
    const lines = screen.frames.at(-1)!;
    assert.ok(lines.length <= 14, "frame fits the shorter terminal");
    assert.match(screen.text, /Standup/);
  });
});

describe("calman view: Normal mode navigation", () => {
  it("moves the selection with j and k", async () => {
    const { screen } = await start();
    await screen.press("j");
    assert.match(screen.text, /2 of 4/);
    await screen.press("jj");
    assert.match(screen.text, /4 of 4/);
    await screen.press("j");
    assert.match(screen.text, /4 of 4/, "selection stops at the end rather than wrapping");
    await screen.press("k");
    assert.match(screen.text, /3 of 4/);
  });

  it("moves between days with h and l, loading the new range", async () => {
    const { screen, client } = await start();
    const listsBefore = client.calls.filter((c) => c === "list").length;
    await screen.press("l");
    assert.match(screen.text, /Wed, Sep 16 2026/);
    assert.match(screen.text, /Retro/);
    assert.ok(client.calls.filter((c) => c === "list").length > listsBefore, "fetched the new range");

    await screen.press("h");
    assert.match(screen.text, /Tue, Sep 15 2026/);
  });

  it("returns to today with t", async () => {
    const { screen } = await start();
    await screen.press("lll");
    assert.match(screen.text, /Fri, Sep 18 2026/);
    await screen.press("t");
    assert.match(screen.text, /Tue, Sep 15 2026/);
  });

  it("shows event details on Enter and closes them on Escape", async () => {
    const { screen } = await start();
    await screen.press("j\r");
    assert.match(screen.text, /Standup/);
    assert.match(screen.text, /Location:\s+Zoom/);
    assert.match(screen.text, /Press Esc or Enter to close/);
    await screen.press("");
    assert.match(screen.text, /NORMAL/);
    assert.equal(screen.text.includes("Press Esc or Enter to close"), false);
  });

  it("shows the keyboard reference on ?", async () => {
    const { screen } = await start();
    await screen.press("?");
    assert.match(screen.text, /Keyboard reference/);
    assert.match(screen.text, /dd\s+Stage the selected event for deletion/);
    assert.match(screen.text, /:wq\s+Save pending changes and quit/);
  });
});

describe("calman view: daily and weekly views", () => {
  it("switches to weekly view with :week and back with :day", async () => {
    const { screen } = await start();
    await screen.press(":week\r");
    assert.match(screen.text, /\[WEEK\]/);
    assert.match(screen.text, /Sun, Sep 13 2026 {2}-> {2}Sat, Sep 19 2026/);
    assert.match(screen.text, /Retro/, "the whole week's events are shown");

    await screen.press(":day\r");
    assert.match(screen.text, /\[DAY\]/);
    assert.equal(screen.text.includes("Retro"), false);
  });

  it("opens directly in weekly view when asked", async () => {
    const { screen } = await start({ view: "week" });
    assert.match(screen.text, /\[WEEK\]/);
  });

  it("moves a week at a time in weekly view", async () => {
    const { screen } = await start({ view: "week" });
    await screen.press("l");
    assert.match(screen.text, /Sun, Sep 20 2026 {2}-> {2}Sat, Sep 26 2026/);
  });
});

describe("calman view: staging deletions", () => {
  it("stages a deletion with dd without contacting Google", async () => {
    const { screen, client } = await start();
    await screen.press("jdd");
    assert.match(screen.text, /Staged deletion of "Standup"/);
    assert.match(screen.text, /1 unsaved change/);
    assert.match(screen.text, /Standup \[deleted\]/);
    assert.equal(client.calls.some((c) => c.startsWith("delete")), false);
    assert.equal(client.events.has("standup"), true);
  });

  it("does not stage anything for a lone d", async () => {
    const { screen } = await start();
    await screen.press("dj");
    assert.equal(screen.text.includes("unsaved change"), false);
  });

  it("undoes a staged deletion with u", async () => {
    const { screen } = await start();
    await screen.press("jdd");
    await screen.press("u");
    assert.match(screen.text, /Undid: delete Standup/);
    assert.equal(screen.text.includes("unsaved change"), false);
    assert.equal(screen.text.includes("[deleted]"), false);
  });

  it("says there is nothing to undo when nothing is staged", async () => {
    const { screen } = await start();
    await screen.press("u");
    assert.match(screen.text, /Nothing to undo/);
  });

  it("asks whether a recurring deletion is one occurrence or the series", async () => {
    const { screen, client } = await start({ view: "week" });
    // Select the recurring occurrence on Thursday.
    await screen.press(":goto 2026-09-17\r");
    await screen.press(":day\r");
    await screen.press("dd");
    assert.match(screen.text, /Delete a recurring event/);
    assert.match(screen.text, /this occurrence only .*default, Enter/);
    assert.match(screen.text, /the whole series/);
    assert.equal(client.calls.some((c) => c.startsWith("delete")), false);

    await screen.press("s");
    assert.match(screen.text, /Staged deletion of "Weekly sync" \(whole series\)/);
  });

  it("defaults a recurring deletion to the single occurrence on Enter", async () => {
    const { screen } = await start();
    await screen.press(":goto 2026-09-17\r");
    await screen.press("dd\r");
    assert.match(screen.text, /Staged deletion of "Weekly sync"\./);
  });
});

describe("calman view: Insert/Edit mode", () => {
  it("opens the labelled edit form on i", async () => {
    const { screen } = await start();
    await screen.press("ji");
    assert.match(screen.text, /INSERT/);
    assert.match(screen.text, /Editing: Standup/);
    for (const label of ["Name:", "Start date:", "Start time:", "End date:", "End time:", "Time zone:", "All day:", "Location:", "Description:"]) {
      assert.match(screen.text, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("types into the active field instead of running Normal-mode shortcuts", async () => {
    const { screen } = await start();
    await screen.press("ji");
    // Each of these letters is a Normal-mode command; here they must be text.
    await screen.press(" djkt");
    assert.match(screen.text, /Name:\s+Standup djkt/);
    assert.match(screen.text, /INSERT/, "still in Insert mode");
    assert.match(screen.text, /Tue, Sep 15 2026/, "j/k/t did not navigate");
  });

  it("moves between fields with Tab and Shift+Tab", async () => {
    const { screen } = await start();
    await screen.press("ji\t");
    await screen.press("X");
    assert.match(screen.text, /Start date:\s+2026-09-15X/);

    await screen.press("[Z");
    await screen.press("Y");
    assert.match(screen.text, /Name:\s+StandupY/);
  });

  it("deletes characters with backspace", async () => {
    const { screen } = await start();
    await screen.press("ji");
    await screen.press("");
    assert.match(screen.text, /Name:\s+Stan\b/);
  });

  it("keeps the draft and returns to Normal mode on Escape", async () => {
    const { screen, client } = await start();
    await screen.press("ji");
    await screen.press(" (moved)");
    await screen.press("");
    assert.match(screen.text, /NORMAL/);
    assert.match(screen.text, /Staged edit to "Standup \(moved\)"/);
    assert.match(screen.text, /1 unsaved change/);
    assert.equal(client.events.get("standup")!.summary, "Standup", "Google was not touched");
  });

  it("reopens an existing draft rather than starting over", async () => {
    const { screen } = await start();
    await screen.press("ji");
    await screen.press("!");
    await screen.press("");
    await screen.press("i");
    assert.match(screen.text, /Name:\s+Standup!/);
  });

  it("explains invalid fields rather than accepting them silently", async () => {
    const { screen } = await start();
    await screen.press("ji\t\t"); // Move to the start time field.
    await screen.press("25:99");
    assert.match(screen.text, /Start time must be written as HH:MM/);
  });

  it("toggles all-day with Space and hides the time fields", async () => {
    const { screen } = await start();
    await screen.press("ji");
    for (let i = 0; i < 6; i += 1) await screen.press("\t");
    assert.match(screen.text, /All day:\s+\[ \] no/);
    await screen.press(" ");
    assert.match(screen.text, /All day:\s+\[x\] yes/);
    assert.match(screen.text, /Start time:\s+\(not used for all-day events\)/);
  });

  it("undoes a staged edit with u", async () => {
    const { screen } = await start();
    await screen.press("ji");
    await screen.press("!!");
    await screen.press("");
    await screen.press("u");
    assert.match(screen.text, /Undid: edit Standup/);
    assert.equal(screen.text.includes("unsaved change"), false);
  });
});

describe("calman view: saving", () => {
  it("writes staged changes to Google Calendar on :w", async () => {
    const { screen, client } = await start();
    await screen.press("ji");
    await screen.press(" (moved)");
    await screen.press("");
    await screen.press("jdd"); // Also stage a deletion.
    await screen.press(":w\r");

    assert.match(screen.text, /Saved 2 changes to Test Calendar/);
    assert.equal(client.events.get("standup")!.summary, "Standup (moved)");
    assert.equal(client.events.has("review"), false);
    assert.equal(screen.text.includes("unsaved change"), false);
  });

  it("preserves fields the edit did not touch", async () => {
    const { screen, client } = await start();
    await screen.press("ji");
    await screen.press("!");
    await screen.press(":w\r");
    const saved = client.events.get("standup")!;
    assert.equal(saved.summary, "Standup!");
    assert.equal(saved.location, "Zoom", "location survived an edit that did not mention it");
  });

  it("keeps unsaved edits when the view changes", async () => {
    const { screen } = await start();
    await screen.press("ji");
    await screen.press("!");
    await screen.press("");
    await screen.press(":week\r");
    assert.match(screen.text, /1 unsaved change/);
    await screen.press(":day\r");
    assert.match(screen.text, /1 unsaved change/);
    assert.match(screen.text, /Standup!/);
  });

  it("keeps unsaved edits across a :refresh", async () => {
    const { screen } = await start();
    await screen.press("jdd");
    await screen.press(":refresh\r");
    assert.match(screen.text, /Reloaded\. 1 unsaved change kept/);
    assert.match(screen.text, /Standup \[deleted\]/);
  });

  it("refuses to save an invalid draft and says which field is wrong", async () => {
    const { screen, client } = await start();
    await screen.press("ji");
    await screen.press(""); // Empty the name.
    await screen.press("");
    await screen.press(":w\r");
    assert.match(screen.text, /Cannot save yet/);
    assert.match(screen.text, /Name cannot be empty/);
    assert.equal(client.calls.some((c) => c.startsWith("patch")), false);
  });

  it("reports a partial save and keeps only the failed change staged", async () => {
    const { screen, client } = await start();
    await screen.press("ji");
    await screen.press("!");
    await screen.press("");
    await screen.press("jdd");
    client.failures = [{ op: "delete", eventId: "review", status: 500 }];
    await screen.press(":w\r");

    assert.match(screen.text, /Partly saved: 1 succeeded, 1 failed/);
    assert.match(screen.text, /ok {4}updated: Standup!/);
    assert.match(screen.text, /FAIL {2}delete: Design review/);
    assert.match(screen.text, /Failed changes are still staged/);
    assert.equal(client.events.get("standup")!.summary, "Standup!");
    assert.equal(client.events.has("review"), true);
  });

  it("reports a conflicting remote change instead of overwriting it", async () => {
    const { screen, client } = await start();
    await screen.press("ji");
    await screen.press("!");
    await screen.press("");
    client.events.set("standup", {
      ...client.events.get("standup")!,
      summary: "Changed elsewhere",
      etag: '"etag-other"',
    });
    await screen.press(":w\r");
    assert.match(screen.text, /Changed in Google Calendar since it was loaded/);
    assert.equal(client.events.get("standup")!.summary, "Changed elsewhere");
  });

  it("warns on :refresh when a drafted event also changed remotely", async () => {
    const { screen, client } = await start();
    await screen.press("jdd");
    client.events.set("standup", {
      ...client.events.get("standup")!,
      summary: "Changed elsewhere",
      etag: '"etag-other"',
    });
    await screen.press(":refresh\r");
    assert.match(screen.text, /These events also changed in Google Calendar/);
    assert.match(screen.text, /Changed elsewhere/);
    assert.match(screen.text, /kept, not discarded/);
    assert.match(screen.text, /drafts were kept/);
  });
});

describe("calman view: quitting", () => {
  it("quits on :q when there is nothing unsaved", async () => {
    const { screen, exit } = await start();
    await screen.press(":q\r");
    assert.equal(await exit, 0);
  });

  it("warns instead of quitting on :q when changes are unsaved", async () => {
    const { screen, client } = await start();
    await screen.press("jdd");
    await screen.press(":q\r");
    assert.match(screen.text, /1 unsaved change\. Use :w to save, :q! to discard and quit/);
    assert.equal(client.events.has("standup"), true);
  });

  it("discards unsaved changes on :q! without touching Google Calendar", async () => {
    const { screen, client, exit } = await start();
    await screen.press("jdd");
    await screen.press("ji");
    await screen.press("!");
    await screen.press("");
    await screen.press(":q!\r");

    assert.equal(await exit, 0);
    assert.equal(client.events.has("standup"), true);
    assert.equal(client.events.get("review")!.summary, "Design review");
    assert.equal(client.calls.some((c) => c.startsWith("patch") || c.startsWith("delete")), false);
  });

  it("saves and then quits on :wq", async () => {
    const { screen, client, exit } = await start();
    await screen.press("jdd");
    await screen.press(":wq\r");
    assert.equal(await exit, 0);
    assert.equal(client.events.has("standup"), false);
  });

  it("stays open and shows the error when :wq cannot save", async () => {
    const { screen, client } = await start();
    await screen.press("jdd");
    client.failures = [{ op: "delete", eventId: "standup", status: 500 }];
    await screen.press(":wq\r");

    assert.match(screen.text, /Save failed/);
    assert.match(screen.text, /Still open because the save did not fully succeed/);
    assert.equal(client.events.has("standup"), true);
    // Still running: a key still moves the selection.
    await screen.press("k");
    assert.match(screen.text, /NORMAL/);
  });
});

describe("calman view: Command mode", () => {
  it("echoes what is typed and cancels on Escape", async () => {
    const { screen } = await start();
    await screen.press(":wee");
    assert.match(screen.text, /COMMAND/);
    assert.match(screen.text, /:wee/);
    await screen.press("");
    assert.match(screen.text, /NORMAL/);
  });

  it("rejects an unknown command without acting on it", async () => {
    const { screen } = await start();
    await screen.press(":nope\r");
    assert.match(screen.text, /Unknown command ":nope"/);
  });

  it("jumps to a date with :goto and validates the format", async () => {
    const { screen } = await start();
    await screen.press(":goto 2026-12-25\r");
    assert.match(screen.text, /Fri, Dec 25 2026/);
    await screen.press(":goto tomorrow\r");
    assert.match(screen.text, /Usage: :goto YYYY-MM-DD/);
  });

  it("shows the reference on :help", async () => {
    const { screen } = await start();
    await screen.press(":help\r");
    assert.match(screen.text, /Keyboard reference/);
  });
});

describe("calman view: read-only calendars", () => {
  it("says the calendar is read-only and refuses to stage changes", async () => {
    const { screen, client } = await start({ writable: false });
    assert.match(screen.text, /\[read-only\]/);

    await screen.press("jdd");
    assert.match(screen.text, /Test Calendar is read-only for your account/);
    assert.equal(screen.text.includes("unsaved change"), false);

    await screen.press("i");
    assert.match(screen.text, /read-only for your account/);
    assert.equal(screen.text.includes("INSERT"), false);
    assert.equal(client.calls.some((c) => c.startsWith("patch")), false);
  });

  it("still allows reading event details", async () => {
    const { screen } = await start({ writable: false });
    await screen.press("j\r");
    assert.match(screen.text, /Access:\s+read-only/);
  });
});

describe("calman view: error handling", () => {
  it("reports a load failure without losing staged work", async () => {
    const { screen, client } = await start();
    await screen.press("jdd");
    client.failures = [{ op: "list", status: 500 }];
    await screen.press("l");
    assert.match(screen.text, /Could not load events/);
    await screen.press("h");
    assert.match(screen.text, /1 unsaved change/);
  });
});

describe("calman view: scrolling overlays", () => {
  it("scrolls the keyboard reference with j and k", async () => {
    const { screen } = await start();
    await screen.press("?");
    const top = screen.text;
    assert.match(top, /Select the next or previous event/);
    assert.match(top, /more below/);

    await screen.press("jjjjjjjjjj");
    const scrolled = screen.text;
    assert.match(scrolled, /more above/);
    assert.notEqual(scrolled, top);

    await screen.press("g");
    assert.match(screen.text, /Select the next or previous event/);
  });

  it("does not scroll above the top", async () => {
    const { screen } = await start();
    await screen.press("?kkkk");
    assert.match(screen.text, /Keyboard reference/);
    assert.equal(screen.text.includes("more above"), false);
  });

  it("closes the overlay on Escape rather than scrolling forever", async () => {
    const { screen } = await start();
    await screen.press("?jj");
    await screen.press(ESC);
    assert.equal(screen.text.includes("Keyboard reference"), false);
  });
});

describe("calman view: recurring series saves", () => {
  it("re-reads the range after saving a whole-series change", async () => {
    const { screen, client } = await start();
    await screen.press(":goto 2026-09-17\r");
    await screen.press("dd");
    await screen.press("s");
    const listsBefore = client.calls.filter((c) => c === "list").length;
    await screen.press(":w\r");

    assert.match(screen.text, /Saved 1 change/);
    assert.equal(client.events.has("weekly-series"), false);
    assert.ok(
      client.calls.filter((c) => c === "list").length > listsBefore,
      "the range was reloaded so the remaining occurrences are accurate",
    );
  });
});

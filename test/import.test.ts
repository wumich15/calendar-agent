import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { extractEvents } from "../src/scrape/extract.ts";
import { normalizeEvents } from "../src/scrape/normalize.ts";
import { DEDUPE_PROPERTY, SOURCE_PROPERTY, importEvents, toGoogleEventBody } from "../src/calendar/import.ts";
import { formatReport } from "../src/commands/import-command.ts";
import { FakeCalendarClient } from "./helpers/fake-client.ts";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SOURCE = "https://riversidehall.example/whats-on";
const TZ = "America/New_York";

function prepare(fixtureName: string, sourceUrl = SOURCE) {
  const html = fs.readFileSync(path.join(fixturesDir, fixtureName), "utf8");
  const extracted = extractEvents(html, sourceUrl);
  return normalizeEvents(extracted.events, {
    defaultTimeZone: TZ,
    sourceUrl,
    referenceYear: 2026,
  });
}

function runImport(client: FakeCalendarClient, fixtureName: string, dryRun = false) {
  const { events, skipped } = prepare(fixtureName);
  return importEvents(events, skipped, {
    client,
    calendarId: "primary",
    timeZone: TZ,
    sourceUrl: SOURCE,
    dryRun,
  });
}

describe("importEvents", () => {
  it("creates every valid event and reports the ones it could not", async () => {
    const client = new FakeCalendarClient();
    const report = await runImport(client, "jsonld-events.html");

    assert.equal(report.imported.length, 3);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.failed.length, 0);
    assert.equal(client.events.size, 3);
    assert.match(report.skipped[0]!.reason, /no start date/);
  });

  it("reports the scheduled time alongside each event name", async () => {
    const client = new FakeCalendarClient();
    const report = await runImport(client, "jsonld-events.html");
    const quartet = report.imported.find((e) => e.name === "Ashgrove Quartet")!;
    assert.equal(quartet.when, "2026-03-04 19:30-21:45 (America/New_York)");
    const fair = report.imported.find((e) => e.name === "Spring Craft Fair")!;
    assert.equal(fair.when, "2026-04-11 to 2026-04-12 (all day)");
  });

  it("stores the dedupe key and source url on each created event", async () => {
    const client = new FakeCalendarClient();
    await runImport(client, "jsonld-events.html");
    for (const event of client.events.values()) {
      assert.equal(typeof event.extendedPrivate?.[DEDUPE_PROPERTY], "string");
      assert.equal(event.extendedPrivate?.[SOURCE_PROPERTY], SOURCE);
    }
  });

  it("does not create duplicates when the same page is imported again", async () => {
    const client = new FakeCalendarClient();
    const first = await runImport(client, "jsonld-events.html");
    assert.equal(first.imported.length, 3);

    const second = await runImport(client, "jsonld-events.html");
    assert.equal(second.imported.length, 0);
    assert.equal(second.duplicates.length, 3);
    assert.equal(client.events.size, 3, "no new events were created on the second run");
  });

  it("re-imports an event the user deleted from Google Calendar", async () => {
    const client = new FakeCalendarClient();
    await runImport(client, "jsonld-events.html");
    for (const [id, event] of client.events) {
      if (event.summary === "Ashgrove Quartet") client.events.delete(id);
    }
    const again = await runImport(client, "jsonld-events.html");
    assert.deepEqual(
      again.imported.map((e) => e.name),
      ["Ashgrove Quartet"],
    );
    assert.equal(again.duplicates.length, 2);
  });

  it("treats a cancelled remote copy as absent rather than as a duplicate", async () => {
    const client = new FakeCalendarClient();
    await runImport(client, "jsonld-events.html");
    for (const event of client.events.values()) {
      if (event.summary === "Ashgrove Quartet") event.status = "cancelled";
    }
    const again = await runImport(client, "jsonld-events.html");
    assert.deepEqual(
      again.imported.map((e) => e.name),
      ["Ashgrove Quartet"],
    );
  });

  it("writes nothing during a dry run but still reports what it would do", async () => {
    const client = new FakeCalendarClient();
    const report = await runImport(client, "jsonld-events.html", true);
    assert.equal(report.imported.length, 3);
    assert.equal(report.dryRun, true);
    assert.equal(client.events.size, 0);
    assert.equal(client.calls.some((call) => call.startsWith("create")), false);
  });

  it("keeps going after an API failure and reports which event failed", async () => {
    const client = new FakeCalendarClient();
    client.failures = [{ op: "create", status: 500, message: "Backend error", once: true }];
    const report = await runImport(client, "jsonld-events.html");

    assert.equal(report.failed.length, 1);
    assert.equal(report.imported.length, 2);
    assert.match(report.failed[0]!.error, /Google Calendar is having trouble/);
  });

  it("explains a permission failure in terms the user can act on", async () => {
    const client = new FakeCalendarClient();
    client.failures = [{ op: "create", status: 403, message: "Forbidden" }];
    const report = await runImport(client, "jsonld-events.html");
    assert.equal(report.imported.length, 0);
    assert.equal(report.failed.length, 3);
    assert.match(report.failed[0]!.error, /write access/);
  });

  it("collects the assumptions it made so the summary can show them", async () => {
    const client = new FakeCalendarClient();
    const report = await runImport(client, "jsonld-events.html");
    const preview = report.assumptions.find((a) => a.name === "Members Preview")!;
    assert.match(preview.notes.join(" "), /no time zone, so America\/New_York was used/);
    assert.match(preview.notes.join(" "), /no end time/);
  });
});

describe("toGoogleEventBody", () => {
  it("sends a date for all-day events and a zoned dateTime otherwise", () => {
    const { events } = prepare("jsonld-events.html");
    const fair = events.find((e) => e.name === "Spring Craft Fair")!;
    const quartet = events.find((e) => e.name === "Ashgrove Quartet")!;

    assert.deepEqual(toGoogleEventBody(fair).start, { date: "2026-04-11" });
    assert.deepEqual(toGoogleEventBody(quartet).start, {
      dateTime: "2026-03-04T19:30:00-05:00",
      timeZone: TZ,
    });
  });

  it("records the source page so each import can be traced back", () => {
    const { events } = prepare("jsonld-events.html");
    const body = toGoogleEventBody(events[0]!);
    assert.deepEqual(body.source, { title: "Imported by calman", url: SOURCE });
  });

  it("omits location entirely when the page gave none", () => {
    const { events } = prepare("jsonld-events.html");
    const tba = events.find((e) => e.name === "Members Preview")!;
    const body = toGoogleEventBody({ ...tba, location: undefined });
    assert.equal("location" in body, false);
  });
});

describe("formatReport", () => {
  it("names every outcome with its scheduled time", async () => {
    const client = new FakeCalendarClient();
    client.failures = [{ op: "create", status: 500, once: true }];
    const report = await runImport(client, "jsonld-events.html");
    const text = formatReport(report, "Test Calendar").join("\n");

    assert.match(text, /Imported 2:/);
    assert.match(text, /Could not be imported \(1\):/);
    assert.match(text, /Failed \(1\):/);
    assert.match(text, /Assumptions made while reading the page:/);
    assert.match(text, /Source: https:\/\/riversidehall\.example\/whats-on/);
  });

  it("says plainly that a dry run wrote nothing", async () => {
    const client = new FakeCalendarClient();
    const report = await runImport(client, "jsonld-events.html", true);
    const text = formatReport(report, "Test Calendar").join("\n");
    assert.match(text, /Dry run - nothing was written to Test Calendar\./);
    assert.match(text, /Would import 3:/);
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { extractEvents } from "../src/scrape/extract.ts";
import { dedupeKey, normalizeEvents } from "../src/scrape/normalize.ts";
import type { ExtractedEvent } from "../src/types.ts";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SOURCE = "https://riversidehall.example/whats-on";

function normalizeFixture(name: string, timeZone = "America/New_York", sourceUrl = SOURCE) {
  const html = fs.readFileSync(path.join(fixturesDir, name), "utf8");
  const extracted = extractEvents(html, sourceUrl);
  return normalizeEvents(extracted.events, {
    defaultTimeZone: timeZone,
    sourceUrl,
    referenceYear: 2026,
  });
}

function extracted(overrides: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return { name: "Test Event", via: "json-ld", ...overrides };
}

function normalizeOne(event: ExtractedEvent, timeZone = "America/New_York") {
  return normalizeEvents([event], { defaultTimeZone: timeZone, sourceUrl: SOURCE, referenceYear: 2026 });
}

describe("normalizeEvents: time zones", () => {
  it("respects an offset stated by the page", () => {
    const { events } = normalizeOne(
      extracted({ startRaw: "2026-03-04T19:30:00-05:00", endRaw: "2026-03-04T21:45:00-05:00" }),
      "Asia/Tokyo",
    );
    assert.equal(events[0]!.start.dateTime, "2026-03-04T19:30:00-05:00");
    // The page's own offset wins over the configured zone.
    assert.equal(events[0]!.assumptions.some((n) => n.includes("no time zone")), false);
  });

  it("falls back to the configured zone and says so when the page gives none", () => {
    const { events } = normalizeOne(extracted({ startRaw: "2026-03-10T18:00:00" }));
    assert.equal(events[0]!.start.dateTime, "2026-03-10T18:00:00-04:00");
    assert.equal(events[0]!.start.timeZone, "America/New_York");
    assert.match(events[0]!.assumptions.join(" "), /no time zone, so America\/New_York was used/);
  });

  it("interprets the same zone-less value differently in a different configured zone", () => {
    const { events } = normalizeOne(extracted({ startRaw: "2026-03-10T18:00:00" }), "Europe/Berlin");
    assert.equal(events[0]!.start.dateTime, "2026-03-10T18:00:00+01:00");
  });

  it("falls back and reports when the page names a zone that does not exist", () => {
    const { events } = normalizeOne(
      extracted({ startRaw: "2026-03-10T18:00:00", timeZone: "Mars/Olympus" }),
    );
    assert.equal(events[0]!.start.timeZone, "America/New_York");
    assert.match(events[0]!.assumptions.join(" "), /not a known zone/);
  });
});

describe("normalizeEvents: missing information", () => {
  it("skips an event with no start date instead of inventing one", () => {
    const { events, skipped } = normalizeOne(extracted({ name: "Date To Be Announced" }));
    assert.equal(events.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!.reason, /no start date/);
  });

  it("skips an event with no name", () => {
    const { skipped } = normalizeOne(
      extracted({ name: undefined, startRaw: "2026-03-04T19:30:00Z" }),
    );
    assert.match(skipped[0]!.reason, /no event name/);
  });

  it("skips an event whose start cannot be understood", () => {
    const { skipped } = normalizeOne(extracted({ startRaw: "sometime next spring" }));
    assert.match(skipped[0]!.reason, /could not be understood/);
  });

  it("defaults a missing end to one hour and reports the assumption", () => {
    const { events } = normalizeOne(extracted({ startRaw: "2026-03-10T18:00:00Z" }));
    assert.equal(events[0]!.end.dateTime, "2026-03-10T15:00:00-04:00");
    assert.match(events[0]!.assumptions.join(" "), /no end time, so 60 minutes was used/);
  });

  it("reads an end before the start as running past midnight", () => {
    const { events } = normalizeOne(
      extracted({ startRaw: "2026-03-10T22:00:00Z", endRaw: "2026-03-10T01:00:00Z" }),
    );
    assert.equal(events[0]!.end.dateTime, "2026-03-10T21:00:00-04:00");
    assert.match(events[0]!.assumptions.join(" "), /read as the next day/);
  });
});

describe("normalizeEvents: all-day events", () => {
  it("imports a date-only event as all-day and says that is what it did", () => {
    const { events } = normalizeFixture("jsonld-events.html");
    const fair = events.find((e) => e.name === "Spring Craft Fair")!;
    assert.equal(fair.allDay, true);
    assert.equal(fair.start.date, "2026-04-11");
    // Google's all-day end date is exclusive, so an inclusive 04-12 becomes 04-13.
    assert.equal(fair.end.date, "2026-04-13");
    assert.match(fair.assumptions.join(" "), /all-day event/);
  });

  it("gives a single-day all-day event a one-day exclusive end", () => {
    const { events } = normalizeOne(extracted({ startRaw: "2026-04-11" }));
    assert.equal(events[0]!.start.date, "2026-04-11");
    assert.equal(events[0]!.end.date, "2026-04-12");
  });

  it("accepts an explicit all-day marker without requiring a start time", () => {
    const { events, skipped } = normalizeOne(
      extracted({ startRaw: "2026-02-21", allDay: true, via: "html" }),
    );
    assert.equal(skipped.length, 0);
    assert.equal(events[0]!.allDay, true);
  });
});

describe("normalizeEvents: descriptions and source links", () => {
  it("always records the page the event came from", () => {
    const { events } = normalizeFixture("jsonld-events.html");
    for (const event of events) {
      assert.equal(event.sourceUrl, SOURCE);
      assert.match(event.description!, /Imported by cal from https:\/\/riversidehall\.example/);
    }
  });

  it("includes the event's own page when it differs from the source", () => {
    const { events } = normalizeFixture("jsonld-events.html");
    const quartet = events.find((e) => e.name === "Ashgrove Quartet")!;
    assert.match(quartet.description!, /Event page: https:\/\/riversidehall\.example\/events\/quartet/);
    assert.match(quartet.description!, /An evening of string quartets\./);
  });
});

describe("dedupe keys", () => {
  it("is stable across runs for the same event", () => {
    const first = normalizeFixture("jsonld-events.html").events.map((e) => e.dedupeKey);
    const second = normalizeFixture("jsonld-events.html").events.map((e) => e.dedupeKey);
    assert.deepEqual(first, second);
  });

  it("prefers a source-published identifier, so reworded copy still matches", () => {
    const a = dedupeKey({
      sourceUrl: SOURCE,
      sourceId: "evt-1",
      name: "Original name",
      start: { dateTime: "2026-03-04T19:30:00-05:00" },
      end: { dateTime: "2026-03-04T21:00:00-05:00" },
    });
    const b = dedupeKey({
      sourceUrl: SOURCE,
      sourceId: "evt-1",
      name: "A completely different name",
      start: { dateTime: "2026-05-05T10:00:00-04:00" },
      end: { dateTime: "2026-05-05T11:00:00-04:00" },
    });
    assert.equal(a, b);
  });

  it("falls back to the source url plus name and times", () => {
    const base = {
      sourceUrl: SOURCE,
      name: "Quiz Night",
      start: { dateTime: "2026-03-04T19:30:00-05:00" },
      end: { dateTime: "2026-03-04T21:00:00-05:00" },
    };
    assert.equal(dedupeKey(base), dedupeKey({ ...base, name: "  quiz   NIGHT " }));
    assert.notEqual(dedupeKey(base), dedupeKey({ ...base, sourceUrl: "https://other.example/" }));
    assert.notEqual(
      dedupeKey(base),
      dedupeKey({ ...base, start: { dateTime: "2026-03-05T19:30:00-05:00" } }),
    );
  });

  it("collapses an event that a page marks up twice", () => {
    const html = `<!doctype html><html><body>
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Event","name":"Quiz Night",
         "startDate":"2026-03-04T19:30:00-05:00","endDate":"2026-03-04T21:00:00-05:00"}
      </script>
      <div itemscope itemtype="https://schema.org/Event">
        <span itemprop="name">Quiz Night</span>
        <meta itemprop="startDate" content="2026-03-04T19:30:00-05:00" />
        <meta itemprop="endDate" content="2026-03-04T21:00:00-05:00" />
      </div>
    </body></html>`;
    const result = extractEvents(html, SOURCE);
    assert.equal(result.events.length, 2);
    const { events } = normalizeEvents(result.events, {
      defaultTimeZone: "America/New_York",
      sourceUrl: SOURCE,
    });
    assert.equal(events.length, 1);
  });
});

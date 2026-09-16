import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addPlainDays,
  formatOffset,
  isValidTimeZone,
  offsetMinutes,
  parseClockTime,
  startOfDayInstant,
  startOfWeek,
  toPlainDate,
  toPlainTime,
  toRfc3339,
  zonedTimeToInstant,
} from "../src/util/datetime.ts";
import { parseDateValue, parseHumanDate, parseTimeRange } from "../src/scrape/datetext.ts";

describe("time zone arithmetic", () => {
  it("uses the offset in force at that instant, not a fixed one", () => {
    const summer = new Date("2026-07-04T12:00:00Z");
    const winter = new Date("2026-01-04T12:00:00Z");
    assert.equal(offsetMinutes(summer, "America/New_York"), -240);
    assert.equal(offsetMinutes(winter, "America/New_York"), -300);
    assert.equal(toRfc3339(summer, "America/New_York"), "2026-07-04T08:00:00-04:00");
    assert.equal(toRfc3339(winter, "America/New_York"), "2026-01-04T07:00:00-05:00");
  });

  it("round-trips a wall-clock reading through an instant", () => {
    const parts = { year: 2026, month: 3, day: 4, hour: 19, minute: 30, second: 0 };
    const instant = zonedTimeToInstant(parts, "America/New_York");
    assert.equal(toRfc3339(instant, "America/New_York"), "2026-03-04T19:30:00-05:00");
    assert.equal(toPlainDate(instant, "America/New_York"), "2026-03-04");
    assert.equal(toPlainTime(instant, "America/New_York"), "19:30");
  });

  it("resolves a wall-clock time on the far side of a DST spring-forward", () => {
    // 02:30 does not exist on 2026-03-08 in New York; it resolves forward.
    const instant = zonedTimeToInstant(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      "America/New_York",
    );
    assert.equal(instant.toISOString(), "2026-03-08T07:30:00.000Z");
  });

  it("shows the same instant differently in different zones", () => {
    const instant = new Date("2026-05-02T17:00:00Z");
    assert.equal(toPlainTime(instant, "Europe/Dublin"), "18:00");
    assert.equal(toPlainTime(instant, "Asia/Tokyo"), "02:00");
    assert.equal(toPlainDate(instant, "Asia/Tokyo"), "2026-05-03");
  });

  it("starts a day at local midnight, not UTC midnight", () => {
    assert.equal(
      startOfDayInstant("2026-07-04", "America/New_York").toISOString(),
      "2026-07-04T04:00:00.000Z",
    );
  });

  it("formats offsets on both sides of UTC", () => {
    assert.equal(formatOffset(0), "+00:00");
    assert.equal(formatOffset(-330), "-05:30");
    assert.equal(formatOffset(345), "+05:45");
  });

  it("validates IANA zone names", () => {
    assert.equal(isValidTimeZone("Europe/Berlin"), true);
    assert.equal(isValidTimeZone("Mars/Olympus"), false);
    assert.equal(isValidTimeZone(""), false);
  });
});

describe("plain date helpers", () => {
  it("adds days across month and year boundaries", () => {
    assert.equal(addPlainDays("2026-02-28", 1), "2026-03-01");
    assert.equal(addPlainDays("2024-02-28", 1), "2024-02-29");
    assert.equal(addPlainDays("2026-01-01", -1), "2025-12-31");
  });

  it("finds the start of the week for either week-start convention", () => {
    assert.equal(startOfWeek("2026-09-15", 0), "2026-09-13");
    assert.equal(startOfWeek("2026-09-15", 1), "2026-09-14");
  });

  it("parses clock times and rejects impossible ones", () => {
    assert.deepEqual(parseClockTime("09:05"), { hour: 9, minute: 5 });
    assert.deepEqual(parseClockTime("23:59:30"), { hour: 23, minute: 59 });
    assert.equal(parseClockTime("24:00"), null);
    assert.equal(parseClockTime("9am"), null);
  });
});

describe("parsing dates found on pages", () => {
  it("reads ISO values with an explicit offset", () => {
    const parsed = parseDateValue("2026-03-04T19:30:00-05:00")!;
    assert.equal(parsed.kind, "datetime");
    assert.equal(parsed.offsetMinutes, -300);
  });

  it("reads a Z suffix as UTC", () => {
    assert.equal(parseDateValue("2026-06-18T13:00:00Z")!.offsetMinutes, 0);
  });

  it("reports no offset when the value has none, rather than guessing", () => {
    const parsed = parseDateValue("2026-03-10T18:00:00")!;
    assert.equal(parsed.kind, "datetime");
    assert.equal(parsed.offsetMinutes, undefined);
  });

  it("keeps a date-only value as a date", () => {
    const parsed = parseDateValue("2026-04-11")!;
    assert.equal(parsed.kind, "date");
    assert.deepEqual(
      [parsed.parts.year, parsed.parts.month, parsed.parts.day],
      [2026, 4, 11],
    );
  });

  it("reads iCalendar-style compact timestamps", () => {
    const parsed = parseDateValue("20260618T130000Z")!;
    assert.equal(parsed.kind, "datetime");
    assert.equal(parsed.offsetMinutes, 0);
  });

  it("reads human month-first and day-first prose", () => {
    const a = parseHumanDate("March 4, 2026 at 7:30 PM")!;
    assert.equal(a.kind, "datetime");
    assert.equal(a.parts.hour, 19);
    assert.equal(a.parts.minute, 30);

    const b = parseHumanDate("18 June 2026")!;
    assert.equal(b.kind, "date");
    assert.deepEqual([b.parts.month, b.parts.day], [6, 18]);
  });

  it("drops a leading weekday name", () => {
    const parsed = parseHumanDate("Saturday, 7 February 2026")!;
    assert.deepEqual([parsed.parts.month, parsed.parts.day], [2, 7]);
  });

  it("reports the assumption when a page omits the year", () => {
    const parsed = parseHumanDate("April 3", { referenceYear: 2026 })!;
    assert.equal(parsed.parts.year, 2026);
    assert.match(parsed.notes.join(" "), /omitted a year/);
  });

  it("refuses a year-less date when no reference year is offered", () => {
    assert.equal(parseHumanDate("April 3"), null);
  });

  it("notes which order it read an ambiguous numeric date in", () => {
    const monthFirst = parseHumanDate("03/04/2026")!;
    assert.deepEqual([monthFirst.parts.month, monthFirst.parts.day], [3, 4]);
    assert.match(monthFirst.notes.join(" "), /month\/day/);

    const dayFirst = parseHumanDate("03/04/2026", { dayFirst: true })!;
    assert.deepEqual([dayFirst.parts.month, dayFirst.parts.day], [4, 3]);
  });

  it("reads an unambiguous numeric date without a note", () => {
    const parsed = parseHumanDate("25/12/2026")!;
    assert.deepEqual([parsed.parts.month, parsed.parts.day], [12, 25]);
    assert.deepEqual(parsed.notes, []);
  });

  it("rejects impossible dates", () => {
    assert.equal(parseDateValue("2026-02-30"), null);
    assert.equal(parseDateValue("not a date at all"), null);
  });
});

describe("parsing time ranges in prose", () => {
  it("reads a range with one meridiem shared across both ends", () => {
    assert.deepEqual(parseTimeRange("Doors 7 - 9 PM"), {
      start: { hour: 19, minute: 0 },
      end: { hour: 21, minute: 0 },
    });
  });

  it("reads a 24-hour range with an en dash", () => {
    assert.deepEqual(parseTimeRange("10:00 – 13:00 in the main room"), {
      start: { hour: 10, minute: 0 },
      end: { hour: 13, minute: 0 },
    });
  });

  it("reads a single start time", () => {
    assert.deepEqual(parseTimeRange("Starts at 8:15 pm"), { start: { hour: 20, minute: 15 } });
  });

  it("returns null when there is no time in the text", () => {
    assert.equal(parseTimeRange("Bring something broken."), null);
  });
});

describe("DST edge cases", () => {
  it("returns the earlier instant when a wall-clock hour happens twice", () => {
    // 01:30 occurs twice in New York on 2026-11-01; the first is EDT.
    const instant = zonedTimeToInstant(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
      "America/New_York",
    );
    assert.equal(instant.toISOString(), "2026-11-01T05:30:00.000Z");
  });

  it("keeps an all-day date stable in a zone that shifts that day", () => {
    assert.equal(
      startOfDayInstant("2026-03-08", "America/New_York").toISOString(),
      "2026-03-08T05:00:00.000Z",
    );
  });
});

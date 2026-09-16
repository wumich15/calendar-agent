/**
 * `cal <url>` — fetch a page, extract its events, and add them to the calendar.
 */

import { createContext } from "./context.ts";
import { fetchPage, parsePageUrl } from "../scrape/fetch.ts";
import { extractEvents } from "../scrape/extract.ts";
import { normalizeEvents } from "../scrape/normalize.ts";
import { importEvents, type ImportReport } from "../calendar/import.ts";
import { UserFacingError } from "../types.ts";
import { todayInZone } from "../util/datetime.ts";

export type ImportCommandOptions = {
  url: string;
  dryRun: boolean;
  calendarId?: string;
  timeZone?: string;
  dayFirst?: boolean;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

export async function runImport(options: ImportCommandOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const url = parsePageUrl(options.url);

  const context = await createContext({
    calendarId: options.calendarId,
    timeZone: options.timeZone,
  });

  if (!options.dryRun && !context.writable) {
    throw new UserFacingError(
      `You have ${context.calendar.accessRole} access to "${context.calendar.summary}", which is read-only.`,
      "Choose a calendar you can edit with `cal config set calendar <id>`, or preview with --dry-run.",
    );
  }

  log(`Fetching ${url}`);
  const page = await fetchPage(url, { fetchImpl: options.fetchImpl });

  const extraction = extractEvents(page.html, page.url);
  if (!extraction.events.length) {
    if (extraction.needsJavaScript) {
      throw new UserFacingError(
        "No events could be read from this page.",
        [
          "The page appears to build its content with JavaScript in the browser, and cal reads",
          "the HTML the server sends. Try one of these instead:",
          "  - a printable, plain-HTML, or RSS/iCal version of the same listing",
          "  - the individual event's own page, which is more often server-rendered",
        ].join("\n"),
      );
    }
    throw new UserFacingError(
      `No events were found on ${page.url}.`,
      "cal reads JSON-LD, microdata, hCalendar, and ordinary HTML with <time> elements. The page may not list events, or may not mark them up in a readable way.",
    );
  }

  const { events, skipped } = normalizeEvents(extraction.events, {
    defaultTimeZone: context.timeZone,
    sourceUrl: page.url,
    referenceYear: Number(todayInZone(context.timeZone).slice(0, 4)),
    dayFirst: options.dayFirst,
  });

  log(
    `Found ${extraction.events.length} event${extraction.events.length === 1 ? "" : "s"} via ${extraction.sources.join(", ")}.`,
  );

  const report = await importEvents(events, skipped, {
    client: context.client,
    calendarId: context.calendar.id,
    timeZone: context.timeZone,
    sourceUrl: page.url,
    dryRun: options.dryRun,
  });

  for (const line of formatReport(report, context.calendar.summary)) log(line);
  return report.failed.length ? 1 : 0;
}

/** Renders the import summary the user sees at the end of a run. */
export function formatReport(report: ImportReport, calendarName: string): string[] {
  const lines: string[] = [];
  const total =
    report.imported.length + report.duplicates.length + report.skipped.length + report.failed.length;

  lines.push("");
  lines.push(
    report.dryRun
      ? `Dry run - nothing was written to ${calendarName}.`
      : `Calendar: ${calendarName} (${report.timeZone})`,
  );
  lines.push("");

  if (report.imported.length) {
    lines.push(
      report.dryRun
        ? `Would import ${report.imported.length}:`
        : `Imported ${report.imported.length}:`,
    );
    for (const entry of report.imported) lines.push(`  + ${entry.name}  ${entry.when}`);
    lines.push("");
  }

  if (report.duplicates.length) {
    lines.push(`Already imported, skipped as duplicates (${report.duplicates.length}):`);
    for (const entry of report.duplicates) lines.push(`  = ${entry.name}  ${entry.when}`);
    lines.push("");
  }

  if (report.skipped.length) {
    lines.push(`Could not be imported (${report.skipped.length}):`);
    for (const entry of report.skipped) lines.push(`  - ${entry.name}: ${entry.reason}`);
    lines.push("");
  }

  if (report.failed.length) {
    lines.push(`Failed (${report.failed.length}):`);
    for (const entry of report.failed) lines.push(`  ! ${entry.name}  ${entry.when}\n      ${entry.error}`);
    lines.push("");
  }

  if (report.assumptions.length) {
    lines.push("Assumptions made while reading the page:");
    for (const entry of report.assumptions) {
      for (const note of entry.notes) lines.push(`  ~ ${entry.name}: ${note}`);
    }
    lines.push("");
  }

  if (!total) lines.push("Nothing to import.");
  lines.push(`Source: ${report.sourceUrl}`);
  return lines;
}

/**
 * Command-line parsing and dispatch. This layer does no network or calendar
 * work of its own; it resolves arguments and hands off to a command module.
 */

import { runAuth, runCalendars, runConfig } from "./commands/auth-command.ts";
import { runImport } from "./commands/import-command.ts";
import { runView } from "./commands/view-command.ts";
import { HELP_LINES } from "./tui/render.ts";
import { UserFacingError } from "./types.ts";
import { stripAnsi } from "./tui/screen.ts";

const VERSION = "1.0.0";

const RESERVED = new Set(["view", "auth", "calendars", "config", "help", "version"]);

export type ParsedArgs = {
  command: "view" | "auth" | "calendars" | "config" | "help" | "version" | "import";
  positional: string[];
  flags: Record<string, string | boolean>;
};

const VALUE_FLAGS = new Set(["calendar", "timezone", "date"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new UserFacingError(`--${body} needs a value.`);
        }
        flags[body] = next;
        i += 1;
        continue;
      }
      flags[body] = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const short: Record<string, string> = { h: "help", v: "version", n: "dry-run" };
      const name = short[arg.slice(1)];
      if (!name) throw new UserFacingError(`Unknown option "${arg}".`, "Run `cal --help` for usage.");
      flags[name] = true;
      continue;
    }
    positional.push(arg);
  }

  if (flags.help) return { command: "help", positional, flags };
  if (flags.version) return { command: "version", positional, flags };

  const first = positional[0];
  if (!first) return { command: "help", positional, flags };
  if (RESERVED.has(first)) {
    return { command: first as ParsedArgs["command"], positional: positional.slice(1), flags };
  }
  return { command: "import", positional, flags };
}

export function helpText(): string {
  const lines: string[] = [
    "cal - import website events into Google Calendar and manage them from the terminal",
    "",
    "USAGE",
    "  cal <url>                 Scrape a website and import its events into Google Calendar",
    "  cal <url> --dry-run       Preview the extracted events without importing them",
    "  cal view                  Open the interactive calendar manager (daily view)",
    "  cal view --day            Open daily view",
    "  cal view --week           Open weekly view",
    "  cal auth                  Connect your Google account",
    "  cal auth --status         Show which account is connected",
    "  cal auth --logout         Disconnect and remove stored credentials",
    "  cal calendars             List the calendars you can use",
    "  cal config list           Show current settings",
    "  cal config set <key> <v>  Change a setting (calendar, timezone, week-start,",
    "                            client-id, client-secret)",
    "  cal --help                Show this help",
    "  cal --version             Show the version",
    "",
    "OPTIONS",
    "  --dry-run, -n             Preview only; do not write to Google Calendar",
    "  --calendar <id>           Use this calendar for one command",
    "  --timezone <zone>         Use this IANA time zone for one command",
    "  --date <YYYY-MM-DD>       Open `cal view` on this date",
    "  --day-first               Read ambiguous numeric dates as day/month",
    "",
    "INTERACTIVE KEYS (cal view)",
  ];
  for (const [keys, description] of HELP_LINES) {
    if (!keys && !description) continue;
    lines.push(`  ${stripAnsi(keys).padEnd(16)}${description}`);
  }
  lines.push("");
  lines.push("NOTES");
  lines.push("  macOS and most Linux distributions ship their own `cal` command that prints a");
  lines.push("  month calendar. Check which one you are running with `which -a cal`. If the");
  lines.push("  system one wins, call this project by path (node <project>/bin/cal.js), add an");
  lines.push("  alias (alias cal='node <project>/bin/cal.js'), or symlink it under another name.");
  lines.push("  See the README for details.");
  return lines.join("\n");
}

function reportError(err: unknown): void {
  if (err instanceof UserFacingError) {
    console.error(`cal: ${err.message}`);
    if (err.hint) console.error(err.hint);
    return;
  }
  const message = (err as Error)?.message ?? String(err);
  console.error(`cal: ${message}`);
  if (process.env.CAL_DEBUG) console.error((err as Error)?.stack);
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    reportError(err);
    return 2;
  }

  try {
    switch (parsed.command) {
      case "help":
        console.log(helpText());
        return 0;

      case "version":
        console.log(VERSION);
        return 0;

      case "auth":
        return await runAuth({
          status: parsed.flags.status === true,
          logout: parsed.flags.logout === true,
          printUrlOnly: parsed.flags["no-browser"] === true,
        });

      case "calendars":
        return await runCalendars();

      case "config":
        return await runConfig(parsed.positional);

      case "view": {
        const week = parsed.flags.week === true;
        const day = parsed.flags.day === true;
        if (week && day) {
          throw new UserFacingError("Choose either --day or --week, not both.");
        }
        return await runView({
          view: week ? "week" : "day",
          date: typeof parsed.flags.date === "string" ? parsed.flags.date : undefined,
          calendarId: typeof parsed.flags.calendar === "string" ? parsed.flags.calendar : undefined,
          timeZone: typeof parsed.flags.timezone === "string" ? parsed.flags.timezone : undefined,
        });
      }

      case "import": {
        const url = parsed.positional[0]!;
        if (parsed.positional.length > 1) {
          throw new UserFacingError(
            `Expected one URL but got ${parsed.positional.length}: ${parsed.positional.join(" ")}`,
            "Import one page at a time: cal https://example.com/events",
          );
        }
        return await runImport({
          url,
          dryRun: parsed.flags["dry-run"] === true,
          calendarId: typeof parsed.flags.calendar === "string" ? parsed.flags.calendar : undefined,
          timeZone: typeof parsed.flags.timezone === "string" ? parsed.flags.timezone : undefined,
          dayFirst: parsed.flags["day-first"] === true,
        });
      }

      default:
        console.log(helpText());
        return 0;
    }
  } catch (err) {
    reportError(err);
    return 1;
  }
}

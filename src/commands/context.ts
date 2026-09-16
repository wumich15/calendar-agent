/**
 * Shared setup for commands that talk to Google Calendar: credentials, the API
 * client, and the calendar and time zone to work against.
 */

import { createInterface } from "node:readline/promises";

import { authorize, createTokenProvider } from "../auth/google-auth.ts";
import { readTokens } from "../auth/token-store.ts";
import { readConfig, type Config } from "../config/config.ts";
import { GoogleCalendarClient, roleIsWritable, type CalendarClient } from "../calendar/client.ts";
import { UserFacingError, type CalendarInfo } from "../types.ts";
import { isValidTimeZone } from "../util/datetime.ts";

export type CalendarContext = {
  config: Config;
  client: CalendarClient;
  calendar: CalendarInfo;
  /** Zone used for display and for interpreting zone-less page times. */
  timeZone: string;
  writable: boolean;
  account?: string;
};

export type ContextOverrides = {
  calendarId?: string;
  timeZone?: string;
};

/** The system zone, used only when nothing else is configured. */
function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isValidTimeZone(zone) ? zone : "UTC";
}

/**
 * Ensures an account is connected before a command that needs one runs.
 *
 * At an interactive terminal this offers to start the authorization flow there
 * and then, so the first `cal <url>` does not simply fail. Anywhere else (a
 * script, a pipe, CI) it explains what to run instead of opening a browser
 * nobody is watching.
 */
export async function requireAuth(): Promise<void> {
  if (await readTokens()) return;

  const notConnected = new UserFacingError(
    "No Google account is connected yet.",
    "Run `cal auth` to authorize access to your Google Calendar, then try again.",
  );
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw notConnected;

  console.log("This command needs access to your Google Calendar, which is not connected yet.");
  const answer = await prompt("Connect your Google account now? [Y/n] ");
  if (answer && !/^y(es)?$/i.test(answer)) throw notConnected;

  await authorize();
  console.log("");
}

/** Reads one line from the terminal. */
async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function createContext(overrides: ContextOverrides = {}): Promise<CalendarContext> {
  await requireAuth();
  const config = await readConfig();
  const tokens = await createTokenProvider(config);
  const client = new GoogleCalendarClient({ tokens });
  const calendarId = overrides.calendarId ?? config.calendarId ?? "primary";

  let calendar: CalendarInfo;
  try {
    calendar = await client.getCalendar(calendarId);
  } catch (err) {
    throw new UserFacingError(
      `Could not open the calendar "${calendarId}": ${(err as Error).message}`,
      "Run `cal calendars` to see the calendars you can use, then `cal config set calendar <id>`.",
    );
  }

  const timeZone =
    overrides.timeZone ?? config.timeZone ?? calendar.timeZone ?? systemTimeZone();
  if (!isValidTimeZone(timeZone)) {
    throw new UserFacingError(
      `"${timeZone}" is not a known IANA time zone.`,
      "Use a name such as America/New_York or Europe/Berlin.",
    );
  }

  return {
    config,
    client,
    calendar,
    timeZone,
    writable: roleIsWritable(calendar.accessRole),
    account: tokens.account(),
  };
}

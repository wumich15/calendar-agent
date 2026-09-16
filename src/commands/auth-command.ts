/**
 * `cal auth` — connect, inspect, or disconnect the Google account, and
 * `cal calendars` / `cal config` for the settings the rest of the app reads.
 */

import { authorize, authStatus, signOut } from "../auth/google-auth.ts";
import { createTokenProvider } from "../auth/google-auth.ts";
import { GoogleCalendarClient } from "../calendar/client.ts";
import { readConfig, updateConfig } from "../config/config.ts";
import { configFile, tokenFile } from "../config/paths.ts";
import { createContext } from "./context.ts";
import { UserFacingError } from "../types.ts";
import { isValidTimeZone } from "../util/datetime.ts";

export async function runAuth(options: {
  status?: boolean;
  logout?: boolean;
  printUrlOnly?: boolean;
  log?: (line: string) => void;
}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));

  if (options.logout) {
    await signOut();
    log("Disconnected. Stored credentials were removed and the token was revoked.");
    log("Run `cal auth` to connect again.");
    return 0;
  }

  if (options.status) {
    const status = await authStatus();
    if (!status.connected) {
      log("Not connected. Run `cal auth` to authorize access to your Google Calendar.");
      return 1;
    }
    log(`Connected${status.account ? ` as ${status.account}` : ""}.`);
    if (status.expiresAt) {
      const expired = status.expiresAt <= Date.now();
      log(
        expired
          ? "The access token has expired; it will be refreshed automatically on the next command."
          : `Access token valid until ${new Date(status.expiresAt).toLocaleString()}.`,
      );
    }
    log(`Credentials file: ${tokenFile()}`);
    return 0;
  }

  const tokens = await authorize({ printUrlOnly: options.printUrlOnly });
  log(`Connected${tokens.account ? ` as ${tokens.account}` : ""}.`);

  // Pick a sensible default calendar straight away so the first run just works.
  const config = await readConfig();
  if (!config.calendarId || config.calendarId === "primary") {
    try {
      const client = new GoogleCalendarClient({ tokens: await createTokenProvider(config) });
      const calendar = await client.getCalendar("primary");
      log(`Using your primary calendar: ${calendar.summary} (${calendar.timeZone}).`);
      log("Run `cal calendars` to see other calendars you can use.");
    } catch {
      log("Using your primary calendar.");
    }
  } else {
    log(`Using the configured calendar: ${config.calendarId}`);
  }
  return 0;
}

export async function runCalendars(log = (line: string) => console.log(line)): Promise<number> {
  const context = await createContext();
  const calendars = await context.client.listCalendars();
  if (!calendars.length) {
    log("No calendars are available to this account.");
    return 1;
  }
  const current = context.config.calendarId ?? "primary";
  log("Calendars you can use:");
  log("");
  for (const calendar of calendars) {
    const selected =
      calendar.id === current || (current === "primary" && calendar.primary) ? "*" : " ";
    const access = calendar.accessRole === "owner" || calendar.accessRole === "writer"
      ? calendar.accessRole
      : `${calendar.accessRole} (read-only)`;
    log(` ${selected} ${calendar.summary}`);
    log(`     id:       ${calendar.id}`);
    log(`     access:   ${access}`);
    log(`     timezone: ${calendar.timeZone}`);
    log("");
  }
  log("A * marks the calendar cal is using. Change it with:");
  log("  cal config set calendar <id>");
  return 0;
}

const CONFIG_KEYS = ["calendar", "timezone", "client-id", "client-secret", "week-start"] as const;

export async function runConfig(
  args: string[],
  log = (line: string) => console.log(line),
): Promise<number> {
  const [action, key, ...rest] = args;

  if (!action || action === "list" || action === "show") {
    const config = await readConfig();
    log(`Config file: ${configFile()}`);
    log(`  calendar:      ${config.calendarId}`);
    log(`  timezone:      ${config.timeZone ?? "(follow the calendar's own time zone)"}`);
    log(`  week-start:    ${config.weekStartsOn === 1 ? "monday" : "sunday"}`);
    log(
      `  client-id:     ${process.env.CAL_CLIENT_ID ? "(from CAL_CLIENT_ID)" : config.clientId ? "(set)" : "(not set)"}`,
    );
    log(
      `  client-secret: ${process.env.CAL_CLIENT_SECRET ? "(from CAL_CLIENT_SECRET)" : config.clientSecret ? "(set)" : "(not set)"}`,
    );
    return 0;
  }

  if (action === "get") {
    const config = await readConfig();
    switch (key) {
      case "calendar":
        log(config.calendarId);
        return 0;
      case "timezone":
        log(config.timeZone ?? "");
        return 0;
      case "week-start":
        log(config.weekStartsOn === 1 ? "monday" : "sunday");
        return 0;
      default:
        throw new UserFacingError(
          `Unknown config key "${key}".`,
          `Known keys: ${CONFIG_KEYS.join(", ")}`,
        );
    }
  }

  if (action !== "set") {
    throw new UserFacingError(
      `Unknown config action "${action}".`,
      "Usage: cal config [list | get <key> | set <key> <value>]",
    );
  }

  const value = rest.join(" ").trim();
  if (!key || !value) {
    throw new UserFacingError("Usage: cal config set <key> <value>", `Known keys: ${CONFIG_KEYS.join(", ")}`);
  }

  switch (key) {
    case "calendar":
      await updateConfig({ calendarId: value });
      log(`Calendar set to ${value}.`);
      return 0;
    case "timezone": {
      if (!isValidTimeZone(value)) {
        throw new UserFacingError(
          `"${value}" is not a known IANA time zone.`,
          "Use a name such as America/New_York or Europe/Berlin.",
        );
      }
      await updateConfig({ timeZone: value });
      log(`Time zone set to ${value}.`);
      return 0;
    }
    case "week-start": {
      const lower = value.toLowerCase();
      if (lower !== "sunday" && lower !== "monday") {
        throw new UserFacingError("week-start must be either sunday or monday.");
      }
      await updateConfig({ weekStartsOn: lower === "monday" ? 1 : 0 });
      log(`Weeks now start on ${lower}.`);
      return 0;
    }
    case "client-id":
      await updateConfig({ clientId: value });
      log(`OAuth client id saved to ${configFile()} (file permissions 0600).`);
      return 0;
    case "client-secret":
      await updateConfig({ clientSecret: value });
      log(`OAuth client secret saved to ${configFile()} (file permissions 0600).`);
      return 0;
    default:
      throw new UserFacingError(
        `Unknown config key "${key}".`,
        `Known keys: ${CONFIG_KEYS.join(", ")}`,
      );
  }
}

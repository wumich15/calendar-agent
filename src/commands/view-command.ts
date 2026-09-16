/**
 * `calman view` — open the interactive calendar manager.
 */

import { App } from "../tui/app.ts";
import { createContext } from "./context.ts";
import { UserFacingError } from "../types.ts";
import { isPlainDate } from "../util/datetime.ts";
import type { ViewMode } from "../tui/model.ts";

export type ViewCommandOptions = {
  view: ViewMode;
  date?: string;
  calendarId?: string;
  timeZone?: string;
};

export async function runView(options: ViewCommandOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UserFacingError(
      "`calman view` needs an interactive terminal.",
      "Run it directly in a terminal rather than through a pipe or a non-interactive shell.",
    );
  }

  if (options.date && !isPlainDate(options.date)) {
    throw new UserFacingError(
      `--date must be written as YYYY-MM-DD, but got "${options.date}".`,
    );
  }

  const context = await createContext({
    calendarId: options.calendarId,
    timeZone: options.timeZone,
  });

  const app = new App({
    client: context.client,
    calendarId: context.calendar.id,
    calendarName: context.calendar.summary,
    timeZone: context.timeZone,
    calendarWritable: context.writable,
    account: context.account,
    initialView: options.view,
    initialDate: options.date,
    weekStartsOn: context.config.weekStartsOn ?? 0,
  });

  const code = await app.run();
  if (!context.writable) {
    console.log(
      `Note: you have ${context.calendar.accessRole} access to "${context.calendar.summary}", so it opened read-only.`,
    );
  }
  return code;
}

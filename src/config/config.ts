import fs from "node:fs/promises";
import path from "node:path";
import { configDir, configFile } from "./paths.ts";
import { isValidTimeZone } from "../util/datetime.ts";
import { UserFacingError } from "../types.ts";

export type Config = {
  /** Calendar the app reads and writes. "primary" means the user's own calendar. */
  calendarId: string;
  /** Preferred display/import time zone. Empty means "follow the calendar". */
  timeZone?: string;
  /** OAuth client, when the user supplies their own Google Cloud project. */
  clientId?: string;
  clientSecret?: string;
  /** First day of the week in the weekly view, 0 = Sunday. */
  weekStartsOn?: number;
};

export const DEFAULT_CONFIG: Config = {
  calendarId: "primary",
};

export async function readConfig(): Promise<Config> {
  let text: string;
  try {
    text = await fs.readFile(configFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UserFacingError(
      `Config file is not valid JSON: ${configFile()}`,
      "Fix or delete the file, then run `calman auth` again.",
    );
  }
  const obj = (parsed ?? {}) as Partial<Config>;
  const merged: Config = { ...DEFAULT_CONFIG, ...obj };
  if (merged.timeZone && !isValidTimeZone(merged.timeZone)) {
    throw new UserFacingError(
      `Config has an unknown time zone: ${merged.timeZone}`,
      "Use an IANA name such as America/New_York.",
    );
  }
  return merged;
}

export async function writeConfig(config: Config): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const file = configFile();
  const tmp = path.join(path.dirname(file), `.config.${process.pid}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await readConfig()), ...patch };
  await writeConfig(next);
  return next;
}

/**
 * OAuth client credentials, preferring environment variables so that a shared
 * machine never needs them written to disk.
 */
export function resolveOAuthClient(config: Config): { clientId: string; clientSecret: string } {
  const clientId = process.env.CALMAN_CLIENT_ID || config.clientId;
  const clientSecret = process.env.CALMAN_CLIENT_SECRET || config.clientSecret;
  if (!clientId || !clientSecret) {
    throw new UserFacingError(
      "No Google OAuth client is configured.",
      [
        "Create a Desktop-app OAuth client in Google Cloud Console, then either:",
        "  export CALMAN_CLIENT_ID=... CALMAN_CLIENT_SECRET=...",
        "or run: calman config set client-id <id> && calman config set client-secret <secret>",
        "See the Google authorization section of the README for the full walkthrough.",
      ].join("\n"),
    );
  }
  return { clientId, clientSecret };
}

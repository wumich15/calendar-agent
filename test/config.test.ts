import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readConfig, resolveOAuthClient, updateConfig, writeConfig } from "../src/config/config.ts";
import { configFile, tokenFile } from "../src/config/paths.ts";
import { clearTokens, readTokens, writeTokens } from "../src/auth/token-store.ts";
import { UserFacingError } from "../src/types.ts";

let dir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "calman-config-"));
  savedEnv = {
    CALMAN_CONFIG_DIR: process.env.CALMAN_CONFIG_DIR,
    CALMAN_CLIENT_ID: process.env.CALMAN_CLIENT_ID,
    CALMAN_CLIENT_SECRET: process.env.CALMAN_CLIENT_SECRET,
  };
  process.env.CALMAN_CONFIG_DIR = dir;
  delete process.env.CALMAN_CLIENT_ID;
  delete process.env.CALMAN_CLIENT_SECRET;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("defaults to the primary calendar when nothing is saved", async () => {
    assert.deepEqual(await readConfig(), { calendarId: "primary" });
  });

  it("round-trips settings through the config file", async () => {
    await writeConfig({ calendarId: "work@example.com", timeZone: "Europe/Berlin", weekStartsOn: 1 });
    const config = await readConfig();
    assert.equal(config.calendarId, "work@example.com");
    assert.equal(config.timeZone, "Europe/Berlin");
    assert.equal(config.weekStartsOn, 1);
  });

  it("merges a partial update into the existing config", async () => {
    await writeConfig({ calendarId: "work@example.com", timeZone: "Europe/Berlin" });
    const updated = await updateConfig({ calendarId: "other@example.com" });
    assert.equal(updated.calendarId, "other@example.com");
    assert.equal(updated.timeZone, "Europe/Berlin", "the time zone was left alone");
  });

  it("writes the config file readable only by its owner", async () => {
    await writeConfig({ calendarId: "primary", clientSecret: "shh" });
    const stats = await fs.stat(configFile());
    assert.equal(stats.mode & 0o777, 0o600);
  });

  it("explains a corrupted config file instead of crashing", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(configFile(), "{ not json");
    await assert.rejects(readConfig(), (err: UserFacingError) => {
      assert.match(err.message, /not valid JSON/);
      assert.match(err.hint!, /calman auth/);
      return true;
    });
  });

  it("rejects a saved time zone that does not exist", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(configFile(), JSON.stringify({ calendarId: "primary", timeZone: "Mars/Olympus" }));
    await assert.rejects(readConfig(), /unknown time zone/);
  });
});

describe("resolveOAuthClient", () => {
  it("prefers environment variables over the config file", () => {
    process.env.CALMAN_CLIENT_ID = "env-id";
    process.env.CALMAN_CLIENT_SECRET = "env-secret";
    assert.deepEqual(resolveOAuthClient({ calendarId: "primary", clientId: "file-id", clientSecret: "file-secret" }), {
      clientId: "env-id",
      clientSecret: "env-secret",
    });
  });

  it("falls back to the config file", () => {
    assert.deepEqual(
      resolveOAuthClient({ calendarId: "primary", clientId: "file-id", clientSecret: "file-secret" }),
      { clientId: "file-id", clientSecret: "file-secret" },
    );
  });

  it("explains how to set up a client when none is configured", () => {
    assert.throws(() => resolveOAuthClient({ calendarId: "primary" }), (err: UserFacingError) => {
      assert.match(err.message, /No Google OAuth client is configured/);
      assert.match(err.hint!, /CALMAN_CLIENT_ID/);
      return true;
    });
  });
});

describe("token storage", () => {
  const tokens = {
    accessToken: "at-123",
    refreshToken: "rt-456",
    expiresAt: Date.now() + 3600_000,
    scope: "https://www.googleapis.com/auth/calendar.events",
    tokenType: "Bearer",
    account: "user@example.com",
  };

  it("round-trips tokens", async () => {
    await writeTokens(tokens);
    assert.deepEqual(await readTokens(), tokens);
  });

  it("stores credentials readable only by their owner", async () => {
    await writeTokens(tokens);
    const stats = await fs.stat(tokenFile());
    assert.equal(stats.mode & 0o777, 0o600, "token file is not readable by anyone else");
    const dirStats = await fs.stat(dir);
    assert.equal(dirStats.mode & 0o077, 0, "the containing directory is not group or world accessible");
  });

  it("reports no tokens rather than throwing when none are stored", async () => {
    assert.equal(await readTokens(), null);
  });

  it("removes credentials on sign-out and tolerates a second removal", async () => {
    await writeTokens(tokens);
    await clearTokens();
    assert.equal(await readTokens(), null);
    await clearTokens();
  });

  it("treats an unreadable token file as not connected", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tokenFile(), "garbage");
    assert.equal(await readTokens(), null);
  });
});

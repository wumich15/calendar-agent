import fs from "node:fs/promises";
import path from "node:path";
import { configDir, tokenFile } from "../config/paths.ts";

export type StoredTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds at which `accessToken` stops working. */
  expiresAt: number;
  scope: string;
  tokenType: string;
  /** Email of the connected account, shown in the UI. Never sent anywhere. */
  account?: string;
};

export async function readTokens(): Promise<StoredTokens | null> {
  try {
    const text = await fs.readFile(tokenFile(), "utf8");
    const parsed = JSON.parse(text) as StoredTokens;
    if (!parsed || typeof parsed.accessToken !== "string") return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

/**
 * Writes the token file with owner-only permissions. The file is created at
 * mode 0600 and the containing directory at 0700 so that tokens are never
 * world-readable, even briefly.
 */
export async function writeTokens(tokens: StoredTokens): Promise<void> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = tokenFile();
  const tmp = path.join(dir, `.tokens.${process.pid}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

export async function clearTokens(): Promise<void> {
  try {
    await fs.unlink(tokenFile());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

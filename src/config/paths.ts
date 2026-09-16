import os from "node:os";
import path from "node:path";

/**
 * Configuration lives in `$CALMAN_CONFIG_DIR`, else `$XDG_CONFIG_HOME/calman`, else
 * `~/.config/calman`. Tests set `CALMAN_CONFIG_DIR` to stay out of the real home
 * directory, so this is always read lazily rather than captured at import.
 */
export function configDir(): string {
  const override = process.env.CALMAN_CONFIG_DIR;
  if (override) return path.resolve(override);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "calman");
  return path.join(os.homedir(), ".config", "calman");
}

export function configFile(): string {
  return path.join(configDir(), "config.json");
}

export function tokenFile(): string {
  return path.join(configDir(), "tokens.json");
}

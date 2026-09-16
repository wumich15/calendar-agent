import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { readConfig, resolveOAuthClient, type Config } from "../config/config.ts";
import { clearTokens, readTokens, writeTokens, type StoredTokens } from "./token-store.ts";
import { UserFacingError } from "../types.ts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Only what the app actually does: read/write events, list the calendars the
 * user can pick from, and learn which account is connected.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "openid",
  "email",
];

/** Refresh this long before actual expiry so in-flight requests do not race it. */
const EXPIRY_SKEW_MS = 60_000;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Falling back to the printed URL is fine; the caller always prints it.
  }
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

async function postForm(endpoint: string, body: Record<string, string>): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

function describeOAuthError(status: number, payload: unknown): string {
  const obj = payload as { error?: string; error_description?: string } | null;
  const code = obj?.error ? `${obj.error}` : `HTTP ${status}`;
  const detail = obj?.error_description ? `: ${obj.error_description}` : "";
  return `${code}${detail}`;
}

/**
 * Runs the loopback OAuth flow with PKCE: starts a one-shot local server, opens
 * the consent page, and exchanges the returned code for tokens.
 */
export async function authorize(options: { printUrlOnly?: boolean } = {}): Promise<StoredTokens> {
  const config = await readConfig();
  const { clientId, clientSecret } = resolveOAuthClient(config);
  const { verifier, challenge } = makePkcePair();
  const state = base64url(crypto.randomBytes(16));

  const server = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("Could not open a local port for the OAuth redirect."));
    });
  });
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new UserFacingError("Timed out waiting for Google authorization (5 minutes).")),
      5 * 60_000,
    );
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      const finish = (body: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>calman</title>
<body style="font-family:system-ui;padding:3rem;max-width:34rem">
<h1>calman</h1><p>${body}</p></body>`);
      };
      clearTimeout(timer);
      if (error) {
        finish("Authorization was denied. You can close this tab and try again.");
        reject(new UserFacingError(`Google authorization was denied: ${error}`));
      } else if (!code || gotState !== state) {
        finish("Authorization response could not be verified. Please try again.");
        reject(new UserFacingError("The authorization response did not match this request."));
      } else {
        finish("Account connected. You can close this tab and return to the terminal.");
        resolve(code);
      }
    });
  });

  console.log("Opening Google authorization in your browser.");
  console.log(`If it does not open, visit this URL:\n\n  ${authUrl}\n`);
  if (!options.printUrlOnly) openBrowser(authUrl.toString());

  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const res = await postForm(TOKEN_ENDPOINT, {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const payload = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!res.ok || !payload?.access_token) {
    throw new UserFacingError(
      `Could not exchange the authorization code: ${describeOAuthError(res.status, payload)}`,
      "Check that the OAuth client is a Desktop app client and that the Calendar API is enabled.",
    );
  }

  const tokens: StoredTokens = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    scope: payload.scope,
    tokenType: payload.token_type,
  };
  tokens.account = await fetchAccountEmail(tokens.accessToken);
  await writeTokens(tokens);
  return tokens;
}

async function fetchAccountEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { email?: string };
    return body.email;
  } catch {
    return undefined;
  }
}

async function refresh(tokens: StoredTokens, config: Config): Promise<StoredTokens> {
  if (!tokens.refreshToken) {
    throw new UserFacingError(
      "Your Google access token expired and there is no refresh token stored.",
      "Run `calman auth` to reconnect your account.",
    );
  }
  const { clientId, clientSecret } = resolveOAuthClient(config);
  const res = await postForm(TOKEN_ENDPOINT, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refreshToken,
    grant_type: "refresh_token",
  });
  const payload = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!res.ok || !payload?.access_token) {
    // invalid_grant means the user revoked access or the token aged out.
    throw new UserFacingError(
      `Could not refresh Google access: ${describeOAuthError(res.status, payload)}`,
      "Access may have been revoked or expired. Run `calman auth` to reconnect.",
    );
  }
  const next: StoredTokens = {
    ...tokens,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + payload.expires_in * 1000,
    scope: payload.scope || tokens.scope,
    tokenType: payload.token_type || tokens.tokenType,
  };
  await writeTokens(next);
  return next;
}

/** Supplies a valid bearer token, refreshing on demand. */
export type TokenProvider = {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
  account(): string | undefined;
};

export async function createTokenProvider(config?: Config): Promise<TokenProvider> {
  const cfg = config ?? (await readConfig());
  let tokens = await readTokens();
  if (!tokens) {
    throw new UserFacingError(
      "No Google account is connected.",
      "Run `calman auth` to connect your Google Calendar.",
    );
  }
  let inflight: Promise<StoredTokens> | null = null;

  return {
    async getAccessToken(forceRefresh = false) {
      const current = tokens as StoredTokens;
      const stale = forceRefresh || current.expiresAt - EXPIRY_SKEW_MS <= Date.now();
      if (!stale) return current.accessToken;
      // Collapse concurrent refreshes so parallel API calls issue one request.
      inflight ??= refresh(current, cfg).finally(() => {
        inflight = null;
      });
      tokens = await inflight;
      return tokens.accessToken;
    },
    account() {
      return tokens?.account;
    },
  };
}

export async function signOut(): Promise<void> {
  const tokens = await readTokens();
  if (tokens?.refreshToken || tokens?.accessToken) {
    try {
      await postForm(REVOKE_ENDPOINT, { token: tokens.refreshToken ?? tokens.accessToken });
    } catch {
      // Local credentials are removed regardless of whether revocation lands.
    }
  }
  await clearTokens();
}

export async function authStatus(): Promise<{ connected: boolean; account?: string; expiresAt?: number }> {
  const tokens = await readTokens();
  if (!tokens) return { connected: false };
  return { connected: true, account: tokens.account, expiresAt: tokens.expiresAt };
}

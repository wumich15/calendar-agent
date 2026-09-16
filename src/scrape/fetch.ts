import { UserFacingError } from "../types.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "calman/1.0 (+https://github.com/wumich15/calendar-agent) calendar-event-importer";

export type FetchedPage = {
  /** URL after redirects, used as the canonical source URL. */
  url: string;
  html: string;
  contentType: string;
};

/** Validates a user-supplied URL and returns it normalized. */
export function parsePageUrl(input: string): URL {
  const invalid = new UserFacingError(
    `Not a valid URL: ${input}`,
    "Pass a full address, for example: calman https://example.com/events",
  );

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    // Be forgiving about a bare host like "example.com/events", but only when
    // the input names no scheme at all: "http://" is a malformed URL, not a host.
    if (/^[a-z][a-z0-9+.-]*:/i.test(input.trim())) throw invalid;
    try {
      url = new URL(`https://${input.trim()}`);
    } catch {
      throw invalid;
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UserFacingError(
      `Unsupported URL scheme "${url.protocol.replace(":", "")}".`,
      "Only http:// and https:// pages can be imported.",
    );
  }
  // An http(s) URL with no host, such as "http://", is malformed rather than unsupported.
  if (!url.hostname) throw invalid;
  return url;
}

/** Downloads a page as text, with a timeout, a size cap, and clear failures. */
export async function fetchPage(
  input: string | URL,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<FetchedPage> {
  const url = input instanceof URL ? input : parsePageUrl(input);
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === "AbortError") {
      throw new UserFacingError(
        `Timed out fetching ${url.hostname} after ${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s.`,
        "The site may be slow or blocking automated requests. Try again or use a different page.",
      );
    }
    throw new UserFacingError(
      `Could not reach ${url.hostname}: ${(err as Error).message}`,
      "Check the address and your network connection.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const hint =
      res.status === 404
        ? "The page does not exist. Check the address."
        : res.status === 403 || res.status === 401
          ? "The site refused the request. It may require a login or block automated clients."
          : res.status >= 500
            ? "The site is having trouble. Try again later."
            : undefined;
    throw new UserFacingError(`${url} returned HTTP ${res.status} ${res.statusText}`.trim(), hint);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType && !/text\/html|xhtml|text\/plain|application\/xml|\+xml|application\/json/i.test(contentType)) {
    throw new UserFacingError(
      `${url} is ${contentType.split(";")[0]}, not an HTML page.`,
      "Point calman at a web page that lists events.",
    );
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new UserFacingError(`${url} is larger than the ${MAX_BYTES / 1024 / 1024} MB page limit.`);
  }

  const buffer = await readCapped(res, MAX_BYTES, url.toString());
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, "");
  const html = decode(buffer, charset);
  return { url: res.url || url.toString(), html, contentType };
}

async function readCapped(res: Response, limit: number, url: string): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) {
      throw new UserFacingError(`${url} is larger than the ${limit / 1024 / 1024} MB page limit.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function decode(buffer: Buffer, charset?: string): string {
  const candidates = [charset, "utf-8"].filter(Boolean) as string[];
  for (const encoding of candidates) {
    try {
      return new TextDecoder(encoding, { fatal: false }).decode(buffer);
    } catch {
      // Unknown label: fall through to the next candidate.
    }
  }
  return buffer.toString("utf8");
}

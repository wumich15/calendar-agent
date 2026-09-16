import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { helpText, parseArgs } from "../src/cli.ts";
import { parsePageUrl, fetchPage } from "../src/scrape/fetch.ts";
import { UserFacingError } from "../src/types.ts";

describe("parseArgs", () => {
  it("treats a bare URL as an import", () => {
    const parsed = parseArgs(["https://example.com/events"]);
    assert.equal(parsed.command, "import");
    assert.deepEqual(parsed.positional, ["https://example.com/events"]);
  });

  it("recognizes the reserved subcommands", () => {
    assert.equal(parseArgs(["view"]).command, "view");
    assert.equal(parseArgs(["auth"]).command, "auth");
    assert.equal(parseArgs(["calendars"]).command, "calendars");
    assert.equal(parseArgs(["config", "list"]).command, "config");
    assert.deepEqual(parseArgs(["config", "set", "calendar", "abc"]).positional, [
      "set",
      "calendar",
      "abc",
    ]);
  });

  it("reads boolean flags", () => {
    const parsed = parseArgs(["https://example.com", "--dry-run"]);
    assert.equal(parsed.flags["dry-run"], true);
    assert.equal(parseArgs(["https://example.com", "-n"]).flags["dry-run"], true);
    assert.equal(parseArgs(["view", "--week"]).flags.week, true);
  });

  it("reads value flags in both spellings", () => {
    assert.equal(parseArgs(["view", "--calendar", "work@example.com"]).flags.calendar, "work@example.com");
    assert.equal(parseArgs(["view", "--calendar=work@example.com"]).flags.calendar, "work@example.com");
  });

  it("rejects a value flag with no value", () => {
    assert.throws(() => parseArgs(["view", "--calendar"]), UserFacingError);
    assert.throws(() => parseArgs(["view", "--calendar", "--week"]), UserFacingError);
  });

  it("rejects an unknown short option", () => {
    assert.throws(() => parseArgs(["-z"]), UserFacingError);
  });

  it("falls back to help with no arguments", () => {
    assert.equal(parseArgs([]).command, "help");
    assert.equal(parseArgs(["--help"]).command, "help");
    assert.equal(parseArgs(["-h"]).command, "help");
    assert.equal(parseArgs(["--version"]).command, "version");
  });

  it("stops flag parsing after --, so a URL shaped like a flag still works", () => {
    const parsed = parseArgs(["--", "--weird-url"]);
    assert.deepEqual(parsed.positional, ["--weird-url"]);
  });
});

describe("helpText", () => {
  it("documents the commands, the keys, and the name clash with the system cal", () => {
    const text = helpText();
    assert.match(text, /cal <url>/);
    assert.match(text, /cal view --week/);
    assert.match(text, /dd\s+Stage the selected event for deletion/);
    assert.match(text, /:q!\s+Discard unsaved changes and quit/);
    assert.match(text, /already ship their own `cal` command|ship their own `cal` command/);
  });
});

describe("parsePageUrl", () => {
  it("accepts http and https", () => {
    assert.equal(parsePageUrl("https://example.com/events").protocol, "https:");
    assert.equal(parsePageUrl("http://example.com/events").protocol, "http:");
  });

  it("assumes https for a bare host", () => {
    assert.equal(parsePageUrl("example.com/events").toString(), "https://example.com/events");
  });

  it("rejects other schemes with an explanation", () => {
    assert.throws(() => parsePageUrl("file:///etc/passwd"), /Unsupported URL scheme "file"/);
    assert.throws(() => parsePageUrl("ftp://example.com"), /Unsupported URL scheme "ftp"/);
  });

  it("rejects input that is not a URL at all", () => {
    assert.throws(() => parsePageUrl("http://"), /Not a valid URL/);
  });
});

describe("fetchPage", () => {
  const html = "<!doctype html><html><body><h1>Events</h1></body></html>";

  function fakeFetch(response: Response): typeof fetch {
    return (async () => response) as unknown as typeof fetch;
  }

  it("returns the decoded body and the final URL", async () => {
    const response = new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(response, "url", { value: "https://example.com/events/" });
    const page = await fetchPage("https://example.com/events", { fetchImpl: fakeFetch(response) });
    assert.equal(page.html, html);
    assert.equal(page.url, "https://example.com/events/");
  });

  it("explains a 404 in terms of the address", async () => {
    const response = new Response("nope", { status: 404, statusText: "Not Found" });
    await assert.rejects(
      fetchPage("https://example.com/missing", { fetchImpl: fakeFetch(response) }),
      (err: UserFacingError) => {
        assert.match(err.message, /returned HTTP 404/);
        assert.match(err.hint!, /does not exist/);
        return true;
      },
    );
  });

  it("explains a refused request", async () => {
    const response = new Response("no", { status: 403, statusText: "Forbidden" });
    await assert.rejects(
      fetchPage("https://example.com/events", { fetchImpl: fakeFetch(response) }),
      (err: UserFacingError) => {
        assert.match(err.hint!, /refused the request/);
        return true;
      },
    );
  });

  it("refuses a response that is not a web page", async () => {
    const response = new Response("%PDF-1.7", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
    await assert.rejects(
      fetchPage("https://example.com/flyer.pdf", { fetchImpl: fakeFetch(response) }),
      /is application\/pdf, not an HTML page/,
    );
  });

  it("reports an unreachable host without a stack trace", async () => {
    const failing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND nowhere.invalid");
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchPage("https://nowhere.invalid/events", { fetchImpl: failing }),
      (err: UserFacingError) => {
        assert.equal(err.name, "UserFacingError");
        assert.match(err.message, /Could not reach nowhere\.invalid/);
        return true;
      },
    );
  });

  it("reports a timeout as a timeout", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    await assert.rejects(
      fetchPage("https://slow.example/events", { fetchImpl: hanging, timeoutMs: 10 }),
      /Timed out fetching slow\.example/,
    );
  });
});

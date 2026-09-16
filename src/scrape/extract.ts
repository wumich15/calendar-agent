/**
 * Event extraction from HTML.
 *
 * Page content is untrusted data: everything here reads values out of the
 * document and copies them into plain objects. Nothing from a page is ever
 * evaluated, executed, or interpreted as a command.
 */

import { parse, type HTMLElement } from "node-html-parser";
import type { ExtractedEvent } from "../types.ts";
import { looksAllDay, parseDateValue, parseTimeRange } from "./datetext.ts";

export type ExtractionResult = {
  events: ExtractedEvent[];
  /** True when the page appears to render its content with client-side JavaScript. */
  needsJavaScript: boolean;
  /** Which extractors produced results, for the summary line. */
  sources: string[];
};

const EVENT_TYPE_RE = /(^|[/#:])([A-Za-z]*Event|Festival|Hackathon|CourseInstance|ScreeningEvent)$/;

function isEventType(type: unknown): boolean {
  const list = Array.isArray(type) ? type : [type];
  return list.some((t) => typeof t === "string" && EVENT_TYPE_RE.test(t.trim()));
}

function text(node: HTMLElement | null | undefined): string | undefined {
  if (!node) return undefined;
  const value = node.textContent?.replace(/\s+/g, " ").trim();
  return value ? value : undefined;
}

function clean(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

function absoluteUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- JSON-LD

type JsonValue = unknown;

function collectJsonLdEvents(node: JsonValue, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 12 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdEvents(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (isEventType(obj["@type"])) out.push(obj);
  // Events often hang off @graph, itemListElement, subEvent, or a mainEntity.
  for (const key of ["@graph", "itemListElement", "subEvent", "subEvents", "mainEntity", "item", "events"]) {
    if (key in obj) collectJsonLdEvents(obj[key], out, depth + 1);
  }
}

function formatAddress(address: unknown): string | undefined {
  if (typeof address === "string") return clean(address);
  if (!address || typeof address !== "object") return undefined;
  const a = address as Record<string, unknown>;
  const pieces = [
    clean(a.streetAddress),
    clean(a.addressLocality),
    [clean(a.addressRegion), clean(a.postalCode)].filter(Boolean).join(" ") || undefined,
    clean(typeof a.addressCountry === "object"
      ? (a.addressCountry as Record<string, unknown>).name
      : a.addressCountry),
  ].filter(Boolean);
  return pieces.length ? pieces.join(", ") : undefined;
}

function formatLocation(location: unknown): string | undefined {
  if (Array.isArray(location)) {
    const parts = location.map(formatLocation).filter(Boolean);
    return parts.length ? parts.join("; ") : undefined;
  }
  if (typeof location === "string") return clean(location);
  if (!location || typeof location !== "object") return undefined;
  const loc = location as Record<string, unknown>;
  const name = clean(loc.name);
  const address = formatAddress(loc.address);
  const url = clean(loc.url); // VirtualLocation carries only a url.
  const parts = [name, address].filter(Boolean);
  if (parts.length) return parts.join(", ");
  return url;
}

function jsonLdToEvent(obj: Record<string, unknown>, sourceUrl: string): ExtractedEvent | null {
  const name = clean(obj.name) ?? clean(obj.headline);
  let startRaw = clean(obj.startDate);
  let endRaw = clean(obj.endDate);

  // schema.org Schedule, used by some listing plugins.
  const schedule = obj.eventSchedule as Record<string, unknown> | undefined;
  if (!startRaw && schedule && typeof schedule === "object") {
    const date = clean(schedule.startDate);
    const time = clean(schedule.startTime);
    if (date) startRaw = time ? `${date}T${time}` : date;
    const endDate = clean(schedule.endDate) ?? date;
    const endTime = clean(schedule.endTime);
    if (endDate && endTime) endRaw = `${endDate}T${endTime}`;
  }

  if (!name && !startRaw) return null;

  const identifier = clean(obj.identifier) ?? clean(obj["@id"]);
  return {
    name,
    startRaw,
    endRaw,
    // Left undefined unless the page says so; a date-only startDate is treated
    // as all-day later, during normalization.
    allDay: obj.allDay === true || looksAllDay(clean(obj.eventStatus)) ? true : undefined,
    timeZone: clean((obj as Record<string, unknown>).timeZone),
    location: formatLocation(obj.location),
    description: clean(obj.description),
    url: absoluteUrl(clean(obj.url), sourceUrl),
    sourceId: identifier,
    via: "json-ld",
  };
}

export function extractJsonLd(root: HTMLElement, sourceUrl: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    let data: JsonValue;
    try {
      data = JSON.parse(raw);
    } catch {
      // Some sites emit JSON-LD with trailing commas or HTML comments around it.
      try {
        data = JSON.parse(raw.replace(/^<!--/, "").replace(/-->$/, "").replace(/,\s*([}\]])/g, "$1"));
      } catch {
        continue;
      }
    }
    const found: Record<string, unknown>[] = [];
    collectJsonLdEvents(data, found);
    for (const obj of found) {
      const event = jsonLdToEvent(obj, sourceUrl);
      if (event) events.push(event);
    }
  }
  return events;
}

// -------------------------------------------------------------- Microdata

function itempropValue(el: HTMLElement, base: string): string | undefined {
  const tag = el.tagName?.toLowerCase();
  if (tag === "meta") return clean(el.getAttribute("content"));
  if (tag === "time") return clean(el.getAttribute("datetime")) ?? text(el);
  if (tag === "data") return clean(el.getAttribute("value")) ?? text(el);
  if (tag === "a" || tag === "link" || tag === "area") {
    const href = el.getAttribute("href");
    return absoluteUrl(clean(href), base) ?? text(el);
  }
  if (tag === "img" || tag === "audio" || tag === "video" || tag === "source") {
    return absoluteUrl(clean(el.getAttribute("src")), base);
  }
  if (tag === "object") return clean(el.getAttribute("data"));
  return text(el);
}

/** Direct itemprop descendants of `scope`, not crossing into a nested itemscope. */
function scopedProps(scope: HTMLElement): Map<string, HTMLElement[]> {
  const props = new Map<string, HTMLElement[]>();
  const walk = (el: HTMLElement) => {
    for (const child of el.childNodes) {
      const node = child as HTMLElement;
      if (!node.tagName) continue;
      const name = node.getAttribute?.("itemprop");
      if (name) {
        for (const key of name.split(/\s+/)) {
          const list = props.get(key) ?? [];
          list.push(node);
          props.set(key, list);
        }
      }
      // A nested itemscope owns its own properties; do not descend into it.
      if (!node.hasAttribute?.("itemscope")) walk(node);
    }
  };
  walk(scope);
  return props;
}

function microdataLocation(nodes: HTMLElement[] | undefined, base: string): string | undefined {
  if (!nodes?.length) return undefined;
  const node = nodes[0]!;
  if (node.hasAttribute("itemscope")) {
    const inner = scopedProps(node);
    const name = inner.get("name")?.[0] ? itempropValue(inner.get("name")![0]!, base) : undefined;
    const addressNode = inner.get("address")?.[0];
    let address: string | undefined;
    if (addressNode) {
      const addrProps = scopedProps(addressNode);
      const pieces = ["streetAddress", "addressLocality", "addressRegion", "postalCode"]
        .map((key) => {
          const el = addrProps.get(key)?.[0];
          return el ? itempropValue(el, base) : undefined;
        })
        .filter(Boolean);
      address = pieces.length ? pieces.join(", ") : text(addressNode);
    }
    const parts = [name, address].filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return itempropValue(node, base);
}

export function extractMicrodata(root: HTMLElement, sourceUrl: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];
  for (const scope of root.querySelectorAll("[itemscope][itemtype]")) {
    const itemType = scope.getAttribute("itemtype") ?? "";
    if (!isEventType(itemType)) continue;
    const props = scopedProps(scope);
    const pick = (key: string): string | undefined => {
      const el = props.get(key)?.[0];
      return el ? itempropValue(el, sourceUrl) : undefined;
    };
    const name = pick("name") ?? pick("summary");
    const startRaw = pick("startDate") ?? pick("dtstart");
    if (!name && !startRaw) continue;
    events.push({
      name,
      startRaw,
      endRaw: pick("endDate") ?? pick("dtend"),
      timeZone: pick("timeZone"),
      location: microdataLocation(props.get("location"), sourceUrl),
      description: pick("description"),
      url: pick("url"),
      sourceId: pick("identifier") ?? clean(scope.getAttribute("itemid")),
      via: "microdata",
    });
  }
  return events;
}

// ------------------------------------------------------------- hCalendar

export function extractHCalendar(root: HTMLElement, sourceUrl: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];
  for (const scope of root.querySelectorAll(".vevent, .h-event")) {
    const pickNode = (...selectors: string[]): HTMLElement | null => {
      for (const selector of selectors) {
        const found = scope.querySelector(selector);
        if (found) return found;
      }
      return null;
    };
    const dateValue = (el: HTMLElement | null): string | undefined => {
      if (!el) return undefined;
      return (
        clean(el.getAttribute("datetime")) ??
        clean(el.getAttribute("title")) ??
        clean(el.getAttribute("value")) ??
        text(el)
      );
    };
    const name = text(pickNode(".summary", ".p-name", ".p-summary"));
    const startRaw = dateValue(pickNode(".dtstart", ".dt-start"));
    if (!name && !startRaw) continue;
    const urlNode = pickNode(".url", ".u-url");
    events.push({
      name,
      startRaw,
      endRaw: dateValue(pickNode(".dtend", ".dt-end")),
      location: text(pickNode(".location", ".p-location")),
      description: text(pickNode(".description", ".p-description")),
      url: absoluteUrl(urlNode?.getAttribute("href") ?? undefined, sourceUrl),
      sourceId: clean(scope.getAttribute("id")),
      via: "hcalendar",
    });
  }
  return events;
}

// ------------------------------------------------------- Ordinary HTML

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, .event-title, .title, .event-name";
const CONTAINER_TAGS = new Set([
  "article", "li", "section", "div", "tr", "td", "aside", "figure", "main",
]);

/** Walks up from a `<time>` element to the smallest block that looks like one event. */
function eventContainer(node: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = node.parentNode as HTMLElement | null;
  let fallback: HTMLElement | null = null;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const tag = current.tagName?.toLowerCase();
    if (tag && CONTAINER_TAGS.has(tag)) {
      fallback ??= current;
      if (current.querySelector(HEADING_SELECTOR) || current.querySelector("a[href]")) {
        return current;
      }
    }
    current = current.parentNode as HTMLElement | null;
  }
  return fallback;
}

function containerName(container: HTMLElement): string | undefined {
  const heading = container.querySelector(HEADING_SELECTOR);
  const fromHeading = text(heading);
  if (fromHeading) return fromHeading;
  const link = container.querySelector("a[href]");
  const fromLink = text(link);
  if (fromLink && fromLink.length > 2) return fromLink;
  return undefined;
}

/**
 * Last-resort extraction from ordinary markup: find `<time>` elements, treat the
 * block around each as one event, and read a title, location, and description
 * out of it. Only runs when no structured data was found.
 */
export function extractPlainHtml(root: HTMLElement, sourceUrl: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];
  const seen = new Set<HTMLElement>();
  const timeNodes = root.querySelectorAll("time[datetime], time");

  for (const node of timeNodes) {
    const container = eventContainer(node);
    if (!container || seen.has(container)) continue;
    seen.add(container);

    const times = container.querySelectorAll("time");
    const values = times
      .map((t) => clean(t.getAttribute("datetime")) ?? text(t))
      .filter((v): v is string => Boolean(v));
    if (!values.length) continue;

    const name = containerName(container);
    if (!name) continue;

    const body = text(container) ?? "";
    const locationNode = container.querySelector(
      ".location, .venue, .event-location, [class*='location'], [class*='venue']",
    );
    const descriptionNode = container.querySelector(
      ".description, .summary, .event-description, p",
    );
    const link = container.querySelector("a[href]");

    // A second <time> in the same block is the end; otherwise look for a range in prose.
    let startRaw = values[0]!;
    let endRaw = values[1];
    if (!endRaw) {
      const range = parseTimeRange(body);
      const startParsed = parseDateValue(startRaw);
      if (range?.end && startParsed && startParsed.kind === "datetime") {
        const p = startParsed.parts;
        const pad = (n: number) => String(n).padStart(2, "0");
        endRaw = `${pad(p.year)}-${pad(p.month)}-${pad(p.day)}T${pad(range.end.hour)}:${pad(range.end.minute)}:00`;
      } else if (range && startParsed && startParsed.kind === "date") {
        // The date came from <time> but the clock time is only in the prose.
        const p = startParsed.parts;
        const pad = (n: number) => String(n).padStart(2, "0");
        startRaw = `${pad(p.year)}-${pad(p.month)}-${pad(p.day)}T${pad(range.start.hour)}:${pad(range.start.minute)}:00`;
        if (range.end) {
          endRaw = `${pad(p.year)}-${pad(p.month)}-${pad(p.day)}T${pad(range.end.hour)}:${pad(range.end.minute)}:00`;
        }
      }
    }

    events.push({
      name,
      startRaw,
      endRaw,
      allDay: looksAllDay(body) || undefined,
      location: text(locationNode),
      description: text(descriptionNode),
      url: absoluteUrl(link?.getAttribute("href") ?? undefined, sourceUrl),
      via: "html",
    });
  }
  return events;
}

// ---------------------------------------------------------------- Driver

/** Heuristic for a page whose events only exist after client-side rendering. */
export function detectJavaScriptRendering(root: HTMLElement, html: string): boolean {
  const body = root.querySelector("body");
  const visible = (body?.textContent ?? "").replace(/\s+/g, " ").trim();
  const noscript = /<noscript[^>]*>[\s\S]{0,400}?(enable|turn on|requires)\s+javascript/i.test(html);
  const appShell = Boolean(
    root.querySelector("#root, #app, #__next, [data-reactroot], [ng-app], [data-server-rendered]"),
  );
  const scriptHeavy = root.querySelectorAll("script").length >= 3;
  return noscript || (visible.length < 400 && (appShell || scriptHeavy));
}

export function extractEvents(html: string, sourceUrl: string): ExtractionResult {
  const root = parse(html, {
    lowerCaseTagName: false,
    comment: false,
    blockTextElements: { script: true, noscript: true, style: false, pre: true },
  });

  const sources: string[] = [];
  const events: ExtractedEvent[] = [];

  const jsonLd = extractJsonLd(root, sourceUrl);
  if (jsonLd.length) {
    sources.push("JSON-LD");
    events.push(...jsonLd);
  }

  const microdata = extractMicrodata(root, sourceUrl);
  if (microdata.length) {
    sources.push("microdata");
    events.push(...microdata);
  }

  const hcal = extractHCalendar(root, sourceUrl);
  if (hcal.length) {
    sources.push("hCalendar");
    events.push(...hcal);
  }

  // Ordinary markup is noisier than structured data, so only fall back to it.
  if (!events.length) {
    const plain = extractPlainHtml(root, sourceUrl);
    if (plain.length) {
      sources.push("HTML");
      events.push(...plain);
    }
  }

  return {
    events,
    needsJavaScript: events.length === 0 && detectJavaScriptRendering(root, html),
    sources,
  };
}

/**
 * Frame rendering. Every function here is pure: it takes a `Frame` and returns
 * the lines to draw, so the layout can be tested without a terminal.
 */

import { ansi, displayWidth, padEndAnsi, truncateAnsi } from "./screen.ts";
import { formatEventTimes, type DisplayEvent, type ViewMode } from "./model.ts";
import {
  FIELD_LABELS,
  FIELD_ORDER,
  type ChangeScope,
  type DraftStore,
  type EditableFields,
  type FieldName,
  type ValidationIssue,
} from "./draft.ts";
import { formatPlainDate, formatPlainDateShort } from "../util/datetime.ts";

export type EditorMode = "normal" | "insert" | "command";

export type StatusKind = "info" | "error" | "warn" | "success";

export type Overlay =
  | { kind: "help" }
  | { kind: "details"; event: DisplayEvent }
  | {
      kind: "edit";
      fields: EditableFields;
      field: FieldName;
      cursor: number;
      issues: ValidationIssue[];
      scope: ChangeScope;
      recurring: boolean;
      eventName: string;
    }
  | { kind: "scope"; action: "edit" | "delete"; eventName: string; occurrenceWhen: string }
  | { kind: "report"; title: string; lines: string[] };

export type Frame = {
  columns: number;
  rows: number;
  calendarName: string;
  account?: string;
  timeZone: string;
  calendarWritable: boolean;
  view: ViewMode;
  anchorDate: string;
  days: string[];
  today: string;
  items: DisplayEvent[];
  selectedIndex: number;
  mode: EditorMode;
  commandLine: string;
  pendingKeys: string;
  drafts: DraftStore;
  loading: string | null;
  status: { text: string; kind: StatusKind } | null;
  overlay: Overlay | null;
  /** How far the open overlay is scrolled, in lines. */
  overlayScroll: number;
};

const STATUS_COLOR: Record<StatusKind, string> = {
  info: ansi.cyan,
  error: ansi.red,
  warn: ansi.yellow,
  success: ansi.green,
};

const SPINNER = ["|", "/", "-", "\\"];

function rule(width: number): string {
  return ansi.gray + "-".repeat(Math.max(width, 0)) + ansi.reset;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!line.length) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    if (line.length) out.push(line);
  }
  return out;
}

/** Two-character flag column: pending state, recurrence, overlap, read-only. */
function stateMarker(item: DisplayEvent): string {
  if (item.state === "deleted") return `${ansi.red}x ${ansi.reset}`;
  if (item.state === "edited") return `${ansi.yellow}* ${ansi.reset}`;
  if (item.readOnly) return `${ansi.gray}# ${ansi.reset}`;
  return "  ";
}

function trailingMarks(item: DisplayEvent): string {
  const marks: string[] = [];
  if (item.recurring) marks.push(`${ansi.magenta}(r)${ansi.reset}`);
  if (item.overlapping) marks.push(`${ansi.yellow}(overlap)${ansi.reset}`);
  return marks.length ? ` ${marks.join(" ")}` : "";
}

function eventRow(item: DisplayEvent, selected: boolean, timeZone: string, width: number): string {
  const cursor = selected ? `${ansi.cyan}>${ansi.reset}` : " ";
  const time = padEndAnsi(formatEventTimes(item.shown, timeZone), 13);
  const marks = trailingMarks(item);
  const locationText = item.shown.location ? ` @ ${item.shown.location}` : "";

  const fixed = 1 + 1 + 2 + 13 + 1;
  const flexible = Math.max(width - fixed - displayWidth(marks), 10);
  const titleWidth = locationText ? Math.max(Math.floor(flexible * 0.6), 12) : flexible;
  let title = truncateAnsi(item.shown.summary || "(no title)", titleWidth);
  if (item.state === "deleted") title = `${ansi.dim}${title} [deleted]${ansi.reset}`;
  else if (item.state === "edited") title = `${ansi.yellow}${title}${ansi.reset}`;
  else if (selected) title = `${ansi.bold}${title}${ansi.reset}`;

  const location = locationText
    ? `${ansi.gray}${truncateAnsi(locationText, Math.max(flexible - titleWidth, 0))}${ansi.reset}`
    : "";

  const body = `${stateMarker(item)}${ansi.gray}${time}${ansi.reset}${padEndAnsi(title, titleWidth)}${location}${marks}`;
  return selected ? ` ${cursor}${ansi.reverse}${padEndAnsi(body, width - 2)}${ansi.reset}` : ` ${cursor}${body}`;
}

/** The compact week strip shown above the list in weekly view. */
function weekStrip(frame: Frame, width: number): string {
  const counts = new Map<string, number>();
  for (const item of frame.items) counts.set(item.dayKey, (counts.get(item.dayKey) ?? 0) + 1);
  const cellWidth = Math.max(Math.floor((width - 2) / 7), 8);
  const cells = frame.days.map((day) => {
    const count = counts.get(day) ?? 0;
    const label = `${formatPlainDateShort(day)} ${count ? `(${count})` : "  "}`;
    const text = padEndAnsi(label, cellWidth - 1);
    if (day === frame.today) return `${ansi.green}${ansi.bold}${text}${ansi.reset}`;
    if (day === frame.anchorDate) return `${ansi.cyan}${text}${ansi.reset}`;
    return `${ansi.gray}${text}${ansi.reset}`;
  });
  return ` ${cells.join(" ")}`;
}

/** Builds the scrollable body, plus a map from item index to its line. */
function buildBody(frame: Frame, width: number): { lines: string[]; lineOfItem: number[] } {
  const lines: string[] = [];
  const lineOfItem: number[] = new Array(frame.items.length).fill(-1);

  if (frame.view === "week") {
    lines.push(weekStrip(frame, width));
    lines.push(rule(width));
  }

  for (const day of frame.days) {
    const dayItems = frame.items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => item.dayKey === day);

    if (frame.view === "week") {
      const isToday = day === frame.today;
      const heading = `${formatPlainDate(day)}${isToday ? "  (today)" : ""}`;
      lines.push(
        isToday
          ? `${ansi.green}${ansi.bold}${heading}${ansi.reset}`
          : `${ansi.bold}${heading}${ansi.reset}`,
      );
    }

    if (!dayItems.length) {
      lines.push(`   ${ansi.gray}no events${ansi.reset}`);
    } else {
      let sawTimed = false;
      for (const { item, i } of dayItems) {
        // A blank divider between the all-day block and the timed block.
        if (!item.shown.allDay && !sawTimed && lines.length && dayItems[0]!.item.shown.allDay) {
          lines.push("");
          sawTimed = true;
        }
        lineOfItem[i] = lines.length;
        lines.push(eventRow(item, i === frame.selectedIndex, frame.timeZone, width));
      }
    }
    if (frame.view === "week") lines.push("");
  }

  return { lines, lineOfItem };
}

function windowAt(lines: string[], offset: number, height: number): string[] {
  if (lines.length <= height) return lines;
  const clamped = Math.max(0, Math.min(offset, lines.length - height));
  const window = lines.slice(clamped, clamped + height);
  if (clamped > 0) {
    window[0] = `${ansi.gray}   ^ ${clamped} more above (k scrolls up)${ansi.reset}`;
  }
  const below = lines.length - clamped - height;
  if (below > 0) {
    window[window.length - 1] = `${ansi.gray}   v ${below} more below (j scrolls down)${ansi.reset}`;
  }
  return window;
}

/** Windows the body so the focused line stays visible. */
function scrollWindow(lines: string[], focusLine: number, height: number): string[] {
  if (lines.length <= height) return lines;
  const offset = focusLine >= 0 ? focusLine - Math.floor(height / 2) : 0;
  return windowAt(lines, offset, height);
}

/** The number of body lines an overlay can scroll through. */
export function overlayMaxScroll(lineCount: number, height: number): number {
  return Math.max(0, lineCount - height);
}

// --------------------------------------------------------------- overlays

export const HELP_LINES: Array<[string, string]> = [
  ["j / k", "Select the next or previous event"],
  ["h / l", "Previous or next day (weekly view: week)"],
  ["g / G", "Jump to the first or last event in view"],
  ["Enter", "Show the selected event's details"],
  ["t", "Jump to today"],
  ["i", "Edit the selected event"],
  ["dd", "Stage the selected event for deletion"],
  ["u", "Undo the most recent unsaved edit or deletion"],
  ["Esc", "Leave editing or command entry, back to Normal mode"],
  [":", "Enter Command mode"],
  ["?", "Show this reference"],
  ["", ""],
  ["Tab / Shift+Tab", "Move between fields while editing"],
  ["Ctrl-J", "Insert a line break in the description field"],
  ["Space", "Toggle the all-day field while editing"],
  ["", ""],
  [":day", "Switch to daily view"],
  [":week", "Switch to weekly view"],
  [":w", "Save pending changes to Google Calendar"],
  [":wq", "Save pending changes and quit after a successful save"],
  [":q", "Quit if there are no unsaved changes"],
  [":q!", "Discard unsaved changes and quit"],
  [":refresh", "Reload events without discarding pending changes"],
  [":today", "Jump to today"],
  [":goto <date>", "Jump to a YYYY-MM-DD date"],
  [":help", "Show this reference"],
];

function renderHelp(width: number): string[] {
  const lines: string[] = [`${ansi.bold}Keyboard reference${ansi.reset}`, ""];
  for (const [keys, description] of HELP_LINES) {
    if (!keys && !description) {
      lines.push("");
      continue;
    }
    lines.push(`  ${ansi.cyan}${padEndAnsi(keys, 16)}${ansi.reset}${description}`);
  }
  lines.push("");
  lines.push(`${ansi.gray}  j/k scroll.  Press Esc or ? to close.${ansi.reset}`);
  return lines.map((line) => truncateAnsi(line, width));
}

function renderDetails(item: DisplayEvent, timeZone: string, width: number): string[] {
  const event = item.shown;
  const lines: string[] = [];
  lines.push(`${ansi.bold}${event.summary}${ansi.reset}`);
  lines.push("");
  const field = (label: string, value: string) =>
    lines.push(`  ${ansi.cyan}${padEndAnsi(`${label}:`, 14)}${ansi.reset}${value}`);

  if (event.allDay) {
    field("When", `${event.start.date} to ${event.end.date} (exclusive end, all day)`);
  } else {
    field("When", `${event.start.dateTime} to ${event.end.dateTime}`);
    field("Time zone", event.start.timeZone ?? timeZone);
  }
  if (event.location) field("Location", event.location);
  if (item.recurring) {
    field(
      "Recurring",
      item.base.recurrence?.length ? "yes (this is the series)" : "yes (this occurrence)",
    );
  }
  if (item.readOnly) field("Access", `${ansi.yellow}read-only${ansi.reset}`);
  if (item.state === "edited") field("Pending", `${ansi.yellow}edited, not yet saved${ansi.reset}`);
  if (item.state === "deleted") field("Pending", `${ansi.red}staged for deletion${ansi.reset}`);
  if (item.overlapping) field("Note", "overlaps another event");
  if (event.htmlLink) field("Link", event.htmlLink);

  if (event.description) {
    lines.push("");
    lines.push(`  ${ansi.cyan}Description${ansi.reset}`);
    for (const line of wrap(event.description, Math.max(width - 4, 20))) {
      lines.push(`  ${line}`);
    }
  }
  lines.push("");
  lines.push(`${ansi.gray}  Press Esc or Enter to close.${ansi.reset}`);
  return lines.map((line) => truncateAnsi(line, width));
}

function renderEdit(
  overlay: Extract<Overlay, { kind: "edit" }>,
  width: number,
  mode: EditorMode,
): { lines: string[]; cursor?: { row: number; column: number } } {
  const labelWidth = 14;
  const lines: string[] = [];
  lines.push(
    `${ansi.bold}Editing:${ansi.reset} ${overlay.eventName}` +
      (overlay.recurring
        ? `  ${ansi.magenta}[${overlay.scope === "series" ? "whole series" : "this occurrence"}]${ansi.reset}`
        : ""),
  );
  lines.push("");

  const issuesByField = new Map(overlay.issues.map((issue) => [issue.field, issue.message]));
  let cursor: { row: number; column: number } | undefined;

  for (const name of FIELD_ORDER) {
    const active = name === overlay.field;
    const disabled = overlay.fields.allDay && (name === "startTime" || name === "endTime");
    const label = padEndAnsi(`${FIELD_LABELS[name]}:`, labelWidth);
    let value: string;
    if (name === "allDay") {
      value = overlay.fields.allDay ? "[x] yes  (Space toggles)" : "[ ] no   (Space toggles)";
    } else if (disabled) {
      value = `${ansi.gray}(not used for all-day events)${ansi.reset}`;
    } else {
      // Newlines are kept in the value but drawn as a marker on one line.
      value = (overlay.fields[name] as string).replace(/\n/g, "¶");
    }

    const prefix = active ? `${ansi.cyan}>${ansi.reset} ` : "  ";
    const labelText = active ? `${ansi.cyan}${ansi.bold}${label}${ansi.reset}` : `${ansi.gray}${label}${ansi.reset}`;
    const valueWidth = Math.max(width - labelWidth - 4, 10);
    const shownValue = active && mode === "insert"
      ? `${ansi.underline}${padEndAnsi(truncateAnsi(value, valueWidth), Math.min(valueWidth, 40))}${ansi.reset}`
      : truncateAnsi(value, valueWidth);

    if (active && mode === "insert" && name !== "allDay" && !disabled) {
      cursor = {
        row: lines.length,
        column: 2 + labelWidth + Math.min(overlay.cursor, valueWidth),
      };
    }
    lines.push(`${prefix}${labelText}${shownValue}`);

    const issue = issuesByField.get(name);
    if (issue) lines.push(`  ${" ".repeat(labelWidth)}${ansi.red}${issue}${ansi.reset}`);
  }

  lines.push("");
  if (overlay.issues.length) {
    lines.push(`${ansi.red}  Fix the fields above before saving.${ansi.reset}`);
  }
  lines.push(
    `${ansi.gray}  Tab/Shift+Tab move fields  -  Esc keeps the draft and returns to Normal${ansi.reset}`,
  );
  if (overlay.recurring) {
    lines.push(`${ansi.gray}  Ctrl-S switches between this occurrence and the whole series.${ansi.reset}`);
  }

  // The cursor row is relative to the overlay; the caller offsets it.
  return { lines: lines.map((line) => truncateAnsi(line, width)), cursor };
}

function renderScope(
  overlay: Extract<Overlay, { kind: "scope" }>,
  width: number,
): string[] {
  const verb = overlay.action === "delete" ? "Delete" : "Edit";
  const lines = [
    `${ansi.bold}${verb} a recurring event${ansi.reset}`,
    "",
    `  ${overlay.eventName}`,
    `  ${ansi.gray}${overlay.occurrenceWhen}${ansi.reset}`,
    "",
    `  ${ansi.cyan}o${ansi.reset}  this occurrence only ${ansi.gray}(default, Enter)${ansi.reset}`,
    `  ${ansi.cyan}s${ansi.reset}  the whole series`,
    "",
    `${ansi.gray}  Esc cancels. Nothing is staged until you choose.${ansi.reset}`,
  ];
  return lines.map((line) => truncateAnsi(line, width));
}

function renderBlock(title: string, body: string[], width: number): string[] {
  const lines = [`${ansi.bold}${title}${ansi.reset}`, ""];
  for (const line of body) lines.push(`  ${line}`);
  return lines.map((line) => truncateAnsi(line, width));
}

// ------------------------------------------------------------------ frame

function headerLines(frame: Frame, width: number): string[] {
  const pending = frame.drafts.size;
  const account = frame.account ? ` ${ansi.gray}(${frame.account})${ansi.reset}` : "";
  const readOnly = frame.calendarWritable ? "" : `  ${ansi.yellow}[read-only]${ansi.reset}`;
  const left = `${ansi.bold}calman${ansi.reset}  ${frame.calendarName}${account}${readOnly}`;
  const right = `${ansi.gray}${frame.timeZone}${ansi.reset}`;
  const gap = Math.max(width - displayWidth(left) - displayWidth(right), 1);
  const line1 = `${left}${" ".repeat(gap)}${right}`;

  const rangeText =
    frame.view === "day"
      ? formatPlainDate(frame.anchorDate)
      : `${formatPlainDate(frame.days[0]!)}  ->  ${formatPlainDate(frame.days[frame.days.length - 1]!)}`;
  const isToday = frame.days.includes(frame.today);
  const rangeLabel = isToday ? `${ansi.green}${rangeText}${ansi.reset}` : rangeText;
  const viewTag = `${ansi.cyan}[${frame.view === "day" ? "DAY" : "WEEK"}]${ansi.reset}`;
  const pendingTag = pending
    ? `  ${ansi.yellow}${pending} unsaved change${pending === 1 ? "" : "s"}${ansi.reset}`
    : "";
  const right2 = `${viewTag}${pendingTag}`;
  const gap2 = Math.max(width - displayWidth(rangeLabel) - displayWidth(right2), 1);
  const line2 = `${rangeLabel}${" ".repeat(gap2)}${right2}`;

  return [line1, line2];
}

function footerLines(frame: Frame, width: number, spinnerTick: number): string[] {
  const modeLabel =
    frame.mode === "normal" ? "NORMAL" : frame.mode === "insert" ? "INSERT" : "COMMAND";
  const modeColor =
    frame.mode === "normal" ? ansi.bgBlue : frame.mode === "insert" ? ansi.green : ansi.magenta;
  const hints =
    frame.mode === "insert"
      ? "Tab next field  Esc normal  :w saves"
      : frame.mode === "command"
        ? "Enter runs  Esc cancels"
        : "j/k select  h/l move  i edit  dd delete  u undo  :w save  ? help";

  const pendingKeys = frame.pendingKeys ? `  ${ansi.yellow}${frame.pendingKeys}${ansi.reset}` : "";
  const modeBar = `${modeColor}${ansi.bold} ${modeLabel} ${ansi.reset}${pendingKeys}  ${ansi.gray}${hints}${ansi.reset}`;

  let statusBar: string;
  if (frame.mode === "command") {
    statusBar = `${ansi.bold}:${frame.commandLine}${ansi.reset}`;
  } else if (frame.loading) {
    statusBar = `${ansi.cyan}${SPINNER[spinnerTick % SPINNER.length]} ${frame.loading}${ansi.reset}`;
  } else if (frame.status) {
    statusBar = `${STATUS_COLOR[frame.status.kind]}${frame.status.text}${ansi.reset}`;
  } else if (!frame.items.length) {
    statusBar = `${ansi.gray}No events in this range. h/l move, t returns to today.${ansi.reset}`;
  } else {
    statusBar = `${ansi.gray}${frame.selectedIndex + 1} of ${frame.items.length}${ansi.reset}`;
  }

  return [truncateAnsi(modeBar, width), truncateAnsi(statusBar, width)];
}

export function renderFrame(
  frame: Frame,
  spinnerTick = 0,
): { lines: string[]; cursor?: { row: number; column: number } } {
  const width = frame.columns;
  const header = headerLines(frame, width);
  const footer = footerLines(frame, width, spinnerTick);
  const chromeHeight = header.length + 1 + footer.length;
  const bodyHeight = Math.max(frame.rows - chromeHeight, 3);

  let body: string[];
  let cursor: { row: number; column: number } | undefined;

  if (frame.overlay?.kind === "help") {
    body = windowAt(renderHelp(width), frame.overlayScroll, bodyHeight);
  } else if (frame.overlay?.kind === "details") {
    body = windowAt(
      renderDetails(frame.overlay.event, frame.timeZone, width),
      frame.overlayScroll,
      bodyHeight,
    );
  } else if (frame.overlay?.kind === "edit") {
    const rendered = renderEdit(frame.overlay, width, frame.mode);
    body = rendered.lines.slice(0, bodyHeight);
    if (rendered.cursor && rendered.cursor.row < bodyHeight) {
      cursor = {
        row: rendered.cursor.row + header.length + 1,
        column: rendered.cursor.column,
      };
    }
  } else if (frame.overlay?.kind === "scope") {
    body = renderScope(frame.overlay, width).slice(0, bodyHeight);
  } else if (frame.overlay?.kind === "report") {
    body = windowAt(
      renderBlock(frame.overlay.title, frame.overlay.lines, width),
      frame.overlayScroll,
      bodyHeight,
    );
  } else {
    const { lines, lineOfItem } = buildBody(frame, width);
    const focus = lineOfItem[frame.selectedIndex] ?? -1;
    body = scrollWindow(lines, focus, bodyHeight);
  }

  while (body.length < bodyHeight) body.push("");

  return { lines: [...header, rule(width), ...body, ...footer], cursor };
}

/**
 * The interactive calendar manager.
 *
 * Holds all view state, drives loading, and routes keys through the Normal,
 * Insert/Edit, and Command modes. Rendering lives in `render.ts` and the
 * unsaved-change model in `draft.ts`; this module is the state machine that
 * connects them.
 */

import type { CalendarClient } from "../calendar/client.ts";
import { explainApiError } from "../calendar/client.ts";
import type { CalendarEvent } from "../types.ts";
import {
  addPlainDays,
  isPlainDate,
  startOfDayInstant,
  todayInZone,
  toPlainDate,
} from "../util/datetime.ts";
import {
  DraftStore,
  FIELD_ORDER,
  fieldsDiffer,
  fieldsFromEvent,
  validateFields,
  type ChangeScope,
  type EditableFields,
  type FieldName,
  type ValidationIssue,
} from "./draft.ts";
import { isPrintable, type Key } from "./keys.ts";
import { buildDisplayEvents, formatEventTimes, visibleRange, type DisplayEvent, type ViewMode } from "./model.ts";
import { renderFrame, type EditorMode, type Frame, type Overlay, type StatusKind } from "./render.ts";
import { describeSave, savePending } from "./save.ts";
import { Screen } from "./screen.ts";

export type AppOptions = {
  client: CalendarClient;
  calendarId: string;
  calendarName: string;
  timeZone: string;
  calendarWritable: boolean;
  account?: string;
  initialView?: ViewMode;
  /** Date to open on, as YYYY-MM-DD. Defaults to today. */
  initialDate?: string;
  weekStartsOn?: number;
  screen?: Screen;
  now?: () => Date;
};

type EditState = {
  eventId: string;
  eventName: string;
  fields: EditableFields;
  field: FieldName;
  cursor: number;
  issues: ValidationIssue[];
  scope: ChangeScope;
  recurring: boolean;
};

type PendingScope = { action: "edit" | "delete"; eventId: string };

export class App {
  readonly #options: AppOptions;
  readonly #screen: Screen;
  readonly #drafts = new DraftStore();
  /** Every event we have loaded, kept across range changes so drafts stay valid. */
  readonly #baseEvents = new Map<string, CalendarEvent>();

  #view: ViewMode;
  #anchorDate: string;
  #events: CalendarEvent[] = [];
  #items: DisplayEvent[] = [];
  #selectedIndex = 0;
  #mode: EditorMode = "normal";
  #commandLine = "";
  #pendingKeys = "";
  #overlay: Overlay | null = null;
  #overlayScroll = 0;
  #edit: EditState | null = null;
  #pendingScope: PendingScope | null = null;
  #status: { text: string; kind: StatusKind } | null = null;
  #loading: string | null = null;
  #loadToken = 0;
  #abort: AbortController | null = null;
  #spinnerTimer: NodeJS.Timeout | null = null;
  #spinnerTick = 0;
  #exitCode: number | null = null;
  #resolveExit: ((code: number) => void) | null = null;
  #ctrlCArmed = false;

  constructor(options: AppOptions) {
    this.#options = options;
    this.#screen = options.screen ?? new Screen();
    this.#view = options.initialView ?? "day";
    this.#anchorDate =
      options.initialDate ?? todayInZone(options.timeZone, options.now?.() ?? new Date());
  }

  // ------------------------------------------------------------- lifecycle

  async run(): Promise<number> {
    this.#screen.start();
    this.#screen.onKey((key) => {
      void this.#handleKey(key);
    });
    this.#screen.onResize(() => this.#render());

    const exit = new Promise<number>((resolve) => {
      this.#resolveExit = resolve;
    });

    this.#render();
    void this.#load("initial");

    const code = await exit;
    this.#stopSpinner();
    this.#abort?.abort();
    this.#screen.stop();
    return code;
  }

  #quit(code: number): void {
    this.#exitCode = code;
    this.#resolveExit?.(code);
  }

  // ------------------------------------------------------------ rendering

  get #today(): string {
    return todayInZone(this.#options.timeZone, this.#options.now?.() ?? new Date());
  }

  #frame(): Frame {
    const { days } = visibleRange(this.#view, this.#anchorDate, this.#options.weekStartsOn ?? 0);
    return {
      columns: this.#screen.columns,
      rows: this.#screen.rows,
      calendarName: this.#options.calendarName,
      account: this.#options.account,
      timeZone: this.#options.timeZone,
      calendarWritable: this.#options.calendarWritable,
      view: this.#view,
      anchorDate: this.#anchorDate,
      days,
      today: this.#today,
      items: this.#items,
      selectedIndex: this.#selectedIndex,
      mode: this.#mode,
      commandLine: this.#commandLine,
      pendingKeys: this.#pendingKeys,
      drafts: this.#drafts,
      loading: this.#loading,
      status: this.#status,
      overlay: this.#overlay,
      overlayScroll: this.#overlayScroll,
    };
  }

  #render(): void {
    if (this.#exitCode !== null) return;
    const { lines, cursor } = renderFrame(this.#frame(), this.#spinnerTick);
    this.#screen.render(lines, cursor);
  }

  #showOverlay(overlay: Overlay | null): void {
    this.#overlay = overlay;
    this.#overlayScroll = 0;
  }

  #setStatus(text: string, kind: StatusKind = "info"): void {
    this.#status = { text, kind };
  }

  #startSpinner(label: string): void {
    this.#loading = label;
    this.#spinnerTimer ??= setInterval(() => {
      this.#spinnerTick += 1;
      this.#render();
    }, 120);
    this.#spinnerTimer.unref?.();
  }

  #stopSpinner(): void {
    this.#loading = null;
    if (this.#spinnerTimer) {
      clearInterval(this.#spinnerTimer);
      this.#spinnerTimer = null;
    }
  }

  // -------------------------------------------------------------- loading

  #rebuild(preserveId?: string): void {
    const { days } = visibleRange(this.#view, this.#anchorDate, this.#options.weekStartsOn ?? 0);
    this.#items = buildDisplayEvents({
      events: this.#events,
      drafts: this.#drafts,
      timeZone: this.#options.timeZone,
      days,
      calendarWritable: this.#options.calendarWritable,
    });
    if (preserveId) {
      const index = this.#items.findIndex((item) => item.id === preserveId);
      if (index >= 0) {
        this.#selectedIndex = index;
        return;
      }
    }
    this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#items.length - 1));
  }

  /** Fetches the visible range. Concurrent loads are superseded, not queued. */
  async #load(reason: "initial" | "range" | "refresh"): Promise<void> {
    const token = ++this.#loadToken;
    this.#abort?.abort();
    const controller = new AbortController();
    this.#abort = controller;

    const { days } = visibleRange(this.#view, this.#anchorDate, this.#options.weekStartsOn ?? 0);
    const timeZone = this.#options.timeZone;
    const timeMin = startOfDayInstant(days[0]!, timeZone);
    const timeMax = startOfDayInstant(addPlainDays(days[days.length - 1]!, 1), timeZone);
    const selectedId = this.#items[this.#selectedIndex]?.id;

    this.#startSpinner(reason === "refresh" ? "Refreshing events" : "Loading events");
    this.#render();

    try {
      const events = await this.#options.client.listEvents({
        calendarId: this.#options.calendarId,
        timeMin,
        timeMax,
        signal: controller.signal,
      });
      if (token !== this.#loadToken) return;

      const remoteChanges = this.#mergeLoaded(events);
      this.#events = events;
      this.#stopSpinner();
      this.#rebuild(selectedId);

      if (remoteChanges.length) {
        // Too much to fit on the status line, and too important to truncate.
        this.#showOverlay({
          kind: "report",
          title: "These events also changed in Google Calendar",
          lines: [
            ...remoteChanges.map((name) => `- ${name}`),
            "",
            "Your unsaved changes were kept, not discarded. Saving one of these will",
            "report a conflict rather than overwrite the newer version, so review the",
            "event first and undo your change with u if the remote version is right.",
            "",
            "Press Esc to close.",
          ],
        });
        this.#setStatus(
          `Reloaded. ${remoteChanges.length} drafted event${remoteChanges.length === 1 ? "" : "s"} changed remotely; drafts were kept.`,
          "warn",
        );
      } else if (reason === "refresh") {
        this.#setStatus(
          this.#drafts.hasChanges
            ? `Reloaded. ${this.#drafts.size} unsaved change${this.#drafts.size === 1 ? "" : "s"} kept.`
            : "Reloaded.",
          "success",
        );
      } else {
        this.#status = null;
      }
    } catch (err) {
      if (token !== this.#loadToken || (err as Error)?.name === "AbortError") return;
      this.#stopSpinner();
      this.#setStatus(`Could not load events: ${explainApiError(err)}`, "error");
    }
    this.#render();
  }

  /**
   * Updates the stored base copies from a fresh load. Returns the names of
   * events that changed remotely while a local draft was pending, so the user is
   * told instead of having the conflict discovered only at save time.
   */
  #mergeLoaded(events: CalendarEvent[]): string[] {
    const conflicts: string[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      seen.add(event.id);
      const previous = this.#baseEvents.get(event.id);
      if (previous && this.#drafts.get(event.id) && previous.etag && previous.etag !== event.etag) {
        conflicts.push(event.summary);
      }
      this.#baseEvents.set(event.id, event);
    }
    // An event with a pending change that vanished remotely is also a conflict.
    for (const change of this.#drafts.all()) {
      const base = this.#baseEvents.get(change.eventId);
      if (!base) continue;
      const inRange = this.#eventInLoadedRange(base);
      if (inRange && !seen.has(change.eventId)) conflicts.push(`${base.summary} (removed remotely)`);
    }
    return conflicts;
  }

  #eventInLoadedRange(event: CalendarEvent): boolean {
    const { days } = visibleRange(this.#view, this.#anchorDate, this.#options.weekStartsOn ?? 0);
    const timeZone = this.#options.timeZone;
    const start = event.start.date ?? toPlainDate(new Date(event.start.dateTime ?? ""), timeZone);
    return days.includes(start);
  }

  // ---------------------------------------------------------- key routing

  async #handleKey(key: Key): Promise<void> {
    if (this.#exitCode !== null) return;

    if (key.ctrl && key.name === "c") {
      this.#handleCtrlC();
      this.#render();
      return;
    }
    this.#ctrlCArmed = false;

    try {
      if (this.#overlay?.kind === "scope") this.#handleScopeKey(key);
      else if (this.#mode === "command") await this.#handleCommandKey(key);
      else if (this.#mode === "insert") this.#handleInsertKey(key);
      else if (
        this.#overlay?.kind === "help" ||
        this.#overlay?.kind === "details" ||
        this.#overlay?.kind === "report"
      ) {
        this.#handleOverlayKey(key);
      } else {
        await this.#handleNormalKey(key);
      }
    } catch (err) {
      this.#setStatus(explainApiError(err), "error");
    }
    this.#render();
  }

  #handleCtrlC(): void {
    if (!this.#drafts.hasChanges || this.#ctrlCArmed) {
      this.#quit(this.#drafts.hasChanges ? 1 : 0);
      return;
    }
    this.#ctrlCArmed = true;
    this.#setStatus(
      `${this.#drafts.size} unsaved change${this.#drafts.size === 1 ? "" : "s"}. Press Ctrl-C again to discard and quit, or use :w to save.`,
      "warn",
    );
  }

  #handleOverlayKey(key: Key): void {
    switch (key.name) {
      case "escape":
      case "enter":
      case "q":
      case "?":
        this.#showOverlay(null);
        return;
      case "j":
      case "down":
        this.#overlayScroll += 1;
        return;
      case "k":
      case "up":
        this.#overlayScroll = Math.max(0, this.#overlayScroll - 1);
        return;
      case "pagedown":
      case "space":
        this.#overlayScroll += Math.max(this.#screen.rows - 8, 1);
        return;
      case "pageup":
        this.#overlayScroll = Math.max(0, this.#overlayScroll - Math.max(this.#screen.rows - 8, 1));
        return;
      case "g":
        this.#overlayScroll = 0;
        return;
      default:
        return;
    }
  }

  #handleScopeKey(key: Key): void {
    const pending = this.#pendingScope;
    if (!pending) {
      this.#showOverlay(null);
      return;
    }
    if (key.name === "escape") {
      this.#showOverlay(null);
      this.#pendingScope = null;
      this.#setStatus("Cancelled. Nothing was staged.", "info");
      return;
    }
    let scope: ChangeScope | null = null;
    if (key.name === "o" || key.name === "enter") scope = "occurrence";
    else if (key.name === "s") scope = "series";
    if (!scope) return;

    this.#showOverlay(null);
    this.#pendingScope = null;
    if (pending.action === "delete") this.#stageDelete(pending.eventId, scope);
    else this.#openEditor(pending.eventId, scope);
  }

  // ----------------------------------------------------------- normal mode

  get #selected(): DisplayEvent | undefined {
    return this.#items[this.#selectedIndex];
  }

  async #handleNormalKey(key: Key): Promise<void> {
    // `dd` is the only two-key sequence; any other key cancels a pending `d`.
    if (this.#pendingKeys === "d") {
      this.#pendingKeys = "";
      if (key.name === "d") {
        this.#requestDelete();
        return;
      }
      if (key.name === "escape") return;
    }

    switch (key.name) {
      case "j":
      case "down":
        this.#move(1);
        return;
      case "k":
      case "up":
        this.#move(-1);
        return;
      case "h":
      case "left":
        this.#shiftRange(-1);
        return;
      case "l":
      case "right":
        this.#shiftRange(1);
        return;
      case "g":
        this.#selectedIndex = 0;
        return;
      case "G":
        this.#selectedIndex = Math.max(this.#items.length - 1, 0);
        return;
      case "t":
        this.#goToday();
        return;
      case "enter":
        if (this.#selected) this.#showOverlay({ kind: "details", event: this.#selected });
        else this.#setStatus("No event selected.", "warn");
        return;
      case "i":
        this.#requestEdit();
        return;
      case "d":
        this.#pendingKeys = "d";
        return;
      case "u":
        this.#undo();
        return;
      case "?":
        this.#showOverlay({ kind: "help" });
        return;
      case ":":
        this.#mode = "command";
        this.#commandLine = "";
        this.#status = null;
        return;
      case "escape":
        this.#showOverlay(null);
        this.#pendingKeys = "";
        this.#status = null;
        return;
      default:
        return;
    }
  }

  #move(delta: number): void {
    if (!this.#items.length) return;
    this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex + delta, this.#items.length - 1));
  }

  #shiftRange(direction: number): void {
    const step = this.#view === "day" ? 1 : 7;
    this.#anchorDate = addPlainDays(this.#anchorDate, direction * step);
    this.#selectedIndex = 0;
    this.#rebuild();
    void this.#load("range");
  }

  #goToday(): void {
    this.#anchorDate = this.#today;
    this.#selectedIndex = 0;
    this.#rebuild();
    void this.#load("range");
  }

  #undo(): void {
    const label = this.#drafts.undo();
    if (!label) {
      this.#setStatus("Nothing to undo.", "warn");
      return;
    }
    const selectedId = this.#selected?.id;
    this.#rebuild(selectedId);
    this.#setStatus(`Undid: ${label}`, "success");
  }

  // ------------------------------------------------- staging edits/deletes

  #guardWritable(item: DisplayEvent): boolean {
    if (!this.#options.calendarWritable) {
      this.#setStatus(
        `${this.#options.calendarName} is read-only for your account, so events here cannot be changed.`,
        "error",
      );
      return false;
    }
    if (item.readOnly) {
      this.#setStatus(
        `"${item.shown.summary}" is read-only for your account. You can view it but not change it.`,
        "error",
      );
      return false;
    }
    return true;
  }

  #requestDelete(): void {
    const item = this.#selected;
    if (!item) {
      this.#setStatus("No event selected.", "warn");
      return;
    }
    if (!this.#guardWritable(item)) return;
    if (item.recurring) {
      this.#pendingScope = { action: "delete", eventId: item.id };
      this.#showOverlay({
        kind: "scope",
        action: "delete",
        eventName: item.shown.summary,
        occurrenceWhen: `${item.dayKey}  ${formatEventTimes(item.shown, this.#options.timeZone)}`,
      });
      return;
    }
    this.#stageDelete(item.id, "occurrence");
  }

  #stageDelete(eventId: string, scope: ChangeScope): void {
    const base = this.#baseEvents.get(eventId);
    const name = base?.summary ?? eventId;
    this.#drafts.stageDelete(eventId, scope, `delete ${name}`);
    this.#rebuild(eventId);
    this.#setStatus(
      `Staged deletion of "${name}"${scope === "series" ? " (whole series)" : ""}. Nothing is deleted until :w. Press u to undo.`,
      "warn",
    );
  }

  #requestEdit(): void {
    const item = this.#selected;
    if (!item) {
      this.#setStatus("No event selected.", "warn");
      return;
    }
    if (!this.#guardWritable(item)) return;
    const existing = this.#drafts.get(item.id);
    if (item.recurring && existing?.kind !== "edit") {
      this.#pendingScope = { action: "edit", eventId: item.id };
      this.#showOverlay({
        kind: "scope",
        action: "edit",
        eventName: item.shown.summary,
        occurrenceWhen: `${item.dayKey}  ${formatEventTimes(item.shown, this.#options.timeZone)}`,
      });
      return;
    }
    this.#openEditor(item.id, existing?.kind === "edit" ? existing.scope : "occurrence");
  }

  #openEditor(eventId: string, scope: ChangeScope): void {
    const base = this.#baseEvents.get(eventId);
    if (!base) {
      this.#setStatus("That event is no longer loaded. Run :refresh.", "error");
      return;
    }
    const existing = this.#drafts.get(eventId);
    const fields =
      existing?.kind === "edit"
        ? { ...existing.fields }
        : fieldsFromEvent(base, this.#options.timeZone);
    this.#edit = {
      eventId,
      eventName: base.summary,
      fields,
      field: "summary",
      cursor: fields.summary.length,
      issues: [],
      scope,
      recurring: Boolean(base.recurringEventId || base.recurrence?.length),
    };
    this.#mode = "insert";
    this.#syncEditOverlay();
    this.#setStatus(
      "Editing locally. Tab moves between fields; Esc keeps the draft; :w saves to Google Calendar.",
      "info",
    );
  }

  #syncEditOverlay(): void {
    const edit = this.#edit;
    if (!edit) {
      this.#overlay = null;
      return;
    }
    this.#overlay = {
      kind: "edit",
      fields: edit.fields,
      field: edit.field,
      cursor: edit.cursor,
      issues: edit.issues,
      scope: edit.scope,
      recurring: edit.recurring,
      eventName: edit.eventName,
    };
  }

  // ----------------------------------------------------------- insert mode

  #editableFieldNames(): FieldName[] {
    const skipTimes = this.#edit?.fields.allDay ?? false;
    return FIELD_ORDER.filter(
      (name) => !(skipTimes && (name === "startTime" || name === "endTime")),
    );
  }

  #moveField(delta: number): void {
    const edit = this.#edit;
    if (!edit) return;
    const names = this.#editableFieldNames();
    const current = names.indexOf(edit.field);
    const next = names[(current + delta + names.length) % names.length]!;
    edit.field = next;
    const value = edit.fields[next];
    edit.cursor = typeof value === "string" ? value.length : 0;
  }

  #handleInsertKey(key: Key): void {
    const edit = this.#edit;
    if (!edit) {
      this.#mode = "normal";
      return;
    }

    if (key.name === "escape") {
      this.#closeEditor();
      return;
    }
    if (key.name === "tab") {
      this.#moveField(key.shift ? -1 : 1);
      this.#syncEditOverlay();
      return;
    }
    if (key.ctrl && key.name === "s" && edit.recurring) {
      edit.scope = edit.scope === "series" ? "occurrence" : "series";
      this.#setStatus(
        edit.scope === "series"
          ? "This edit will apply to the whole recurring series."
          : "This edit will apply to this occurrence only.",
        "info",
      );
      this.#syncEditOverlay();
      return;
    }

    if (edit.field === "allDay") {
      if (key.name === "space" || key.name === "enter" || key.char === "y" || key.char === "n") {
        const next = key.char === "y" ? true : key.char === "n" ? false : !edit.fields.allDay;
        this.#setAllDay(next);
        this.#syncEditOverlay();
        return;
      }
      if (key.name === "down" || key.name === "up") {
        this.#moveField(key.name === "down" ? 1 : -1);
        this.#syncEditOverlay();
        return;
      }
      return;
    }

    const value = edit.fields[edit.field] as string;

    switch (key.name) {
      case "enter":
        if (key.ctrl) break;
        this.#moveField(1);
        this.#syncEditOverlay();
        return;
      case "left":
        edit.cursor = Math.max(0, edit.cursor - 1);
        this.#syncEditOverlay();
        return;
      case "right":
        edit.cursor = Math.min(value.length, edit.cursor + 1);
        this.#syncEditOverlay();
        return;
      case "home":
        edit.cursor = 0;
        this.#syncEditOverlay();
        return;
      case "end":
        edit.cursor = value.length;
        this.#syncEditOverlay();
        return;
      case "up":
        this.#moveField(-1);
        this.#syncEditOverlay();
        return;
      case "down":
        this.#moveField(1);
        this.#syncEditOverlay();
        return;
      case "backspace":
        if (edit.cursor > 0) {
          edit.fields[edit.field] = value.slice(0, edit.cursor - 1) + value.slice(edit.cursor);
          edit.cursor -= 1;
        }
        this.#revalidate();
        return;
      case "delete":
        edit.fields[edit.field] = value.slice(0, edit.cursor) + value.slice(edit.cursor + 1);
        this.#revalidate();
        return;
      default:
        break;
    }

    // Ctrl-J inserts a real line break, which only makes sense in a description.
    if (key.ctrl && (key.name === "j" || key.name === "m")) {
      if (edit.field === "description") {
        edit.fields.description = `${value.slice(0, edit.cursor)}\n${value.slice(edit.cursor)}`;
        edit.cursor += 1;
        this.#revalidate();
      }
      return;
    }

    // Any printable character edits the field rather than acting as a shortcut.
    if (isPrintable(key)) {
      edit.fields[edit.field] = value.slice(0, edit.cursor) + key.char + value.slice(edit.cursor);
      edit.cursor += 1;
      this.#revalidate();
    }
  }

  #setAllDay(next: boolean): void {
    const edit = this.#edit;
    if (!edit || edit.fields.allDay === next) return;
    edit.fields.allDay = next;
    if (next) {
      // Times are not used by an all-day event, but keep them for a toggle back.
      edit.fields.startTime ||= "09:00";
      edit.fields.endTime ||= "10:00";
    } else {
      edit.fields.startTime ||= "09:00";
      edit.fields.endTime ||= "10:00";
      if (edit.fields.endDate < edit.fields.startDate) edit.fields.endDate = edit.fields.startDate;
    }
    this.#revalidate();
  }

  #revalidate(): void {
    const edit = this.#edit;
    if (!edit) return;
    edit.issues = validateFields(edit.fields);
    this.#syncEditOverlay();
  }

  /** Leaves the form, keeping the draft, as Vim's Esc does. */
  #closeEditor(): void {
    const edit = this.#edit;
    this.#mode = "normal";
    this.#overlay = null;
    this.#edit = null;
    if (!edit) return;

    const base = this.#baseEvents.get(edit.eventId);
    if (!base) return;

    const issues = validateFields(edit.fields);
    if (!fieldsDiffer(base, edit.fields, this.#options.timeZone) && !issues.length) {
      this.#setStatus("No changes to stage.", "info");
      return;
    }
    this.#drafts.stageEdit(edit.eventId, edit.fields, edit.scope, `edit ${base.summary}`);
    this.#rebuild(edit.eventId);
    if (issues.length) {
      this.#setStatus(
        `Draft kept, but ${issues.length} field${issues.length === 1 ? "" : "s"} must be fixed before saving: ${issues.map((i) => i.message).join(" ")}`,
        "error",
      );
    } else {
      this.#setStatus(
        `Staged edit to "${edit.fields.summary}"${edit.scope === "series" ? " (whole series)" : ""}. Run :w to save, u to undo.`,
        "warn",
      );
    }
  }

  // ---------------------------------------------------------- command mode

  async #handleCommandKey(key: Key): Promise<void> {
    if (key.name === "escape") {
      this.#mode = "normal";
      this.#commandLine = "";
      return;
    }
    if (key.name === "enter") {
      const command = this.#commandLine.trim();
      this.#mode = "normal";
      this.#commandLine = "";
      await this.#runCommand(command);
      return;
    }
    if (key.name === "backspace") {
      if (!this.#commandLine.length) this.#mode = "normal";
      else this.#commandLine = this.#commandLine.slice(0, -1);
      return;
    }
    if (isPrintable(key)) this.#commandLine += key.char;
  }

  async #runCommand(input: string): Promise<void> {
    const [name = "", ...args] = input.split(/\s+/);
    switch (name) {
      case "":
        return;
      case "day":
        this.#setView("day");
        return;
      case "week":
        this.#setView("week");
        return;
      case "today":
        this.#goToday();
        return;
      case "goto": {
        const date = args[0] ?? "";
        if (!isPlainDate(date)) {
          this.#setStatus("Usage: :goto YYYY-MM-DD", "error");
          return;
        }
        this.#anchorDate = date;
        this.#selectedIndex = 0;
        this.#rebuild();
        void this.#load("range");
        return;
      }
      case "refresh":
        await this.#load("refresh");
        return;
      case "w":
        await this.#save(false);
        return;
      case "wq":
        await this.#save(true);
        return;
      case "q":
        if (this.#drafts.hasChanges) {
          this.#setStatus(
            `${this.#drafts.size} unsaved change${this.#drafts.size === 1 ? "" : "s"}. Use :w to save, :q! to discard and quit.`,
            "warn",
          );
          return;
        }
        this.#quit(0);
        return;
      case "q!":
        this.#drafts.clear();
        this.#quit(0);
        return;
      case "help":
        this.#showOverlay({ kind: "help" });
        return;
      default:
        this.#setStatus(`Unknown command ":${input}". Press ? for the command list.`, "error");
    }
  }

  #setView(view: ViewMode): void {
    if (this.#view === view) {
      this.#setStatus(`Already in ${view === "day" ? "daily" : "weekly"} view.`, "info");
      return;
    }
    this.#view = view;
    // Unsaved changes live in the draft store, so switching views never loses them.
    this.#selectedIndex = 0;
    this.#rebuild();
    void this.#load("range");
  }

  // ---------------------------------------------------------------- saving

  async #save(thenQuit: boolean): Promise<void> {
    if (this.#mode === "insert") this.#closeEditor();
    if (!this.#drafts.hasChanges) {
      this.#setStatus("No unsaved changes.", "info");
      if (thenQuit) this.#quit(0);
      return;
    }

    // Validate every staged edit locally first, so a bad field never reaches Google.
    const invalid: string[] = [];
    for (const change of this.#drafts.all()) {
      if (change.kind !== "edit") continue;
      const issues = validateFields(change.fields);
      if (issues.length) {
        const name = this.#baseEvents.get(change.eventId)?.summary ?? change.eventId;
        invalid.push(`${name}: ${issues.map((i) => i.message).join(" ")}`);
      }
    }
    if (invalid.length) {
      this.#showOverlay({
        kind: "report",
        title: "Cannot save yet",
        lines: [...invalid, "", "Press i on the event to fix it, or u to undo the change."],
      });
      this.#setStatus("Nothing was saved. Fix the fields listed above.", "error");
      return;
    }

    this.#startSpinner("Saving changes");
    this.#render();

    const outcome = await savePending({
      client: this.#options.client,
      calendarId: this.#options.calendarId,
      timeZone: this.#options.timeZone,
      drafts: this.#drafts,
      baseEvents: this.#baseEvents,
      onProgress: (done, total, name) => {
        this.#startSpinner(`Saving ${done}/${total}: ${name}`);
      },
    });
    this.#stopSpinner();

    // Apply what succeeded to the local copies so the view matches the server.
    for (const updated of outcome.updated) {
      this.#baseEvents.set(updated.id, updated);
      const index = this.#events.findIndex((event) => event.id === updated.id);
      if (index >= 0) this.#events[index] = updated;
    }
    for (const id of outcome.deletedIds) {
      this.#events = this.#events.filter((event) => event.id !== id);
      this.#baseEvents.delete(id);
    }
    this.#rebuild(this.#selected?.id);

    const savedCount = outcome.succeeded.length;
    if (outcome.failed.length) {
      this.#showOverlay({
        kind: "report",
        title:
          savedCount > 0
            ? `Partly saved: ${savedCount} succeeded, ${outcome.failed.length} failed`
            : `Save failed: ${outcome.failed.length} change${outcome.failed.length === 1 ? "" : "s"}`,
        lines: describeSave(outcome),
      });
      this.#setStatus(
        thenQuit
          ? "Still open because the save did not fully succeed. Successful changes were not repeated."
          : `${outcome.failed.length} change${outcome.failed.length === 1 ? "" : "s"} still staged.`,
        "error",
      );
      return;
    }

    this.#setStatus(
      `Saved ${savedCount} change${savedCount === 1 ? "" : "s"} to ${this.#options.calendarName}.`,
      "success",
    );
    if (thenQuit) {
      this.#quit(0);
      return;
    }
    // A series-scoped change rewrites occurrences we did not patch directly, so
    // the only way to show the real result is to re-read the range.
    if (outcome.succeeded.some((entry) => entry.scope === "series")) {
      const saved = this.#status;
      await this.#load("range");
      this.#status = saved;
    }
  }
}

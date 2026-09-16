/**
 * Terminal plumbing: alternate screen, raw-mode input, resize handling, and
 * frame output. Kept free of application logic so the renderer stays testable.
 */

import { decodeKeys, type Key } from "./keys.ts";

const ESC = "";
const CSI = `${ESC}[`;

export const ansi = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  reverse: `${CSI}7m`,
  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  blue: `${CSI}34m`,
  magenta: `${CSI}35m`,
  cyan: `${CSI}36m`,
  gray: `${CSI}90m`,
  bgBlue: `${CSI}44m`,
};

/** Visible width of a string, ignoring ANSI escape sequences. */
export function displayWidth(value: string): number {
  return stripAnsi(value).length;
}

export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[0-9;]*m/g, "");
}

/** Truncates to `width` visible characters, preserving escape sequences. */
export function truncateAnsi(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < value.length && visible < width - 1) {
    if (value.startsWith(`${CSI}`, i)) {
      const end = value.indexOf("m", i);
      if (end !== -1) {
        out += value.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += value[i];
    visible += 1;
    i += 1;
  }
  return `${out}…${ansi.reset}`;
}

export function padEndAnsi(value: string, width: number): string {
  const pad = width - displayWidth(value);
  return pad > 0 ? value + " ".repeat(pad) : value;
}

export type ScreenOptions = {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

export class Screen {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  #keyHandler: ((key: Key) => void) | null = null;
  #resizeHandler: (() => void) | null = null;
  #started = false;
  #lastLineCount = 0;

  constructor(options: ScreenOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
  }

  get columns(): number {
    return Math.max(this.#output.columns ?? 80, 20);
  }

  get rows(): number {
    return Math.max(this.#output.rows ?? 24, 6);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (this.#input.isTTY) this.#input.setRawMode(true);
    this.#input.resume();
    this.#input.setEncoding("utf8");
    this.#input.on("data", this.#onData);
    this.#output.on("resize", this.#onResize);
    // Alternate screen buffer, so the user's scrollback survives the session.
    this.#output.write(`${CSI}?1049h${CSI}?25l${CSI}H${CSI}2J`);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#input.off("data", this.#onData);
    this.#output.off("resize", this.#onResize);
    if (this.#input.isTTY) this.#input.setRawMode(false);
    this.#input.pause();
    this.#output.write(`${CSI}?25h${CSI}?1049l`);
  }

  onKey(handler: (key: Key) => void): void {
    this.#keyHandler = handler;
  }

  onResize(handler: () => void): void {
    this.#resizeHandler = handler;
  }

  #onData = (chunk: string): void => {
    if (!this.#keyHandler) return;
    for (const key of decodeKeys(chunk)) this.#keyHandler(key);
  };

  #onResize = (): void => {
    this.#resizeHandler?.();
  };

  /**
   * Draws a frame. Lines are written from the top with each one cleared first,
   * then anything left from a taller previous frame is erased.
   */
  render(lines: string[], cursor?: { row: number; column: number }): void {
    const rows = this.rows;
    const visible = lines.slice(0, rows);
    let out = `${CSI}H`;
    for (const [index, line] of visible.entries()) {
      out += `${CSI}2K${truncateAnsi(line, this.columns)}`;
      if (index < visible.length - 1) out += "\r\n";
    }
    if (this.#lastLineCount > visible.length) out += `\r\n${CSI}J`;
    this.#lastLineCount = visible.length;
    if (cursor) {
      out += `${CSI}${cursor.row + 1};${cursor.column + 1}H${CSI}?25h`;
    } else {
      out += `${CSI}?25l`;
    }
    this.#output.write(out);
  }

  /** Writes a line after the alternate screen has been torn down. */
  writeLine(text: string): void {
    this.#output.write(`${text}\n`);
  }
}

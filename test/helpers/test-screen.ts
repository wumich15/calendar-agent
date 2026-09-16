/**
 * A `Screen` that captures frames instead of drawing them, and lets a test feed
 * keystrokes in as if they had been typed.
 */

import { Screen, stripAnsi } from "../../src/tui/screen.ts";
import { decodeKeys, type Key } from "../../src/tui/keys.ts";

export class TestScreen extends Screen {
  readonly frames: string[][] = [];
  #handler: ((key: Key) => void) | null = null;
  #resize: (() => void) | null = null;
  #columns = 100;
  #rows = 30;

  override get columns(): number {
    return this.#columns;
  }

  override get rows(): number {
    return this.#rows;
  }

  override start(): void {}

  override stop(): void {}

  override onKey(handler: (key: Key) => void): void {
    this.#handler = handler;
  }

  override onResize(handler: () => void): void {
    this.#resize = handler;
  }

  override render(lines: string[]): void {
    this.frames.push(lines);
  }

  /** The most recent frame, with ANSI styling removed. */
  get text(): string {
    return stripAnsi((this.frames.at(-1) ?? []).join("\n"));
  }

  /** Feeds a string of keystrokes through the same decoder the real screen uses. */
  async press(input: string): Promise<void> {
    for (const key of decodeKeys(input)) this.#handler?.(key);
    await flush();
  }

  async resizeTo(columns: number, rows: number): Promise<void> {
    this.#columns = columns;
    this.#rows = rows;
    this.#resize?.();
    await flush();
  }
}

/** Lets queued promise callbacks run, including chained async handlers. */
export async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

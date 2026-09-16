/**
 * Decoding of raw terminal input into named keys.
 *
 * `process.stdin` in raw mode hands us bytes, not keystrokes: arrows arrive as
 * escape sequences, Ctrl-C as 0x03, and a pasted string as one long chunk. This
 * module turns a chunk into a list of `Key` values the app can switch on.
 */

export type Key = {
  /** Named key such as "escape", "up", "tab", or a single printable character. */
  name: string;
  ctrl: boolean;
  shift: boolean;
  /** The printable character this key produced, if any. */
  char?: string;
};

const ESC = "";

const SIMPLE: Record<string, string> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "": "backspace",
  "": "backspace",
  " ": "space",
};

const CSI_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shift-tab",
};

const CSI_TILDE: Record<string, string> = {
  "1": "home",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

function ctrlKey(code: number): Key | null {
  if (code === 0 || code > 26) return null;
  return { name: String.fromCharCode(code + 96), ctrl: true, shift: false };
}

const CSI_RE = /^\[([0-9;]*)([A-Za-z~])/;
const SS3_RE = /^O([A-Za-z])/;

export function decodeKeys(input: string): Key[] {
  const keys: Key[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (ch === ESC) {
      const rest = input.slice(i);

      const csi = CSI_RE.exec(rest);
      if (csi) {
        const params = csi[1] ?? "";
        const final = csi[2]!;
        i += csi[0].length;
        if (final === "~") {
          const name = CSI_TILDE[params.split(";")[0] ?? ""];
          if (name) keys.push({ name, ctrl: false, shift: false });
          continue;
        }
        const name = CSI_NAMES[final];
        if (name === "shift-tab") {
          keys.push({ name: "tab", ctrl: false, shift: true });
          continue;
        }
        if (name) {
          // "1;2A" style modifiers: bit 0 is shift, bit 2 is ctrl.
          const modifier = Number(params.split(";")[1] ?? "1") - 1;
          keys.push({ name, ctrl: (modifier & 4) !== 0, shift: (modifier & 1) !== 0 });
        }
        continue;
      }

      const ss3 = SS3_RE.exec(rest);
      if (ss3) {
        i += ss3[0].length;
        const name = CSI_NAMES[ss3[1]!];
        if (name) keys.push({ name, ctrl: false, shift: false });
        continue;
      }

      // Anything else beginning with ESC is a plain Escape. A terminal also
      // sends ESC + character for Alt+key, which is indistinguishable from
      // Escape followed by a fast keystroke. calman binds no Alt shortcuts and
      // does bind Escape, so the remaining character is decoded on its own
      // rather than swallowed into a meta key.
      i += 1;
      keys.push({ name: "escape", ctrl: false, shift: false });
      continue;
    }

    const simple = SIMPLE[ch];
    if (simple) {
      i += 1;
      keys.push({
        name: simple,
        ctrl: false,
        shift: false,
        char: simple === "space" ? " " : undefined,
      });
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 32) {
      i += 1;
      const key = ctrlKey(code);
      if (key) keys.push(key);
      continue;
    }

    i += 1;
    keys.push({
      name: ch,
      ctrl: false,
      shift: ch !== ch.toLowerCase() && ch === ch.toUpperCase(),
      char: ch,
    });
  }

  return keys;
}

/** True for keys that insert text into a field. */
export function isPrintable(key: Key): boolean {
  return !key.ctrl && typeof key.char === "string" && key.char.length === 1;
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeKeys, isPrintable } from "../src/tui/keys.ts";

const ESC = "";

describe("decodeKeys", () => {
  it("decodes ordinary letters as themselves", () => {
    assert.deepEqual(decodeKeys("j").map((k) => k.name), ["j"]);
    assert.equal(decodeKeys("j")[0]!.char, "j");
  });

  it("decodes a whole pasted chunk in order", () => {
    assert.deepEqual(decodeKeys("dd").map((k) => k.name), ["d", "d"]);
    assert.deepEqual(decodeKeys(":wq\r").map((k) => k.name), [":", "w", "q", "enter"]);
  });

  it("marks capitals as shifted", () => {
    const [key] = decodeKeys("G");
    assert.equal(key!.name, "G");
    assert.equal(key!.shift, true);
  });

  it("decodes control keys", () => {
    assert.deepEqual(decodeKeys("")[0], { name: "c", ctrl: true, shift: false });
    assert.deepEqual(decodeKeys("")[0], { name: "s", ctrl: true, shift: false });
    assert.equal(decodeKeys("\t")[0]!.name, "tab");
    assert.equal(decodeKeys("")[0]!.name, "backspace");
    assert.equal(decodeKeys("\r")[0]!.name, "enter");
  });

  it("decodes arrow keys sent as CSI sequences", () => {
    assert.deepEqual(
      decodeKeys(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`).map((k) => k.name),
      ["up", "down", "right", "left"],
    );
  });

  it("decodes arrow keys sent as SS3 sequences", () => {
    assert.deepEqual(decodeKeys(`${ESC}OA`).map((k) => k.name), ["up"]);
  });

  it("decodes Shift+Tab, which terminals send as CSI Z", () => {
    const [key] = decodeKeys(`${ESC}[Z`);
    assert.equal(key!.name, "tab");
    assert.equal(key!.shift, true);
  });

  it("decodes modified arrows", () => {
    const [shifted] = decodeKeys(`${ESC}[1;2A`);
    assert.equal(shifted!.shift, true);
    const [ctrled] = decodeKeys(`${ESC}[1;5C`);
    assert.equal(ctrled!.ctrl, true);
  });

  it("decodes home, end, and page keys", () => {
    assert.deepEqual(
      decodeKeys(`${ESC}[H${ESC}[F${ESC}[5~${ESC}[6~${ESC}[3~`).map((k) => k.name),
      ["home", "end", "pageup", "pagedown", "delete"],
    );
  });

  it("decodes a bare escape as escape", () => {
    assert.deepEqual(decodeKeys(ESC).map((k) => k.name), ["escape"]);
  });

  it("does not mistake an escape sequence for the letters inside it", () => {
    // Without sequence handling, this would look like "[", "A" and move the cursor.
    const keys = decodeKeys(`${ESC}[A`);
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.name, "up");
  });

  it("decodes space with a usable character", () => {
    const [key] = decodeKeys(" ");
    assert.equal(key!.name, "space");
    assert.equal(key!.char, " ");
  });

  it("keeps non-ASCII characters intact", () => {
    const [key] = decodeKeys("é");
    assert.equal(key!.char, "é");
    assert.equal(isPrintable(key!), true);
  });
});

describe("isPrintable", () => {
  it("is true for characters that should edit a field", () => {
    assert.equal(isPrintable(decodeKeys("a")[0]!), true);
    assert.equal(isPrintable(decodeKeys(":")[0]!), true);
    assert.equal(isPrintable(decodeKeys(" ")[0]!), true);
  });

  it("is false for control and navigation keys", () => {
    assert.equal(isPrintable(decodeKeys("")[0]!), false);
    assert.equal(isPrintable(decodeKeys(`${ESC}[A`)[0]!), false);
    assert.equal(isPrintable(decodeKeys("\t")[0]!), false);
    assert.equal(isPrintable(decodeKeys("\r")[0]!), false);
  });
});

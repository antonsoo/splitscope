import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeText } from "../src/core/decode.js";
import { parseRun } from "../src/core/parser.js";

const sample = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "examples",
  "crystal-caverns-any.lss",
);

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  return bytes;
}

describe("decodeText", () => {
  const bytes = new Uint8Array(readFileSync(sample));
  const text = new TextDecoder().decode(bytes);
  const expected = parseRun(text);

  it("reads a splits file saved as UTF-16 like the UTF-8 original", () => {
    for (const littleEndian of [true, false]) {
      // Read as UTF-8, as the page used to, the same bytes are not XML.
      expect(() => parseRun(new TextDecoder().decode(utf16(text, littleEndian)))).toThrow();
      const decoded = decodeText(utf16(text, littleEndian));
      expect(decoded).toBe(text);
      expect(parseRun(decoded)).toEqual(expected);
    }
  });

  it("drops a UTF-8 byte-order mark, as LiveSplit writes one", () => {
    const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
    expect(decodeText(withMark)).toBe(text);
  });
});

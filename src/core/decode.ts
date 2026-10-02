/**
 * A splits file's text, as Windows saves it. LiveSplit writes UTF-8 with a byte-order mark,
 * but a file opened in Notepad and saved as "Unicode" (or redirected with `>` in Windows
 * PowerShell) is UTF-16 with a mark, which read as UTF-8 is not XML at all. The mark decides
 * the encoding and is dropped.
 */
export function decodeText(bytes: Uint8Array): string {
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : null;
  return new TextDecoder(utf16 ?? "utf-8").decode(bytes);
}

import { decodeText } from "../core/decode.js";
import { LssParseError } from "../core/errors.js";
import { parseRun } from "../core/parser.js";

self.onmessage = async (event: MessageEvent<Uint8Array<ArrayBuffer>>) => {
  try {
    const bytes = event.data;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const run = parseRun(decodeText(bytes));
    const sha256 = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    self.postMessage({ run, sha256 });
  } catch (cause) {
    self.postMessage({
      error: cause instanceof Error ? cause.message : String(cause),
      parseError: cause instanceof LssParseError,
    });
  }
};

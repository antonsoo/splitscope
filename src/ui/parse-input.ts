import { LssParseError } from "../core/errors.js";
import type { Run } from "../core/types.js";
import ParserWorker from "./parse.worker?worker&inline";

export interface ParsedInput {
  readonly run: Run;
  readonly sha256: string;
}

/** Transfers the owned input buffer; cancellation also interrupts synchronous XML parsing. */
export function parseInput(
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<ParsedInput> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // The worker travels with the initial app bundle, so importing a local file
    // after going offline does not need a later script fetch.
    const worker = new ParserWorker();
    const finish = (error: unknown, result?: ParsedInput): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error !== null) reject(error);
      else if (result) resolve(result);
      else reject(new Error("The file parser returned no result."));
    };
    const abort = (): void => finish(signal.reason);
    const timer = setTimeout(
      () => finish(new Error("Parsing took longer than 15 seconds. Try a smaller splits file.")),
      15_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error("The file parser stopped unexpectedly. Retry the import."));
    };
    worker.onmessageerror = () =>
      finish(new Error("The parsed file could not be read. Retry the import."));
    worker.onmessage = (
      event: MessageEvent<ParsedInput | { error: string; parseError: boolean }>,
    ) => {
      if ("error" in event.data) {
        finish(
          event.data.parseError ? new LssParseError(event.data.error) : new Error(event.data.error),
        );
      } else finish(null, event.data);
    };
    try {
      worker.postMessage(bytes, [bytes.buffer]);
    } catch (cause) {
      finish(cause);
    }
  });
}

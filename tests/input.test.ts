import { describe, expect, it } from "vitest";
import { readInputStream } from "../src/ui/input.js";

const streamOf = (...sizes: number[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of sizes) controller.enqueue(new Uint8Array(size).fill(65));
      controller.close();
    },
  });

describe("bounded cancellable input", () => {
  it("accepts the exact byte limit across multiple chunks", async () => {
    expect(await readInputStream(streamOf(2, 3), new AbortController().signal, 5)).toEqual(
      new Uint8Array(5).fill(65),
    );
  });
  it("rejects one byte over the limit and releases the stream", async () => {
    const stream = streamOf(3, 3);
    await expect(readInputStream(stream, new AbortController().signal, 5)).rejects.toThrow(
      /input limit/,
    );
    expect(stream.locked).toBe(false);
  });
  it("cancels a pending read and releases its reader", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const pending = readInputStream(stream, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });
  it("does not read an already cancelled input", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readInputStream(streamOf(1), controller.signal)).rejects.toThrow();
  });
});

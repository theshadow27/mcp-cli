import { describe, expect, test } from "bun:test";
import { discoverUrl } from "./opencode-process";

describe("discoverUrl", () => {
  test("discovers URL from stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("Starting server...\n"));
        controller.enqueue(encoder.encode("opencode server listening on http://127.0.0.1:54321\n"));
        controller.close();
      },
    });

    const url = await discoverUrl(stream, 5000);
    expect(url).toBe("http://127.0.0.1:54321");
  });

  test("discovers URL from partial line (no trailing newline)", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("listening on http://127.0.0.1:9999"));
        // Don't close — the URL should be found in the buffer
      },
    });

    const url = await discoverUrl(stream, 5000);
    expect(url).toBe("http://127.0.0.1:9999");
  });

  test("throws on null stdout", async () => {
    await expect(discoverUrl(null, 100)).rejects.toThrow("No stdout stream available");
  });

  test("throws when stream closes without URL", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("no url here\n"));
        controller.close();
      },
    });

    await expect(discoverUrl(stream, 5000)).rejects.toThrow("Process stdout closed before URL was discovered");
  });

  test("throws on timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueue anything — will timeout
      },
    });

    await expect(discoverUrl(stream, 50)).rejects.toThrow("URL discovery timeout");
  });
});

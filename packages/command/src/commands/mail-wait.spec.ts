import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { IpcCallError, type IpcError, type MailMessage, ProtocolMismatchError } from "@mcp-cli/core";
import { emitMailEvent, pollMailUntil } from "./mail-wait";

function makeMail(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 1,
    sender: "alice",
    recipient: "bob",
    subject: "hello",
    body: "world",
    replyTo: null,
    read: false,
    createdAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

// ── pollMailUntil ──

describe("pollMailUntil", () => {
  test("returns message when createdAt is after afterMs", async () => {
    const msg = makeMail();
    const d = { pollMail: mock(async () => msg) };
    const afterMs = Date.now();
    const result = await pollMailUntil(d, "bob", 5000, afterMs, 10);
    expect(result).toBe(msg);
  });

  test("returns null on timeout when no mail arrives", async () => {
    const d = { pollMail: mock(async () => null) };
    const result = await pollMailUntil(d, "bob", 50, Date.now(), 10);
    expect(result).toBeNull();
  });

  test("filters out messages with createdAt before afterMs (HWM filter)", async () => {
    const stale = makeMail({ createdAt: new Date(Date.now() - 60_000).toISOString() });
    const d = { pollMail: mock(async () => stale) };
    const result = await pollMailUntil(d, "bob", 50, Date.now(), 10);
    expect(result).toBeNull();
  });

  test("swallows transient pollMail errors and retries", async () => {
    const msg = makeMail();
    let calls = 0;
    const d = {
      pollMail: mock(async () => {
        if (calls++ === 0) {
          const err = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
          throw err;
        }
        return msg;
      }),
    };
    const result = await pollMailUntil(d, "bob", 5000, Date.now() - 1, 10);
    expect(result).toBe(msg);
    expect(calls).toBe(2);
  });

  test("passes recipient to pollMail", async () => {
    const d = { pollMail: mock(async () => null) };
    await pollMailUntil(d, "charlie", 50, Date.now(), 10);
    expect(d.pollMail).toHaveBeenCalledWith("charlie");
  });

  test("returns null immediately when signal is already aborted", async () => {
    const d = { pollMail: mock(async () => makeMail()) };
    const ac = new AbortController();
    ac.abort();
    const result = await pollMailUntil(d, "bob", 5000, Date.now() - 1, 10, ac.signal);
    expect(result).toBeNull();
    expect(d.pollMail).not.toHaveBeenCalled();
  });

  test("stops polling after signal is aborted mid-loop", async () => {
    const ac = new AbortController();
    let calls = 0;
    const d = {
      pollMail: mock(async () => {
        calls++;
        // Abort after first poll so second iteration is cut short
        if (calls === 1) ac.abort();
        return null;
      }),
    };
    const result = await pollMailUntil(d, "bob", 5000, Date.now(), 10, ac.signal);
    expect(result).toBeNull();
    // Should have polled exactly once before abort stopped the loop
    expect(calls).toBe(1);
  });

  // ── error handling (#2061) ──

  describe("error handling", () => {
    let errorSpy: ReturnType<typeof mock>;
    let originalError: typeof console.error;

    beforeEach(() => {
      originalError = console.error;
      errorSpy = mock((..._args: unknown[]) => {});
      console.error = errorSpy as unknown as typeof console.error;
    });

    afterEach(() => {
      console.error = originalError;
    });

    test("re-throws ProtocolMismatchError immediately (does not spin-poll)", async () => {
      const d = {
        pollMail: mock(async () => {
          throw new ProtocolMismatchError("0.9", "1.0");
        }),
      };
      await expect(pollMailUntil(d, "bob", 5000, Date.now(), 10)).rejects.toBeInstanceOf(ProtocolMismatchError);
      expect(d.pollMail).toHaveBeenCalledTimes(1);
    });

    test("re-throws unknown (non-transient) errors instead of swallowing", async () => {
      const d = {
        pollMail: mock(async () => {
          throw new TypeError("response is not an object");
        }),
      };
      await expect(pollMailUntil(d, "bob", 5000, Date.now(), 10)).rejects.toBeInstanceOf(TypeError);
      expect(d.pollMail).toHaveBeenCalledTimes(1);
    });

    test("retries on transient errors with code property", async () => {
      const msg = makeMail();
      let calls = 0;
      const d = {
        pollMail: mock(async () => {
          if (calls++ === 0) {
            const err = new Error("connect failed") as Error & { code: string };
            err.code = "ECONNREFUSED";
            throw err;
          }
          return msg;
        }),
      };
      const result = await pollMailUntil(d, "bob", 5000, Date.now() - 1, 10);
      expect(result).toBe(msg);
      expect(calls).toBe(2);
    });

    test("logs a warning after N consecutive transient failures", async () => {
      const d = {
        pollMail: mock(async () => {
          throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
        }),
      };
      // Short timeout — will burn through ~15 polls at 1ms interval
      await pollMailUntil(d, "bob", 100, Date.now(), 1);
      const warnings = errorSpy.mock.calls.filter((c) => String((c as unknown[])[0]).includes("consecutive transient"));
      // Logs exactly once (warnedTransient latch) regardless of how many more transient errors fire
      expect(warnings.length).toBe(1);
    });

    test("retries on IpcCallError with systemCode matching transient code", async () => {
      const msg = makeMail();
      let calls = 0;
      const d = {
        pollMail: mock(async () => {
          if (calls++ === 0) {
            const ipcErr: IpcError = { code: -32603, message: "connect failed", systemCode: "ECONNRESET" };
            throw new IpcCallError(ipcErr);
          }
          return msg;
        }),
      };
      const result = await pollMailUntil(d, "bob", 5000, Date.now() - 1, 10);
      expect(result).toBe(msg);
      expect(calls).toBe(2);
    });

    test("does not retry on IpcCallError without systemCode", async () => {
      const d = {
        pollMail: mock(async () => {
          const ipcErr: IpcError = { code: -32603, message: "Internal error" };
          throw new IpcCallError(ipcErr);
        }),
      };
      await expect(pollMailUntil(d, "bob", 5000, Date.now(), 10)).rejects.toBeInstanceOf(IpcCallError);
      expect(d.pollMail).toHaveBeenCalledTimes(1);
    });
  });

  // ── createdAt NaN guard (#2062) ──

  describe("createdAt NaN guard", () => {
    let errorSpy: ReturnType<typeof mock>;
    let originalError: typeof console.error;

    beforeEach(() => {
      originalError = console.error;
      errorSpy = mock((..._args: unknown[]) => {});
      console.error = errorSpy as unknown as typeof console.error;
    });

    afterEach(() => {
      console.error = originalError;
    });

    test("treats messages with non-finite createdAt as a miss and logs a warning", async () => {
      const bad = makeMail({ createdAt: "garbage" });
      const d = { pollMail: mock(async () => bad) };
      const result = await pollMailUntil(d, "bob", 30, Date.now(), 10);
      expect(result).toBeNull();
      const warnings = errorSpy.mock.calls.filter((c) => String((c as unknown[])[0]).includes("invalid createdAt"));
      expect(warnings.length).toBe(1);
    });
  });
});

// ── emitMailEvent ──

describe("emitMailEvent", () => {
  test("emits header then JSON when short=false and includeHeader=true", () => {
    const msg = makeMail({ id: 99, sender: "alice" });
    const logSpy = mock((..._args: unknown[]) => {});
    emitMailEvent(msg, false, { log: logSpy }, true);
    expect(logSpy).toHaveBeenCalledTimes(2);
    const header = String((logSpy.mock.calls[0] as unknown[])[0]);
    expect(header).toContain("event=mail");
    expect(header).toContain("id=99");
    expect(header).toContain("sender=alice");
    const parsed = JSON.parse(String((logSpy.mock.calls[1] as unknown[])[0]));
    expect(parsed.source).toBe("mail");
    expect(parsed.mail.id).toBe(99);
  });

  test("emits JSON only when short=false (includeHeader=false, default)", () => {
    const msg = makeMail({ id: 99, sender: "alice" });
    const logSpy = mock((..._args: unknown[]) => {});
    emitMailEvent(msg, false, { log: logSpy });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String((logSpy.mock.calls[0] as unknown[])[0]));
    expect(parsed.source).toBe("mail");
    expect(parsed.mail.id).toBe(99);
  });

  test("emits short format when short=true", () => {
    const msg = makeMail({ id: 7, sender: "bob", subject: "hi there" });
    const logSpy = mock((..._args: unknown[]) => {});
    emitMailEvent(msg, true, { log: logSpy });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = String((logSpy.mock.calls[0] as unknown[])[0]);
    expect(output).toBe("mail 7 bob hi there");
  });

  test("uses '(no subject)' when subject is null in short format", () => {
    const msg = makeMail({ id: 3, sender: "carol", subject: null });
    const logSpy = mock((..._args: unknown[]) => {});
    emitMailEvent(msg, true, { log: logSpy });
    const output = String((logSpy.mock.calls[0] as unknown[])[0]);
    expect(output).toBe("mail 3 carol (no subject)");
  });

  test("long format handles subject:null without crashing", () => {
    const msg = makeMail({ id: 5, sender: "dan", subject: null });
    const logSpy = mock((..._args: unknown[]) => {});
    emitMailEvent(msg, false, { log: logSpy }, true);
    expect(logSpy).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(String((logSpy.mock.calls[1] as unknown[])[0]));
    expect(parsed.mail.id).toBe(5);
  });
});

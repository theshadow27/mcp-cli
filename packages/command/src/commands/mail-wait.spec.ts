import { describe, expect, mock, test } from "bun:test";
import type { MailMessage } from "@mcp-cli/core";
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
        if (calls++ === 0) throw new Error("ECONNREFUSED");
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
});

// ── emitMailEvent ──

describe("emitMailEvent", () => {
  test("emits header then JSON when short=false", () => {
    const msg = makeMail({ id: 99, sender: "alice" });
    const logSpy = mock((..._args: unknown[]) => {});
    emitMailEvent(msg, false, { log: logSpy });
    expect(logSpy).toHaveBeenCalledTimes(2);
    const header = String((logSpy.mock.calls[0] as unknown[])[0]);
    expect(header).toContain("event=mail");
    expect(header).toContain("id=99");
    expect(header).toContain("sender=alice");
    const parsed = JSON.parse(String((logSpy.mock.calls[1] as unknown[])[0]));
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
    emitMailEvent(msg, false, { log: logSpy });
    expect(logSpy).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(String((logSpy.mock.calls[1] as unknown[])[0]));
    expect(parsed.mail.id).toBe(5);
  });
});

import { describe, expect, mock, test } from "bun:test";
import { ExitError } from "../test-helpers";
import type { LogsDeps } from "./logs";
import { cmdLogs, pad2, pad3, parseLogsArgs, printLogLine } from "./logs";

/* ── helpers ─────────────────────────────────────────────────────── */

function makeDeps(overrides?: Partial<LogsDeps>): Partial<LogsDeps> {
  return {
    ipcCall: mock(() => Promise.resolve({ lines: [] })),
    printError: mock(() => {}),
    readFileSync: mock(() => ""),
    daemonLogPath: "/tmp/test-mcpd.log",
    writeStderr: mock(() => {}),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as LogsDeps["exit"],
    schedule: mock(() => null as unknown as ReturnType<typeof setTimeout>),
    cancelSchedule: mock(() => {}),
    onSigint: mock(() => {}),
    keepAlive: mock(() => Promise.resolve()),
    ...overrides,
  };
}

/* ── parseLogsArgs ──────────────────────────────────────────────── */

describe("parseLogsArgs", () => {
  test("parses server name", () => {
    const result = parseLogsArgs(["myserver"]);
    expect(result.server).toBe("myserver");
    expect(result.follow).toBe(false);
    expect(result.daemon).toBe(false);
    expect(result.lines).toBe(50);
    expect(result.error).toBeUndefined();
  });

  test("parses -f flag", () => {
    const result = parseLogsArgs(["myserver", "-f"]);
    expect(result.server).toBe("myserver");
    expect(result.follow).toBe(true);
  });

  test("parses --follow flag", () => {
    const result = parseLogsArgs(["myserver", "--follow"]);
    expect(result.follow).toBe(true);
  });

  test("parses --lines N", () => {
    const result = parseLogsArgs(["myserver", "--lines", "100"]);
    expect(result.lines).toBe(100);
  });

  test("parses -n as alias for --lines", () => {
    const result = parseLogsArgs(["myserver", "-n", "25"]);
    expect(result.lines).toBe(25);
  });

  test("returns error for --lines without value", () => {
    const result = parseLogsArgs(["myserver", "--lines"]);
    expect(result.error).toBe("--lines requires a number");
  });

  test("returns error for --lines with non-numeric value", () => {
    const result = parseLogsArgs(["myserver", "--lines", "abc"]);
    expect(result.error).toBe("--lines requires a number");
  });

  test("returns undefined server when no positional arg", () => {
    const result = parseLogsArgs(["-f"]);
    expect(result.server).toBeUndefined();
  });

  test("handles all options combined", () => {
    const result = parseLogsArgs(["-f", "--lines", "200", "myserver"]);
    expect(result.server).toBe("myserver");
    expect(result.follow).toBe(true);
    expect(result.lines).toBe(200);
    expect(result.error).toBeUndefined();
  });

  test("returns defaults for empty args", () => {
    const result = parseLogsArgs([]);
    expect(result.server).toBeUndefined();
    expect(result.daemon).toBe(false);
    expect(result.follow).toBe(false);
    expect(result.lines).toBe(50);
    expect(result.error).toBeUndefined();
  });

  test("parses --daemon flag", () => {
    const result = parseLogsArgs(["--daemon"]);
    expect(result.daemon).toBe(true);
    expect(result.server).toBeUndefined();
  });

  test("parses --daemon with --follow", () => {
    const result = parseLogsArgs(["--daemon", "-f"]);
    expect(result.daemon).toBe(true);
    expect(result.follow).toBe(true);
  });

  test("parses --daemon with --lines", () => {
    const result = parseLogsArgs(["--daemon", "--lines", "100"]);
    expect(result.daemon).toBe(true);
    expect(result.lines).toBe(100);
  });
});

/* ── printLogLine ───────────────────────────────────────────────── */

describe("printLogLine", () => {
  test("formats timestamp and server prefix", () => {
    const output: string[] = [];
    const deps: Partial<LogsDeps> = { writeStderr: (msg: string) => output.push(msg) };

    // 2024-01-15 14:30:45.123 UTC
    const ts = new Date(2024, 0, 15, 14, 30, 45, 123).getTime();
    printLogLine("test-server", ts, "hello world", deps);

    expect(output[0]).toBe("14:30:45.123 [test-server] hello world\n");
  });

  test("pads single-digit hours/minutes/seconds", () => {
    const output: string[] = [];
    const deps: Partial<LogsDeps> = { writeStderr: (msg: string) => output.push(msg) };

    const ts = new Date(2024, 0, 1, 1, 2, 3, 4).getTime();
    printLogLine("srv", ts, "msg", deps);

    expect(output[0]).toBe("01:02:03.004 [srv] msg\n");
  });

  test("handles midnight (00:00:00.000)", () => {
    const output: string[] = [];
    const deps: Partial<LogsDeps> = { writeStderr: (msg: string) => output.push(msg) };

    const ts = new Date(2024, 0, 1, 0, 0, 0, 0).getTime();
    printLogLine("srv", ts, "midnight", deps);

    expect(output[0]).toBe("00:00:00.000 [srv] midnight\n");
  });

  test("handles max milliseconds (999)", () => {
    const output: string[] = [];
    const deps: Partial<LogsDeps> = { writeStderr: (msg: string) => output.push(msg) };

    const ts = new Date(2024, 0, 1, 23, 59, 59, 999).getTime();
    printLogLine("srv", ts, "end", deps);

    expect(output[0]).toBe("23:59:59.999 [srv] end\n");
  });
});

/* ── pad2 / pad3 ────────────────────────────────────────────────── */

describe("pad2", () => {
  test("pads 0 to 00", () => expect(pad2(0)).toBe("00"));
  test("pads 5 to 05", () => expect(pad2(5)).toBe("05"));
  test("leaves 10 as 10", () => expect(pad2(10)).toBe("10"));
  test("leaves 23 as 23", () => expect(pad2(23)).toBe("23"));
});

describe("pad3", () => {
  test("pads 0 to 000", () => expect(pad3(0)).toBe("000"));
  test("pads 4 to 004", () => expect(pad3(4)).toBe("004"));
  test("pads 42 to 042", () => expect(pad3(42)).toBe("042"));
  test("leaves 999 as 999", () => expect(pad3(999)).toBe("999"));
});

/* ── cmdLogs: error paths ───────────────────────────────────────── */

describe("cmdLogs error paths", () => {
  test("exits on parse error", async () => {
    const deps = makeDeps();
    await expect(cmdLogs(["srv", "--lines", "abc"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("--lines requires a number");
  });

  test("exits when no server provided", async () => {
    const deps = makeDeps();
    await expect(cmdLogs([], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalled();
  });
});

/* ── cmdLogs: server logs (no follow) ───────────────────────────── */

describe("cmdLogs server (no follow)", () => {
  test("fetches and prints log lines", async () => {
    const output: string[] = [];
    const deps = makeDeps({
      ipcCall: mock(() =>
        Promise.resolve({
          lines: [
            { timestamp: new Date(2024, 0, 1, 10, 0, 0, 0).getTime(), line: "first" },
            { timestamp: new Date(2024, 0, 1, 10, 0, 1, 0).getTime(), line: "second" },
          ],
        }),
      ),
      writeStderr: (msg: string) => output.push(msg),
    });

    await cmdLogs(["myserver"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("getLogs", { server: "myserver", limit: 50 });
    expect(output).toHaveLength(2);
    expect(output[0]).toContain("[myserver] first");
    expect(output[1]).toContain("[myserver] second");
  });

  test("respects --lines option", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ lines: [] })),
    });

    await cmdLogs(["myserver", "--lines", "10"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("getLogs", { server: "myserver", limit: 10 });
  });

  test("handles empty log lines", async () => {
    const output: string[] = [];
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ lines: [] })),
      writeStderr: (msg: string) => output.push(msg),
    });

    await cmdLogs(["myserver"], deps);
    expect(output).toHaveLength(0);
  });
});

/* ── cmdLogs: server logs (follow mode) ─────────────────────────── */

describe("cmdLogs server (follow)", () => {
  test("starts polling after initial fetch", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ lines: [] })),
    });

    await cmdLogs(["myserver", "-f"], deps);

    expect(deps.schedule).toHaveBeenCalled();
    expect(deps.onSigint).toHaveBeenCalled();
  });

  test("prints initial lines before entering follow mode", async () => {
    const output: string[] = [];
    const deps = makeDeps({
      ipcCall: mock(() =>
        Promise.resolve({
          lines: [{ timestamp: Date.now(), line: "initial" }],
        }),
      ),
      writeStderr: (msg: string) => output.push(msg),
    });

    await cmdLogs(["myserver", "-f"], deps);

    expect(output).toHaveLength(1);
    expect(output[0]).toContain("initial");
  });

  test("poll callback prints new lines and resets backoff", async () => {
    const output: string[] = [];
    const scheduledFns: Array<() => void> = [];
    const ts = Date.now();

    const deps = makeDeps({
      ipcCall: mock()
        .mockResolvedValueOnce({ lines: [{ timestamp: ts, line: "initial" }] }) // initial fetch
        .mockResolvedValueOnce({ lines: [{ timestamp: ts + 1000, line: "polled" }] }), // poll
      writeStderr: (msg: string) => output.push(msg),
      schedule: mock((fn: () => void) => {
        scheduledFns.push(fn);
        return null as unknown as ReturnType<typeof setTimeout>;
      }),
    });

    await cmdLogs(["myserver", "-f"], deps);

    // Execute the poll callback
    expect(scheduledFns.length).toBeGreaterThanOrEqual(1);
    await scheduledFns[0]();

    expect(output).toHaveLength(2);
    expect(output[1]).toContain("polled");
  });

  test("poll callback backs off when no new data", async () => {
    const scheduledFns: Array<() => void> = [];
    const scheduledDelays: number[] = [];

    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ lines: [] })),
      schedule: mock((fn: () => void, ms: number) => {
        scheduledFns.push(fn);
        scheduledDelays.push(ms);
        return null as unknown as ReturnType<typeof setTimeout>;
      }),
    });

    await cmdLogs(["myserver", "-f"], deps);

    // Execute poll twice — should see increasing delays
    await scheduledFns[0]();
    await scheduledFns[1]();

    expect(scheduledDelays[1]).toBeGreaterThan(scheduledDelays[0]);
  });

  test("poll callback handles errors with backoff", async () => {
    const scheduledFns: Array<() => void> = [];
    const scheduledDelays: number[] = [];

    const deps = makeDeps({
      ipcCall: mock()
        .mockResolvedValueOnce({ lines: [] }) // initial fetch
        .mockRejectedValueOnce(new Error("connection lost")), // poll error
      schedule: mock((fn: () => void, ms: number) => {
        scheduledFns.push(fn);
        scheduledDelays.push(ms);
        return null as unknown as ReturnType<typeof setTimeout>;
      }),
    });

    await cmdLogs(["myserver", "-f"], deps);
    await scheduledFns[0](); // This should catch the error

    // Should still schedule next poll (with backoff)
    expect(scheduledFns).toHaveLength(2);
    expect(scheduledDelays[1]).toBeGreaterThan(scheduledDelays[0]);
  });

  test("SIGINT handler cancels polling and exits", async () => {
    let sigintHandler: (() => void) | undefined;

    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ lines: [] })),
      onSigint: mock((fn: () => void) => {
        sigintHandler = fn;
      }),
      schedule: mock(() => "timer-id" as unknown as ReturnType<typeof setTimeout>),
    });

    await cmdLogs(["myserver", "-f"], deps);

    expect(sigintHandler).toBeDefined();
    expect(() => (sigintHandler as () => void)()).toThrow(ExitError);
    expect(deps.cancelSchedule).toHaveBeenCalled();
  });
});

/* ── cmdLogs: daemon logs (no follow) ───────────────────────────── */

describe("cmdLogs --daemon (no follow)", () => {
  test("reads log file and prints tail", async () => {
    const output: string[] = [];
    const logContent = "line1\nline2\nline3\nline4\nline5\n";
    const deps = makeDeps({
      readFileSync: mock(() => logContent),
      writeStderr: (msg: string) => output.push(msg),
    });

    await cmdLogs(["--daemon", "--lines", "3"], deps);

    expect(deps.readFileSync).toHaveBeenCalledWith("/tmp/test-mcpd.log", "utf-8");
    expect(output).toHaveLength(3);
    expect(output[0]).toBe("line3\n");
    expect(output[1]).toBe("line4\n");
    expect(output[2]).toBe("line5\n");
  });

  test("prints all lines when fewer than --lines", async () => {
    const output: string[] = [];
    const deps = makeDeps({
      readFileSync: mock(() => "only\ntwo\n"),
      writeStderr: (msg: string) => output.push(msg),
    });

    await cmdLogs(["--daemon"], deps);

    expect(output).toHaveLength(2);
    expect(output[0]).toBe("only\n");
    expect(output[1]).toBe("two\n");
  });

  test("exits when log file not found", async () => {
    const deps = makeDeps({
      readFileSync: mock(() => {
        throw new Error("ENOENT");
      }),
    });

    await expect(cmdLogs(["--daemon"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("No daemon log file found at /tmp/test-mcpd.log");
  });
});

/* ── cmdLogs: daemon logs (follow mode) ─────────────────────────── */

describe("cmdLogs --daemon (follow)", () => {
  test("uses IPC getDaemonLogs and starts polling", async () => {
    const output: string[] = [];
    const deps = makeDeps({
      ipcCall: mock(() =>
        Promise.resolve({
          lines: [{ timestamp: Date.now(), line: "daemon line" }],
        }),
      ),
      writeStderr: (msg: string) => output.push(msg),
    });

    await cmdLogs(["--daemon", "-f"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("getDaemonLogs", { limit: 50 });
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("daemon line");
    expect(deps.schedule).toHaveBeenCalled();
    expect(deps.onSigint).toHaveBeenCalled();
  });

  test("respects --lines with --daemon -f", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ lines: [] })),
    });

    await cmdLogs(["--daemon", "-f", "--lines", "20"], deps);
    expect(deps.ipcCall).toHaveBeenCalledWith("getDaemonLogs", { limit: 20 });
  });

  test("daemon poll callback prints new lines", async () => {
    const output: string[] = [];
    const scheduledFns: Array<() => void> = [];
    const ts = Date.now();

    const deps = makeDeps({
      ipcCall: mock()
        .mockResolvedValueOnce({ lines: [{ timestamp: ts, line: "init" }] })
        .mockResolvedValueOnce({ lines: [{ timestamp: ts + 1000, line: "polled-daemon" }] }),
      writeStderr: (msg: string) => output.push(msg),
      schedule: mock((fn: () => void) => {
        scheduledFns.push(fn);
        return null as unknown as ReturnType<typeof setTimeout>;
      }),
    });

    await cmdLogs(["--daemon", "-f"], deps);
    await scheduledFns[0]();

    expect(output).toHaveLength(2);
    expect(output[1]).toContain("polled-daemon");
  });

  test("daemon poll backs off on empty data", async () => {
    const scheduledFns: Array<() => void> = [];
    const scheduledDelays: number[] = [];

    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ lines: [] })),
      schedule: mock((fn: () => void, ms: number) => {
        scheduledFns.push(fn);
        scheduledDelays.push(ms);
        return null as unknown as ReturnType<typeof setTimeout>;
      }),
    });

    await cmdLogs(["--daemon", "-f"], deps);
    await scheduledFns[0]();
    await scheduledFns[1]();

    expect(scheduledDelays[1]).toBeGreaterThan(scheduledDelays[0]);
  });

  test("daemon poll handles errors with backoff", async () => {
    const scheduledFns: Array<() => void> = [];
    const scheduledDelays: number[] = [];

    const deps = makeDeps({
      ipcCall: mock().mockResolvedValueOnce({ lines: [] }).mockRejectedValueOnce(new Error("ipc error")),
      schedule: mock((fn: () => void, ms: number) => {
        scheduledFns.push(fn);
        scheduledDelays.push(ms);
        return null as unknown as ReturnType<typeof setTimeout>;
      }),
    });

    await cmdLogs(["--daemon", "-f"], deps);
    await scheduledFns[0]();

    expect(scheduledFns).toHaveLength(2);
    expect(scheduledDelays[1]).toBeGreaterThan(scheduledDelays[0]);
  });

  test("daemon SIGINT handler cancels polling and exits", async () => {
    let sigintHandler: (() => void) | undefined;

    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ lines: [] })),
      onSigint: mock((fn: () => void) => {
        sigintHandler = fn;
      }),
      schedule: mock(() => "timer-id" as unknown as ReturnType<typeof setTimeout>),
    });

    await cmdLogs(["--daemon", "-f"], deps);

    expect(sigintHandler).toBeDefined();
    expect(() => (sigintHandler as () => void)()).toThrow(ExitError);
    expect(deps.cancelSchedule).toHaveBeenCalled();
  });
});

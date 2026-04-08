import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flockUnlock, tryFlockExclusive } from "./flock";

const dir = mkdtempSync(join(tmpdir(), "flock-test-"));

describe("tryFlockExclusive", () => {
  let fd1: number | null = null;
  let fd2: number | null = null;
  const file = join(dir, "test.lock");

  afterEach(() => {
    if (fd1 !== null) {
      try {
        closeSync(fd1);
      } catch {
        /* already closed */
      }
    }
    if (fd2 !== null) {
      try {
        closeSync(fd2);
      } catch {
        /* already closed */
      }
    }
    fd1 = null;
    fd2 = null;
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  });

  it("acquires lock on an unlocked file", () => {
    fd1 = openSync(file, "w");
    expect(tryFlockExclusive(fd1)).toBe(true);
  });

  it("fails to acquire lock when another fd holds it", () => {
    fd1 = openSync(file, "w");
    expect(tryFlockExclusive(fd1)).toBe(true);

    fd2 = openSync(file, "r");
    expect(tryFlockExclusive(fd2)).toBe(false);
  });

  it("lock is released when fd is closed", () => {
    fd1 = openSync(file, "w");
    expect(tryFlockExclusive(fd1)).toBe(true);
    closeSync(fd1);
    fd1 = null;

    fd2 = openSync(file, "r");
    expect(tryFlockExclusive(fd2)).toBe(true);
  });

  it("lock can be explicitly unlocked and re-acquired", () => {
    fd1 = openSync(file, "w");
    expect(tryFlockExclusive(fd1)).toBe(true);

    flockUnlock(fd1);

    fd2 = openSync(file, "r");
    expect(tryFlockExclusive(fd2)).toBe(true);
  });

  it("same fd can re-acquire after unlock", () => {
    fd1 = openSync(file, "w");
    expect(tryFlockExclusive(fd1)).toBe(true);
    flockUnlock(fd1);
    expect(tryFlockExclusive(fd1)).toBe(true);
  });
});

describe("cross-process flock", () => {
  const file = join(dir, "cross-proc.lock");

  afterEach(() => {
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  });

  it("child process cannot acquire lock held by parent", async () => {
    const fd = openSync(file, "w");
    expect(tryFlockExclusive(fd)).toBe(true);

    try {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        const { openSync } = require("fs");
        const { tryFlockExclusive } = require("${join(import.meta.dir, "flock.ts")}");
        const fd = openSync(${JSON.stringify(file)}, "r");
        const got = tryFlockExclusive(fd);
        process.stdout.write(got ? "acquired" : "blocked");
        process.exit(0);
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      expect(stdout).toBe("blocked");
    } finally {
      closeSync(fd);
    }
  });

  it("child can acquire lock after parent releases", async () => {
    const fd = openSync(file, "w");
    expect(tryFlockExclusive(fd)).toBe(true);
    closeSync(fd); // release

    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `
        const { openSync, closeSync } = require("fs");
        const { tryFlockExclusive } = require("${join(import.meta.dir, "flock.ts")}");
        const fd = openSync(${JSON.stringify(file)}, "r");
        const got = tryFlockExclusive(fd);
        process.stdout.write(got ? "acquired" : "blocked");
        closeSync(fd);
        process.exit(0);
      `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toBe("acquired");
  });
});

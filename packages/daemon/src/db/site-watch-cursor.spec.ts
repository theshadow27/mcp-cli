import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpFile } from "am-i-done/tmp";
import { McxDb } from "./state";

function tmpDb(): string {
  return tmpFile("mcp-cli-watch-cursor.db").path;
}

const paths: string[] = [];
function openDb(): McxDb {
  const p = tmpDb();
  paths.push(p);
  return new McxDb(p);
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
        // doing-it-wrong-ignore test-empty-catch: best-effort cleanup (#3465)
      } catch {
        // ignore
      }
    }
  }
});

describe("site watch cursor", () => {
  test("returns null for an unseen (site, thread)", () => {
    const db = openDb();
    expect(db.getSiteWatchCursor("teams", "19:aaa@thread.v2")).toBeNull();
    db.close?.();
  });

  test("round-trips a cursor value", () => {
    const db = openDb();
    db.setSiteWatchCursor("teams", "19:aaa@thread.v2", "1700000000001");
    expect(db.getSiteWatchCursor("teams", "19:aaa@thread.v2")).toBe("1700000000001");
    db.close?.();
  });

  test("upserts (last write wins) per (site, thread)", () => {
    const db = openDb();
    db.setSiteWatchCursor("teams", "19:aaa@thread.v2", "1");
    db.setSiteWatchCursor("teams", "19:aaa@thread.v2", "2");
    db.setSiteWatchCursor("teams", "19:bbb@thread.v2", "9");
    expect(db.getSiteWatchCursor("teams", "19:aaa@thread.v2")).toBe("2");
    expect(db.getSiteWatchCursor("teams", "19:bbb@thread.v2")).toBe("9");
    db.close?.();
  });

  test("keys are scoped by site", () => {
    const db = openDb();
    db.setSiteWatchCursor("teams", "19:aaa@thread.v2", "5");
    expect(db.getSiteWatchCursor("owa", "19:aaa@thread.v2")).toBeNull();
    db.close?.();
  });
});

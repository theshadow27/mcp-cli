import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import { loadCatalog, normalizeRetryOn, removeCall, upsertCall } from "./catalog";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `mcp-cli-site-cat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  options.SITES_DIR = join(tmp, "sites");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _restoreOptions();
});

describe("catalog", () => {
  test("seeds empty catalog when file is missing and no seed exists", () => {
    const cat = loadCatalog("brand-new");
    expect(cat).toEqual({});
  });

  test("upsert + remove round-trip", () => {
    upsertCall("demo", { name: "get_thing", method: "GET", url: "https://demo.example/:id" });
    expect(loadCatalog("demo").get_thing).toBeDefined();

    const removed = removeCall("demo", "get_thing");
    expect(removed).toBe(true);
    expect(loadCatalog("demo").get_thing).toBeUndefined();
  });

  test("remove returns false for missing call", () => {
    upsertCall("demo", { name: "a", method: "GET", url: "https://demo.example" });
    expect(removeCall("demo", "nonexistent")).toBe(false);
  });

  test("persists changes across reloads", () => {
    upsertCall("persist", { name: "one", method: "GET", url: "https://persist.example/a" });
    upsertCall("persist", { name: "two", method: "POST", url: "https://persist.example/b" });
    const cat = loadCatalog("persist");
    expect(Object.keys(cat).sort()).toEqual(["one", "two"]);
  });

  test("retryOn survives an upsert round-trip", () => {
    upsertCall("demo", {
      name: "stale_prone",
      method: "POST",
      url: "https://demo.example/service.svc",
      retryOn: { status: [500], responseHeaderPresent: "x-owa-error" },
    });
    expect(loadCatalog("demo").stale_prone?.retryOn).toEqual({
      status: [500],
      responseHeaderPresent: "x-owa-error",
    });
  });
});

describe("normalizeRetryOn", () => {
  test("passes through a well-formed retryOn", () => {
    expect(normalizeRetryOn({ status: [500], responseHeaderPresent: "x-owa-error" })).toEqual({
      status: [500],
      responseHeaderPresent: "x-owa-error",
    });
  });

  test("accepts either field alone", () => {
    expect(normalizeRetryOn({ status: [500, 503] })).toEqual({ status: [500, 503] });
    expect(normalizeRetryOn({ responseHeaderPresent: "x-stale" })).toEqual({ responseHeaderPresent: "x-stale" });
  });

  test("returns undefined for absent or unusable input", () => {
    expect(normalizeRetryOn(undefined)).toBeUndefined();
    expect(normalizeRetryOn(null)).toBeUndefined();
    expect(normalizeRetryOn({})).toBeUndefined();
    expect(normalizeRetryOn("500")).toBeUndefined();
    expect(normalizeRetryOn({ status: [], responseHeaderPresent: "" })).toBeUndefined();
  });

  test("drops malformed fields that would throw inside the retry predicate", () => {
    // A bare number would reach retryReason as `retryOn.status.includes(...)` → TypeError.
    expect(normalizeRetryOn({ status: 500 })).toBeUndefined();
    expect(normalizeRetryOn({ status: ["500", null], responseHeaderPresent: 7 })).toBeUndefined();
    expect(normalizeRetryOn({ status: [500, "503"] })).toEqual({ status: [500] });
  });
});

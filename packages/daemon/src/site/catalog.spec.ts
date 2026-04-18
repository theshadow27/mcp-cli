import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import { loadCatalog, removeCall, upsertCall } from "./catalog";

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
});

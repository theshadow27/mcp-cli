import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import type { CapturedResponse } from "./browser/engine";
import { CredentialVault } from "./credentials";
import { Sniffer } from "./sniffer";

describe("Sniffer", () => {
  test("filtered mode without configureSite() treats missing filters as match-all", () => {
    const vault = new CredentialVault();
    const sniffer = new Sniffer(vault);
    sniffer.setMode("teams", "filtered");
    const events = sniffer.asEvents();

    events.onRequest?.("teams", {
      url: "https://teams.example/api/x",
      method: "GET",
      headers: {},
      postData: null,
      resourceType: "xhr",
    });

    // Before the fix, this was silently dropped (empty filter set → returns false).
    const recent = sniffer.getRecentRequests();
    expect(recent).toHaveLength(1);
  });

  test("invalid regex filter falls back to substring match instead of throwing", () => {
    const vault = new CredentialVault();
    const sniffer = new Sniffer(vault);
    sniffer.setMode("teams", "off");
    const events = sniffer.asEvents();

    events.onRequest?.("teams", {
      url: "https://teams.example/api/chat",
      method: "GET",
      headers: {},
      postData: null,
      resourceType: "xhr",
    });

    // `[` is an unclosed character class — invalid regex.
    expect(() => sniffer.getRecentRequests("[invalid")).not.toThrow();
    // Falls back to literal substring match against "[invalid" → no hits, but no throw.
    expect(sniffer.getRecentRequests("[invalid")).toEqual([]);

    // Valid substring filter works through the regex path.
    expect(sniffer.getRecentRequests("chat")).toHaveLength(1);
  });
});

describe("Sniffer binary sidecars", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `mcp-cli-sniffer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    options.SITES_DIR = join(tmp, "sites");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    _restoreOptions();
  });

  const resp = (extra: Partial<CapturedResponse> = {}): CapturedResponse => ({
    url: "https://cdn.example/a.jpg",
    method: "GET",
    status: 200,
    contentType: "image/jpeg",
    headers: {},
    bodyBytes: 3,
    bodyText: null,
    requestHeaders: {},
    requestPostData: null,
    ...extra,
  });

  function capture(r: CapturedResponse): { json: { body: Record<string, unknown> }; files: string[]; dir: string } {
    const sniffer = new Sniffer(new CredentialVault());
    sniffer.setMode("s", "firehose");
    sniffer.asEvents().onResponse?.("s", r);
    const dir = join(options.SITES_DIR, "s", "captures");
    const files = readdirSync(dir).sort();
    const jsonFile = files.find((f) => f.endsWith(".json")) ?? "";
    return { json: JSON.parse(readFileSync(join(dir, jsonFile), "utf-8")), files, dir };
  }

  test("bodyBinary is written to <stem>.bin and named in _file", () => {
    const { json, files, dir } = capture(resp({ bodyBinary: new Uint8Array([9, 8, 7]) }));
    expect(files).toHaveLength(2);
    const bin = files.find((f) => f.endsWith(".bin")) ?? "";
    expect(bin.replace(/\.bin$/, "")).toBe((files.find((f) => f.endsWith(".json")) ?? "").replace(/\.json$/, ""));
    expect(json.body).toEqual({ _binary: true, _bytes: 3, _contentType: "image/jpeg", _file: bin });
    expect([...readFileSync(join(dir, bin))]).toEqual([9, 8, 7]);
  });

  test("an evicted body is marked _file:null, _evicted:true and writes no sidecar", () => {
    const { json, files } = capture(resp({ bodyEvicted: true }));
    expect(files).toHaveLength(1);
    expect(json.body).toEqual({ _binary: true, _bytes: 3, _contentType: "image/jpeg", _file: null, _evicted: true });
  });

  test("without captureBinary the stub is unchanged", () => {
    const { json, files } = capture(resp());
    expect(files).toHaveLength(1);
    expect(json.body).toEqual({ _binary: true, _bytes: 3, _contentType: "image/jpeg" });
  });
});

describe("Sniffer.shouldCapture", () => {
  test("follows mode and filters", () => {
    const sniffer = new Sniffer(new CredentialVault());
    const should = sniffer.asEvents().shouldCapture;
    expect(should?.("s", "https://x/a")).toBe(false);
    sniffer.configureSite("s", "filtered", { match: ["/keep/"], skip: [] });
    expect(should?.("s", "https://x/keep/a")).toBe(true);
    expect(should?.("s", "https://x/drop/a")).toBe(false);
    sniffer.setMode("s", "firehose");
    expect(should?.("s", "https://x/drop/a")).toBe(true);
  });
});

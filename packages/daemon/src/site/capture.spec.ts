import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import {
  type CaptureJq,
  type CaptureSample,
  DEFAULT_CAPTURE_SCAN_LIMIT,
  MAX_CAPTURE_SCAN_LIMIT,
  buildSample,
  captureUrlPrefilter,
  clampScanLimit,
  clearVars,
  extractVars,
  loadVars,
  mergeCapturedVars,
  readCaptureSamples,
  saveVars,
} from "./capture";
import type { CaptureVarSpec } from "./config";
import { siteCapturesDir } from "./paths";
import { BUILTIN_SEEDS } from "./seeds";
import { bunJqRunner } from "./transforms";

const OWA_SEED = BUILTIN_SEEDS.owa;

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `mcp-cli-site-cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  options.SITES_DIR = join(tmp, "sites");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _restoreOptions();
});

/** jq stand-in: resolves a dotted path against the sample, so specs need no jq binary. */
const pathJq: CaptureJq = async (expression, input) => {
  const doc = JSON.parse(input) as Record<string, unknown>;
  let cur: unknown = doc;
  for (const seg of expression.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur === undefined ? "" : JSON.stringify(cur);
};

function captureFile(url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _meta: { at: "t", url, method: "POST", status: 200, contentType: "application/json", bytes: 1 },
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    body: null,
    ...extra,
  };
}

describe("buildSample", () => {
  test("lower-cases request and response header names", () => {
    const s = buildSample(
      "f.json",
      captureFile("https://e.example/a", {
        requestHeaders: { "X-AnchorMailbox": "PUID:abc@tenant" },
        responseHeaders: { "Content-Type": "application/json" },
      }),
    );
    expect(s?.requestHeaders["x-anchormailbox"]).toBe("PUID:abc@tenant");
    expect(s?.responseHeaders["content-type"]).toBe("application/json");
  });

  test("parses JSON post data into requestBody", () => {
    const s = buildSample("f.json", captureFile("https://e.example/a", { requestPostData: '{"a":1}' }));
    expect(s?.requestBody).toEqual({ a: 1 });
  });

  test("keeps non-JSON post data as a raw string", () => {
    const s = buildSample("f.json", captureFile("https://e.example/a", { requestPostData: "a=1&b=2" }));
    expect(s?.requestBody).toBe("a=1&b=2");
  });

  test("decodes x-owa-urlpostdata when there is no post data (inverse of the owa-urlpostdata filter)", () => {
    const body = { Body: { ParentFolderId: { BaseFolderId: { Id: "AAMk=" } } } };
    const s = buildSample(
      "f.json",
      captureFile("https://outlook.cloud.microsoft/owa/service.svc?action=FindConversation", {
        requestHeaders: { "x-owa-urlpostdata": encodeURIComponent(JSON.stringify(body)) },
      }),
    );
    expect(s?.requestBody).toEqual(body);
  });

  test("post data wins over the urlpostdata header", () => {
    const s = buildSample(
      "f.json",
      captureFile("https://e.example/a", {
        requestPostData: '{"from":"postdata"}',
        requestHeaders: { "x-owa-urlpostdata": encodeURIComponent('{"from":"header"}') },
      }),
    );
    expect(s?.requestBody).toEqual({ from: "postdata" });
  });

  test("returns null for records without a url", () => {
    expect(buildSample("f.json", { _meta: {} })).toBeNull();
    expect(buildSample("f.json", "nope")).toBeNull();
  });
});

describe("readCaptureSamples", () => {
  test("returns empty when the captures dir does not exist", () => {
    expect(readCaptureSamples(siteCapturesDir("nosuch"))).toEqual([]);
  });

  test("reads newest-first and skips unparseable files", () => {
    const dir = siteCapturesDir("owa");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z-POST-a.json"), JSON.stringify(captureFile("https://e/old")));
    writeFileSync(join(dir, "2026-01-02T00-00-00-000Z-POST-b.json"), JSON.stringify(captureFile("https://e/new")));
    writeFileSync(join(dir, "2026-01-03T00-00-00-000Z-POST-c.json"), "{ truncated");

    const samples = readCaptureSamples(dir);
    expect(samples.map((s) => s.url)).toEqual(["https://e/new", "https://e/old"]);
  });

  test("honors the scan limit", () => {
    const dir = siteCapturesDir("owa");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `2026-01-0${i + 1}-POST-x.json`), JSON.stringify(captureFile(`https://e/${i}`)));
    }
    expect(readCaptureSamples(dir, 2)).toHaveLength(2);
  });

  test("a url prefilter skips non-candidate files without changing which remain", () => {
    const dir = siteCapturesDir("owa");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-01-POST-a.json"),
      JSON.stringify(captureFile("https://e/owa/service.svc?action=X")),
    );
    writeFileSync(join(dir, "2026-01-02-POST-b.json"), JSON.stringify(captureFile("https://cdn/bundle.js")));

    const samples = readCaptureSamples(dir, 100, /service\.svc/i);
    expect(samples.map((s) => s.url)).toEqual(["https://e/owa/service.svc?action=X"]);
  });
});

function sample(url: string, over: Partial<CaptureSample> = {}): CaptureSample {
  return {
    file: "f.json",
    url,
    method: "POST",
    status: 200,
    requestHeaders: {},
    requestBody: null,
    responseHeaders: {},
    responseBody: null,
    ...over,
  };
}

describe("extractVars", () => {
  const spec: CaptureVarSpec = { name: "anchorMailbox", jq: "requestHeaders.x-anchormailbox" };

  test("extracts the first non-empty value, newest sample first", async () => {
    const samples = [
      sample("https://e/1"),
      sample("https://e/2", { requestHeaders: { "x-anchormailbox": "PUID:newer" } }),
      sample("https://e/3", { requestHeaders: { "x-anchormailbox": "PUID:older" } }),
    ];
    const out = await extractVars([spec], samples, pathJq);
    expect(out.vars).toEqual({ anchorMailbox: "PUID:newer" });
    expect(out.missing).toEqual([]);
    expect(out.scanned).toBe(3);
  });

  test("reports a var as missing when no sample yields a value", async () => {
    const out = await extractVars([spec], [sample("https://e/1")], pathJq);
    expect(out.vars).toEqual({});
    expect(out.missing).toEqual(["anchorMailbox"]);
  });

  test("urlMatch restricts which samples are considered", async () => {
    const scoped: CaptureVarSpec = { ...spec, urlMatch: "action=FindConversation" };
    const samples = [
      sample("https://e/other", { requestHeaders: { "x-anchormailbox": "wrong" } }),
      sample("https://e/x?action=FindConversation", { requestHeaders: { "x-anchormailbox": "right" } }),
    ];
    const out = await extractVars([scoped], samples, pathJq);
    expect(out.vars.anchorMailbox).toBe("right");
  });

  test("an invalid urlMatch regex is a miss, not a widened search", async () => {
    const bad: CaptureVarSpec = { ...spec, urlMatch: "([" };
    const samples = [sample("https://e/1", { requestHeaders: { "x-anchormailbox": "v" } })];
    const out = await extractVars([bad], samples, pathJq);
    expect(out.vars).toEqual({});
    expect(out.missing).toEqual(["anchorMailbox"]);
  });

  test("keeps scanning when jq throws on an unrelated sample", async () => {
    let calls = 0;
    const flaky: CaptureJq = async (expr, input) => {
      calls++;
      if (calls === 1) throw new Error("jq exited 5: type error");
      return pathJq(expr, input);
    };
    const samples = [sample("https://e/1"), sample("https://e/2", { requestHeaders: { "x-anchormailbox": "v" } })];
    const out = await extractVars([spec], samples, flaky);
    expect(out.vars.anchorMailbox).toBe("v");
  });

  test("empty strings, null, and non-scalars are misses", async () => {
    const specs: CaptureVarSpec[] = [
      { name: "emptyString", jq: "requestHeaders.blank" },
      { name: "nullValue", jq: "requestBody" },
      { name: "objectValue", jq: "responseBody" },
    ];
    const samples = [sample("https://e/1", { requestHeaders: { blank: "" }, responseBody: { a: 1 } })];
    const out = await extractVars(specs, samples, pathJq);
    expect(out.vars).toEqual({});
    expect(out.missing.sort()).toEqual(["emptyString", "nullValue", "objectValue"]);
  });

  test("coerces numeric jq output to a string", async () => {
    const out = await extractVars([{ name: "status", jq: "status" }], [sample("https://e/1")], pathJq);
    expect(out.vars).toEqual({ status: "200" });
  });

  test("takes the first line when jq emits multiple results", async () => {
    const multi: CaptureJq = async () => '"first"\n"second"\n';
    const out = await extractVars([spec], [sample("https://e/1")], multi);
    expect(out.vars.anchorMailbox).toBe("first");
  });
});

// The owa seed's captureVars are jq expressions, so they're only meaningfully
// exercised against the real binary. Skipped where jq isn't installed (the
// daemon reports a clear spawn error in that case).
describe.skipIf(!Bun.which("jq"))("owa seed captureVars", () => {
  const specs = OWA_SEED.config.captureVars ?? [];
  const findConversation = "https://outlook.cloud.microsoft/owa/service.svc?action=FindConversation&app=Mail";
  const userConfiguration = "https://outlook.cloud.microsoft/owa/service.svc?action=GetOwaUserConfiguration&app=Mail";

  // Distinct ids per folder, so an assertion can tell the inbox from any other
  // folder. A fixture where every folder shares one id would pass against a
  // spec that picked the wrong folder, which is how the inversion shipped green.
  const INBOX_ID = "AAMkAGZvbGRlcgAuAAAAAAEMAAA=";
  const SENT_ITEMS_ID = "AAMkAGZvbGRlcgAuAAAAAAEJAAA=";
  const DELETED_ITEMS_ID = "AAMkAGZvbGRlcgAuAAAAAAEDAAA=";

  /**
   * A session-config response carrying the authoritative folder table. The
   * name→id mapping is positional across two parallel arrays, and the real
   * payload has a `None` entry first plus null holes, so the fixture keeps both
   * — an implementation that assumed dense, aligned arrays would mis-index.
   */
  function userConfigurationSample(): CaptureSample {
    return sample(userConfiguration, {
      responseBody: {
        SessionSettings: {
          DefaultFolderNames: ["None", "calendar", null, "sentitems", "deleteditems", "inbox", "drafts"],
          DefaultFolderIds: [
            null,
            { __type: "FolderId:#Exchange", Id: "AAMkAGZvbGRlcgAuAAAAAAEBAAA=" },
            null,
            { __type: "FolderId:#Exchange", Id: SENT_ITEMS_ID },
            { __type: "FolderId:#Exchange", Id: DELETED_ITEMS_ID },
            { __type: "FolderId:#Exchange", Id: INBOX_ID },
            { __type: "FolderId:#Exchange", Id: "AAMkAGZvbGRlcgAuAAAAAAEPAAA=" },
          ],
        },
      },
    });
  }

  /** A FindConversation request, i.e. the traffic the folder id used to be inferred from. */
  function findConversationSample(baseFolderId: Record<string, string>, headers: Record<string, string> = {}) {
    const body = { Body: { ParentFolderId: { BaseFolderId: baseFolderId } } };
    return sample(findConversation, {
      requestHeaders: { "x-owa-urlpostdata": encodeURIComponent(JSON.stringify(body)), ...headers },
      requestBody: body,
    });
  }

  test("declares the two per-mailbox vars from #1540", () => {
    expect(specs.map((s) => s.name).sort()).toEqual(["anchorMailbox", "inboxFolderId"]);
  });

  test("captures the inbox folder id, not merely some concrete folder id", async () => {
    const out = await extractVars(specs, [userConfigurationSample()], bunJqRunner);

    expect(out.vars.inboxFolderId).toBe(INBOX_ID);
    // The distinguishing assertions: any other folder in the same table is wrong.
    expect(out.vars.inboxFolderId).not.toBe(SENT_ITEMS_ID);
    expect(out.vars.inboxFolderId).not.toBe(DELETED_ITEMS_ID);
  });

  test("ignores the folder a request happened to target, which is whatever was last browsed", async () => {
    // Newest-first order that reproduces the original defect: the most recent
    // concrete-id request is for Sent Items, so inferring from traffic captured
    // Sent Items and stored it as the inbox.
    const out = await extractVars(
      specs,
      [
        findConversationSample({ __type: "FolderId:#Exchange", Id: SENT_ITEMS_ID }),
        findConversationSample({ __type: "FolderId:#Exchange", Id: DELETED_ITEMS_ID }),
        userConfigurationSample(),
        findConversationSample({ __type: "FolderId:#Exchange", Id: INBOX_ID }),
      ],
      bunJqRunner,
    );

    expect(out.vars.inboxFolderId).toBe(INBOX_ID);
  });

  test("captures the x-anchormailbox value from request traffic", async () => {
    const out = await extractVars(
      specs,
      [findConversationSample({ __type: "DistinguishedFolderId:#Exchange", Id: "inbox" }, { "x-anchormailbox": "id" })],
      bunJqRunner,
    );
    expect(out.vars.anchorMailbox).toBe("id");
  });

  test("reports the folder id missing rather than guessing when the folder table is absent", async () => {
    const out = await extractVars(
      specs,
      [sample(userConfiguration, { responseBody: { SessionSettings: {} } })],
      bunJqRunner,
    );
    expect(out.vars.inboxFolderId).toBeUndefined();
    expect(out.missing).toContain("inboxFolderId");
  });

  test("reports the folder id missing when the table has no inbox entry", async () => {
    const out = await extractVars(
      specs,
      [
        sample(userConfiguration, {
          responseBody: {
            SessionSettings: {
              DefaultFolderNames: ["sentitems"],
              DefaultFolderIds: [{ __type: "FolderId:#Exchange", Id: SENT_ITEMS_ID }],
            },
          },
        }),
      ],
      bunJqRunner,
    );
    expect(out.vars.inboxFolderId).toBeUndefined();
    expect(out.missing).toContain("inboxFolderId");
  });

  test("tolerates a non-JSON body without erroring", async () => {
    const out = await extractVars(
      specs,
      [sample(findConversation, { requestBody: "not-json" }), sample(userConfiguration, { responseBody: "not-json" })],
      bunJqRunner,
    );
    expect(out.missing.sort()).toEqual(["anchorMailbox", "inboxFolderId"]);
  });
});

describe("vars persistence", () => {
  test("loadVars is empty before capture and round-trips after save", () => {
    expect(loadVars("owa")).toEqual({});
    saveVars("owa", { inboxFolderId: "AAMk=" });
    expect(loadVars("owa")).toEqual({ inboxFolderId: "AAMk=" });
  });

  test("ignores non-string values and unparseable files", () => {
    saveVars("owa", {});
    writeFileSync(join(options.SITES_DIR, "owa", "vars.json"), '{"a":"ok","b":7,"c":{"d":1}}');
    expect(loadVars("owa")).toEqual({ a: "ok" });

    writeFileSync(join(options.SITES_DIR, "owa", "vars.json"), "not json");
    expect(loadVars("owa")).toEqual({});
  });

  test("clearVars removes every captured value and reports the names dropped", () => {
    saveVars("owa", { inboxFolderId: "wrong", anchorMailbox: "id" });
    expect(clearVars("owa").sort()).toEqual(["anchorMailbox", "inboxFolderId"]);
    expect(loadVars("owa")).toEqual({});
  });

  test("clearVars on a site that was never captured is a no-op", () => {
    expect(clearVars("owa")).toEqual([]);
    expect(loadVars("owa")).toEqual({});
  });
});

describe("mergeCapturedVars", () => {
  const specs: CaptureVarSpec[] = [
    { name: "inboxFolderId", jq: "x" },
    { name: "anchorMailbox", jq: "y" },
  ];

  test("a re-capture replaces a previously stored value", () => {
    const merged = mergeCapturedVars({ inboxFolderId: "wrong" }, specs, { inboxFolderId: "right" });
    expect(merged.inboxFolderId).toBe("right");
  });

  test("a declared name that this run could not extract is dropped, not left stale", () => {
    // The whole point of the invalidation: fixing a spec and re-capturing must
    // not leave the previous wrong value in place when the new spec finds nothing.
    const merged = mergeCapturedVars({ inboxFolderId: "wrong", anchorMailbox: "id" }, specs, { anchorMailbox: "id" });
    expect(merged).toEqual({ anchorMailbox: "id" });
  });

  test("names no spec declares are operator-authored and survive", () => {
    const merged = mergeCapturedVars({ handEdited: "keep", inboxFolderId: "wrong" }, specs, {});
    expect(merged).toEqual({ handEdited: "keep" });
  });
});

describe("clampScanLimit", () => {
  test("defaults when the limit is absent or not a finite number", () => {
    expect(clampScanLimit(undefined)).toBe(DEFAULT_CAPTURE_SCAN_LIMIT);
    expect(clampScanLimit("200")).toBe(DEFAULT_CAPTURE_SCAN_LIMIT);
    expect(clampScanLimit(Number.NaN)).toBe(DEFAULT_CAPTURE_SCAN_LIMIT);
    expect(clampScanLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CAPTURE_SCAN_LIMIT);
  });

  test("caps the scan so one call cannot walk an entire corpus on the single-threaded worker", () => {
    expect(clampScanLimit(10_000_000)).toBe(MAX_CAPTURE_SCAN_LIMIT);
  });

  test("floors at one, so zero or negative cannot mean unbounded", () => {
    expect(clampScanLimit(0)).toBe(1);
    expect(clampScanLimit(-5)).toBe(1);
  });

  test("passes an in-range limit through, truncating fractions", () => {
    expect(clampScanLimit(42)).toBe(42);
    expect(clampScanLimit(42.9)).toBe(42);
  });
});

describe("captureUrlPrefilter", () => {
  test("matches a file whose text contains any spec's url pattern", () => {
    const re = captureUrlPrefilter([
      { name: "a", jq: "x", urlMatch: "action=GetOwaUserConfiguration" },
      { name: "b", jq: "y", urlMatch: "owa/service\\.svc" },
    ]);
    expect(re?.test('{"url":"https://e/owa/service.svc?action=FindConversation"}')).toBe(true);
    expect(re?.test('{"url":"https://cdn/script.js"}')).toBe(false);
  });

  test("disables itself when a spec has no urlMatch, so no sample is skipped", () => {
    expect(captureUrlPrefilter([{ name: "a", jq: "x" }])).toBeNull();
  });

  test("disables itself for an anchored pattern, which cannot be tested against whole-file text", () => {
    expect(captureUrlPrefilter([{ name: "a", jq: "x", urlMatch: "^https://e/" }])).toBeNull();
  });

  test("disables itself for an unparseable pattern rather than throwing", () => {
    expect(captureUrlPrefilter([{ name: "a", jq: "x", urlMatch: "([" }])).toBeNull();
  });
});

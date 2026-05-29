import { describe, expect, test } from "bun:test";
import type { Provider } from "../agent-grid/versions-schema";
import {
  type ProposedRow,
  REGISTRY,
  detectNewVersions,
  formatJson,
  formatYaml,
  matchesTrack,
  parseSemVer,
  queryNpmVersion,
} from "./agent-grid-detect";

// ── parseSemVer ───────────────────────────────────────────────────

describe("parseSemVer", () => {
  test("parses standard semver", () => {
    expect(parseSemVer("2.1.119")).toEqual({ major: 2, minor: 1, patch: 119, prerelease: "" });
  });

  test("parses semver with prerelease suffix", () => {
    const result = parseSemVer("0.30.1-beta.2");
    expect(result).toEqual({ major: 0, minor: 30, patch: 1, prerelease: "-beta.2" });
  });

  test("returns null for non-semver", () => {
    expect(parseSemVer("latest")).toBeNull();
    expect(parseSemVer("")).toBeNull();
    expect(parseSemVer("abc")).toBeNull();
  });
});

// ── matchesTrack ──────────────────────────────────────────────────

describe("matchesTrack", () => {
  const known = { major: 2, minor: 1, patch: 119, prerelease: "" };

  test("patch track: same major.minor passes", () => {
    const latest = { major: 2, minor: 1, patch: 200, prerelease: "" };
    expect(matchesTrack(latest, known, "patch")).toBe(true);
  });

  test("patch track: different minor fails", () => {
    const latest = { major: 2, minor: 2, patch: 0, prerelease: "" };
    expect(matchesTrack(latest, known, "patch")).toBe(false);
  });

  test("minor track: same major passes", () => {
    const latest = { major: 2, minor: 5, patch: 0, prerelease: "" };
    expect(matchesTrack(latest, known, "minor")).toBe(true);
  });

  test("minor track: different major fails", () => {
    const latest = { major: 3, minor: 0, patch: 0, prerelease: "" };
    expect(matchesTrack(latest, known, "minor")).toBe(false);
  });

  test("major track: always passes", () => {
    const latest = { major: 99, minor: 0, patch: 0, prerelease: "" };
    expect(matchesTrack(latest, known, "major")).toBe(true);
  });
});

// ── detectNewVersions ─────────────────────────────────────────────

describe("detectNewVersions", () => {
  const makeProvider = (overrides: Partial<Provider> & { name: Provider["name"] }): Provider => ({
    track: "patch",
    enabled: true,
    versions: [],
    ...overrides,
  });

  test("proposes new version when not already tracked", () => {
    const providers: Provider[] = [
      makeProvider({
        name: "claude",
        versions: [{ version: "2.1.119", outcome: "pass" }],
      }),
    ];
    const queryer = () => "2.1.156";
    const { proposed, errors } = detectNewVersions(providers, queryer);
    expect(errors).toHaveLength(0);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.provider).toBe("claude");
    expect(proposed[0]?.entry.version).toBe("2.1.156");
    expect(proposed[0]?.entry.outcome).toBe("untested");
  });

  test("skips when version already tracked", () => {
    const providers: Provider[] = [
      makeProvider({
        name: "claude",
        versions: [{ version: "2.1.156", outcome: "pass" }],
      }),
    ];
    const queryer = () => "2.1.156";
    const { proposed, skipped } = detectNewVersions(providers, queryer);
    expect(proposed).toHaveLength(0);
    expect(skipped.some((s) => s.reason.includes("already tracked"))).toBe(true);
  });

  test("skips disabled providers", () => {
    const providers: Provider[] = [makeProvider({ name: "grok", enabled: false })];
    const queryer = () => "1.0.0";
    const { proposed, skipped } = detectNewVersions(providers, queryer);
    expect(proposed).toHaveLength(0);
    expect(skipped.some((s) => s.reason === "disabled")).toBe(true);
  });

  test("skips mock provider", () => {
    const providers: Provider[] = [makeProvider({ name: "mock" })];
    const queryer = () => "1.0.0";
    const { proposed, skipped } = detectNewVersions(providers, queryer);
    expect(proposed).toHaveLength(0);
    expect(skipped.some((s) => s.reason.includes("mock"))).toBe(true);
  });

  test("skips providers without registry config", () => {
    const providers: Provider[] = [makeProvider({ name: "copilot" })];
    const queryer = () => "1.0.0";
    const { proposed, skipped } = detectNewVersions(providers, queryer);
    expect(proposed).toHaveLength(0);
    expect(skipped.some((s) => s.reason.includes("no registry"))).toBe(true);
  });

  test("reports error when query fails", () => {
    const providers: Provider[] = [makeProvider({ name: "claude" })];
    const queryer = () => null;
    const { proposed, errors } = detectNewVersions(providers, queryer);
    expect(proposed).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("failed to query");
  });

  test("skips version outside patch track", () => {
    const providers: Provider[] = [
      makeProvider({
        name: "claude",
        track: "patch",
        versions: [{ version: "2.1.119", outcome: "pass" }],
      }),
    ];
    const queryer = () => "2.2.0";
    const { proposed, skipped } = detectNewVersions(providers, queryer);
    expect(proposed).toHaveLength(0);
    expect(skipped.some((s) => s.reason.includes("outside patch track"))).toBe(true);
  });

  test("allows version within minor track", () => {
    const providers: Provider[] = [
      makeProvider({
        name: "codex",
        track: "minor",
        versions: [{ version: "0.30.1", outcome: "fail", failure_class: "spawn-failed" }],
      }),
    ];
    const queryer = () => "0.135.0";
    const { proposed } = detectNewVersions(providers, queryer);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.entry.version).toBe("0.135.0");
  });

  test("proposes for provider with no existing versions", () => {
    const providers: Provider[] = [makeProvider({ name: "opencode", track: "minor", versions: [] })];
    const queryer = () => "1.15.12";
    const { proposed } = detectNewVersions(providers, queryer);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.entry.version).toBe("1.15.12");
  });

  test("reports error for unparseable version", () => {
    const providers: Provider[] = [makeProvider({ name: "claude" })];
    const queryer = () => "not-a-version";
    const { proposed, errors } = detectNewVersions(providers, queryer);
    expect(proposed).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("cannot parse");
  });
});

// ── queryNpmVersion ───────────────────────────────────────────────

describe("queryNpmVersion", () => {
  test("returns version from successful spawn", () => {
    const mockSpawn = () => ({ status: 0, stdout: "2.1.156\n", stderr: "", pid: 0, signal: null, output: [] });
    const result = queryNpmVersion("@anthropic-ai/claude-code", mockSpawn as Parameters<typeof queryNpmVersion>[1]);
    expect(result).toBe("2.1.156");
  });

  test("returns null on spawn failure", () => {
    const mockSpawn = () => ({ status: 1, stdout: "", stderr: "not found", pid: 0, signal: null, output: [] });
    const result = queryNpmVersion("@nonexistent/pkg", mockSpawn as Parameters<typeof queryNpmVersion>[1]);
    expect(result).toBeNull();
  });

  test("returns null on empty output", () => {
    const mockSpawn = () => ({ status: 0, stdout: "", stderr: "", pid: 0, signal: null, output: [] });
    const result = queryNpmVersion("@empty/pkg", mockSpawn as Parameters<typeof queryNpmVersion>[1]);
    expect(result).toBeNull();
  });
});

// ── REGISTRY ──────────────────────────────────────────────────────

describe("REGISTRY", () => {
  test("has entries for claude, codex, opencode", () => {
    expect(REGISTRY.claude?.npm).toBe("@anthropic-ai/claude-code");
    expect(REGISTRY.codex?.npm).toBe("@openai/codex");
    expect(REGISTRY.opencode?.npm).toBe("opencode-ai");
  });

  test("does not have entries for stub providers", () => {
    expect(REGISTRY.grok).toBeUndefined();
    expect(REGISTRY.copilot).toBeUndefined();
    expect(REGISTRY.gemini).toBeUndefined();
    expect(REGISTRY.mock).toBeUndefined();
  });
});

// ── Output formatters ─────────────────────────────────────────────

describe("formatYaml", () => {
  test("renders proposed rows as pasteable YAML", () => {
    const rows: ProposedRow[] = [
      {
        provider: "claude",
        track: "patch",
        entry: { version: "2.1.156", first_seen: "2026-05-29T12:00:00Z", outcome: "untested" },
      },
    ];
    const out = formatYaml(rows);
    expect(out).toContain("claude");
    expect(out).toContain('version: "2.1.156"');
    expect(out).toContain("outcome: untested");
  });
});

describe("formatJson", () => {
  test("renders valid JSON", () => {
    const rows: ProposedRow[] = [
      {
        provider: "codex",
        track: "patch",
        entry: { version: "0.135.0", first_seen: "2026-05-29T12:00:00Z", outcome: "untested" },
      },
    ];
    const parsed = JSON.parse(formatJson(rows));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].provider).toBe("codex");
  });
});

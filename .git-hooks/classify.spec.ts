import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const CLASSIFY_SH = resolve(import.meta.dir, "classify.sh");

/** Run classify_files on a list of filenames, return { has_source, has_config } */
async function classify(files: string[]): Promise<{ has_source: boolean; has_config: boolean }> {
  const input = files.join("\n");
  const script = `
    source "${CLASSIFY_SH}"
    classify_files <<'__FILES__'
${input}
__FILES__
    echo "has_source=$has_source"
    echo "has_config=$has_config"
  `;
  const proc = Bun.spawn(["bash", "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`classify.sh exited ${code}: ${err}`);
  }
  const lines = text.trim().split("\n");
  const vars: Record<string, boolean> = {};
  for (const line of lines) {
    const [key, val] = line.split("=");
    vars[key] = val === "true";
  }
  return {
    has_source: vars.has_source ?? false,
    has_config: vars.has_config ?? false,
  };
}

describe("pre-commit classify_files", () => {
  test("docs-only: markdown files", async () => {
    const result = await classify(["README.md", ".claude/sprints/sprint-15.md", "CLAUDE.md"]);
    expect(result.has_source).toBe(false);
    expect(result.has_config).toBe(false);
  });

  test("docs-only: .claude/ non-markdown files", async () => {
    const result = await classify([".claude/diary/20260318.md", ".claude/arcs.md"]);
    expect(result.has_source).toBe(false);
    expect(result.has_config).toBe(false);
  });

  test("config-only: JSON files", async () => {
    const result = await classify(["package.json", "tsconfig.json"]);
    expect(result.has_source).toBe(false);
    expect(result.has_config).toBe(true);
  });

  test("config-only: scripts/ and .git-hooks/", async () => {
    const result = await classify(["scripts/check-coverage.ts", ".git-hooks/pre-commit"]);
    expect(result.has_source).toBe(false);
    expect(result.has_config).toBe(true);
  });

  test("source: TypeScript files in packages/", async () => {
    const result = await classify(["packages/core/src/foo.ts", "packages/daemon/src/bar.ts"]);
    expect(result.has_source).toBe(true);
    expect(result.has_config).toBe(false);
  });

  test("mixed docs+config → config tier", async () => {
    const result = await classify(["README.md", "package.json"]);
    expect(result.has_source).toBe(false);
    expect(result.has_config).toBe(true);
  });

  test("mixed docs+source → source tier", async () => {
    const result = await classify(["README.md", "packages/core/src/foo.ts"]);
    expect(result.has_source).toBe(true);
    expect(result.has_config).toBe(false);
  });

  test("mixed all three → source tier", async () => {
    const result = await classify(["README.md", "package.json", "packages/core/src/foo.ts"]);
    expect(result.has_source).toBe(true);
    expect(result.has_config).toBe(true);
  });

  test("empty file list → neither flag set", async () => {
    const result = await classify([]);
    expect(result.has_source).toBe(false);
    expect(result.has_config).toBe(false);
  });
});

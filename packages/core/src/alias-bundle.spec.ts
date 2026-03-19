import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleAlias,
  computeSourceHash,
  executeAliasBundled,
  extractMetadata,
  stripMcpCliImport,
  stubProxy,
} from "./alias-bundle";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `alias-bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("stubProxy", () => {
  test("returns undefined for any server.tool() call", async () => {
    const result = await stubProxy.anyServer.anyTool({ key: "value" });
    expect(result).toBeUndefined();
  });

  test("returns undefined for different server/tool combinations", async () => {
    expect(await stubProxy.foo.bar()).toBeUndefined();
    expect(await stubProxy.baz.qux({ a: 1 })).toBeUndefined();
  });

  test("server proxy returns function for any tool name", () => {
    const server = stubProxy.myServer;
    expect(typeof server.tool1).toBe("function");
    expect(typeof server.tool2).toBe("function");
  });
});

describe("stripMcpCliImport", () => {
  test("strips ESM named import", () => {
    const input = `import { defineAlias, z } from "mcp-cli";\nconsole.log("hello");`;
    const result = stripMcpCliImport(input);
    expect(result.trim()).toBe('console.log("hello");');
  });

  test("strips ESM default import", () => {
    const input = `import sdk from "mcp-cli";\nconsole.log("hello");`;
    const result = stripMcpCliImport(input);
    expect(result.trim()).toBe('console.log("hello");');
  });

  test("strips CJS require with var", () => {
    const input = `var { defineAlias, z } = require("mcp-cli");\nconsole.log("hello");`;
    const result = stripMcpCliImport(input);
    expect(result.trim()).toBe('console.log("hello");');
  });

  test("strips CJS require with const", () => {
    const input = `const { defineAlias } = require("mcp-cli");\nconsole.log("hello");`;
    const result = stripMcpCliImport(input);
    expect(result.trim()).toBe('console.log("hello");');
  });

  test("preserves non-mcp-cli imports", () => {
    const input = `import { z } from "zod";\nconsole.log("hello");`;
    const result = stripMcpCliImport(input);
    expect(result).toBe(input);
  });

  test("strips multi-line ESM import from Bun.build", () => {
    const input = `import {\n  defineAlias,\n  z\n} from "mcp-cli";\nconsole.log("hello");`;
    const result = stripMcpCliImport(input);
    expect(result.trim()).toBe('console.log("hello");');
  });

  test("handles single quotes", () => {
    const input = `import { defineAlias } from 'mcp-cli';\nconsole.log("hello");`;
    const result = stripMcpCliImport(input);
    expect(result.trim()).toBe('console.log("hello");');
  });
});

describe("bundleAlias", () => {
  test("bundles a simple defineAlias script", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "test-alias.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "test",',
        '  description: "A test alias",',
        "  input: z.object({ name: z.string() }),",
        "  fn: (input) => `Hello, ${input.name}!`,",
        "});",
      ].join("\n"),
    );

    const result = await bundleAlias(scriptPath);
    expect(result.js).toBeDefined();
    expect(result.js.length).toBeGreaterThan(0);
    expect(result.sourceHash).toBeDefined();
    expect(result.sourceHash.length).toBe(64); // SHA-256 hex
  });

  test("throws on invalid TypeScript", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "bad.ts");
    writeFileSync(scriptPath, "this is not valid typescript {{{");

    await expect(bundleAlias(scriptPath)).rejects.toThrow();
  });
});

describe("computeSourceHash", () => {
  test("returns consistent hash for same content", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "hash-test.ts");
    writeFileSync(path, "const x = 1;");

    const hash1 = await computeSourceHash(path);
    const hash2 = await computeSourceHash(path);
    expect(hash1).toBe(hash2);
  });

  test("returns different hash for different content", async () => {
    const dir = makeTmpDir();
    const path1 = join(dir, "hash-a.ts");
    const path2 = join(dir, "hash-b.ts");
    writeFileSync(path1, "const x = 1;");
    writeFileSync(path2, "const x = 2;");

    const hash1 = await computeSourceHash(path1);
    const hash2 = await computeSourceHash(path2);
    expect(hash1).not.toBe(hash2);
  });
});

describe("extractMetadata", () => {
  test("extracts name and description from bundled defineAlias", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "meta-test.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "greet",',
        '  description: "Greet someone",',
        "  input: z.object({ name: z.string() }),",
        "  output: z.object({ message: z.string() }),",
        "  fn: (input) => ({ message: `Hello, ${input.name}!` }),",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const meta = await extractMetadata(js);

    expect(meta.name).toBe("greet");
    expect(meta.description).toBe("Greet someone");
    expect(meta.inputSchema).toBeDefined();
    expect(meta.outputSchema).toBeDefined();
  });

  test("extracts metadata from factory-style defineAlias", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "factory-test.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias } from "mcp-cli";',
        "defineAlias(({ z }) => ({",
        '  name: "from-factory",',
        '  description: "Factory alias",',
        "  input: z.object({ text: z.string() }),",
        "  fn: (input) => input.text,",
        "}));",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const meta = await extractMetadata(js);

    expect(meta.name).toBe("from-factory");
    expect(meta.description).toBe("Factory alias");
    expect(meta.inputSchema).toBeDefined();
  });

  test("throws when script does not call defineAlias", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "no-define.ts");
    writeFileSync(scriptPath, "const x = 1;");

    const { js } = await bundleAlias(scriptPath);
    await expect(extractMetadata(js)).rejects.toThrow("did not call defineAlias");
  });
});

describe("executeAliasBundled", () => {
  test("executes a defineAlias script and returns output", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "exec-test.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "greet",',
        "  input: z.object({ name: z.string() }),",
        "  fn: (input) => `Hello, ${input.name}!`,",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const result = await executeAliasBundled(
      js,
      { name: "World" },
      { mcp: stubProxy, args: {}, file: async () => "", json: async () => null, cache: async (_k, p) => p() },
      true,
    );

    expect(result).toBe("Hello, World!");
  });

  test("validates input against schema", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "validate-input.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "typed",',
        "  input: z.object({ count: z.number() }),",
        "  fn: (input) => input.count * 2,",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    await expect(
      executeAliasBundled(
        js,
        { count: "not-a-number" },
        { mcp: stubProxy, args: {}, file: async () => "", json: async () => null, cache: async (_k, p) => p() },
        true,
      ),
    ).rejects.toThrow("Invalid input");
  });

  test("validates output against schema", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "validate-output.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "bad-output",',
        "  output: z.object({ message: z.string() }),",
        "  fn: () => ({ message: 123 }),",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    await expect(
      executeAliasBundled(
        js,
        undefined,
        { mcp: stubProxy, args: {}, file: async () => "", json: async () => null, cache: async (_k, p) => p() },
        true,
      ),
    ).rejects.toThrow("Invalid output");
  });

  test("freeform script returns undefined", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "freeform.ts");
    writeFileSync(scriptPath, "const x = 1 + 1;");

    const { js } = await bundleAlias(scriptPath);
    const result = await executeAliasBundled(
      js,
      undefined,
      { mcp: stubProxy, args: {}, file: async () => "", json: async () => null, cache: async (_k, p) => p() },
      false,
    );

    expect(result).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleAlias,
  computeSourceHash,
  executeAliasBundled,
  extractMetadata,
  stripMcpCliImport,
  stripModuleSyntax,
  stubProxy,
  validateAliasBundled,
} from "./alias-bundle";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `alias-bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const stubState = {
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
  all: async () => ({}),
};

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

  test("strips side-effect import", () => {
    const input = `import "mcp-cli";\nconsole.log("hello");`;
    const result = stripMcpCliImport(input);
    expect(result.trim()).toBe('console.log("hello");');
  });

  test("strips side-effect import with single quotes", () => {
    const input = `import 'mcp-cli';\nconsole.log("hello");`;
    const result = stripMcpCliImport(input);
    expect(result.trim()).toBe('console.log("hello");');
  });
});

describe("stripModuleSyntax", () => {
  test("strips single-line export block", () => {
    const input = "var x = 1;\nexport { x as default };";
    expect(stripModuleSyntax(input).trim()).toBe("var x = 1;");
  });

  test("strips multi-line export block", () => {
    const input = "var x = 1;\nexport {\n  x as default\n};";
    expect(stripModuleSyntax(input).trim()).toBe("var x = 1;");
  });

  test("strips export default statement", () => {
    const input = "var x = 1;\nexport default x;";
    expect(stripModuleSyntax(input).trim()).toBe("var x = 1;");
  });

  test("strips multi-line export default statement", () => {
    const input = ["var x = 1;", "export default defineAlias({", '  name: "test",', "  fn: () => x", "});"].join("\n");
    expect(stripModuleSyntax(input).trim()).toBe("var x = 1;");
  });

  test("strips side-effect import of mcp-cli", () => {
    const input = `import "mcp-cli";\nvar x = 1;`;
    expect(stripModuleSyntax(input).trim()).toBe("var x = 1;");
  });

  test("replaces import.meta with empty object", () => {
    const input = "var url = import.meta.url;\nconsole.log(url);";
    expect(stripModuleSyntax(input)).toContain("({}).url");
    expect(stripModuleSyntax(input)).not.toContain("import.meta");
  });

  test("handles Bun.build typical output with import + export", () => {
    const input = [
      "// @bun",
      'import { defineAlias, z } from "mcp-cli";',
      'var define_test_default = defineAlias({ name: "test", fn: () => 42 });',
      "export {",
      "  define_test_default as default",
      "};",
    ].join("\n");
    const result = stripModuleSyntax(input);
    expect(result).not.toContain("import");
    expect(result).not.toContain("export");
    expect(result).toContain("define_test_default");
  });

  test("backwards compat alias stripMcpCliImport works", () => {
    const input = `import { z } from "mcp-cli";\nexport { z as default };`;
    const result = stripMcpCliImport(input);
    expect(result.trim()).toBe("");
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
      {
        mcp: stubProxy,
        args: {},
        file: async () => "",
        json: async () => null,
        cache: async (_k, p) => p(),
        state: stubState,
        globalState: stubState,
        workItem: null,
      },
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
        {
          mcp: stubProxy,
          args: {},
          file: async () => "",
          json: async () => null,
          cache: async (_k, p) => p(),
          state: stubState,
          globalState: stubState,
          workItem: null,
        },
        true,
      ),
    ).rejects.toThrow("Invalid input");
  });

  test("warns on output schema mismatch instead of throwing", async () => {
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
    const stderrMessages: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => stderrMessages.push(msg);
    try {
      const result = await executeAliasBundled(
        js,
        undefined,
        {
          mcp: stubProxy,
          args: {},
          file: async () => "",
          json: async () => null,
          cache: async (_k, p) => p(),
          state: stubState,
          globalState: stubState,
          workItem: null,
        },
        true,
      );
      // Output is returned despite schema mismatch (warn, don't block)
      expect(result).toEqual({ message: 123 });
      expect(stderrMessages.some((m) => m.includes("Output validation warning"))).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  test("returns validated output when schema matches", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "valid-output.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "good-output",',
        "  output: z.object({ message: z.string() }),",
        '  fn: () => ({ message: "hello" }),',
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const result = await executeAliasBundled(
      js,
      undefined,
      {
        mcp: stubProxy,
        args: {},
        file: async () => "",
        json: async () => null,
        cache: async (_k, p) => p(),
        state: stubState,
        globalState: stubState,
        workItem: null,
      },
      true,
    );
    expect(result).toEqual({ message: "hello" });
  });

  test("executes export default defineAlias script (issue #1410)", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "export-default.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "export default defineAlias({",
        '  name: "test-define",',
        '  description: "test",',
        "  input: z.object({ msg: z.string() }),",
        "  handler: async (input) => ({ echoed: input.msg }),",
        "  fn: async (input) => ({ echoed: input.msg }),",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const result = await executeAliasBundled(
      js,
      { msg: "hi" },
      {
        mcp: stubProxy,
        args: {},
        file: async () => "",
        json: async () => null,
        cache: async (_k, p) => p(),
        state: stubState,
        globalState: stubState,
        workItem: null,
      },
      true,
    );

    expect(result).toEqual({ echoed: "hi" });
  });

  test("freeform script returns undefined", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "freeform.ts");
    writeFileSync(scriptPath, "const x = 1 + 1;");

    const { js } = await bundleAlias(scriptPath);
    const result = await executeAliasBundled(
      js,
      undefined,
      {
        mcp: stubProxy,
        args: {},
        file: async () => "",
        json: async () => null,
        cache: async (_k, p) => p(),
        state: stubState,
        globalState: stubState,
        workItem: null,
      },
      false,
    );

    expect(result).toBeUndefined();
  });
});

describe("validateAliasBundled", () => {
  test("returns valid result for well-formed defineAlias", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "valid.ts");
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
    const result = await validateAliasBundled(js);

    expect(result.valid).toBe(true);
    expect(result.name).toBe("greet");
    expect(result.description).toBe("Greet someone");
    expect(result.inputSchema).toBeDefined();
    expect(result.outputSchema).toBeDefined();
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("reports error when script does not call defineAlias", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "no-define.ts");
    writeFileSync(scriptPath, "const x = 1;");

    const { js } = await bundleAlias(scriptPath);
    const result = await validateAliasBundled(js);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Script did not call defineAlias()");
  });

  test("reports error when name is missing", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "no-name.ts");
    writeFileSync(
      scriptPath,
      ['import { defineAlias } from "mcp-cli";', "defineAlias({", "  fn: () => 42,", "});"].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const result = await validateAliasBundled(js);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("reports error when fn is missing", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "no-fn.ts");
    writeFileSync(
      scriptPath,
      ['import { defineAlias } from "mcp-cli";', "defineAlias({", '  name: "no-fn",', "});"].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const result = await validateAliasBundled(js);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fn"))).toBe(true);
  });

  test("validates without errors when no input/output schemas", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "minimal.ts");
    writeFileSync(
      scriptPath,
      ['import { defineAlias } from "mcp-cli";', "defineAlias({", '  name: "minimal",', "  fn: () => 42,", "});"].join(
        "\n",
      ),
    );

    const { js } = await bundleAlias(scriptPath);
    const result = await validateAliasBundled(js);

    expect(result.valid).toBe(true);
    expect(result.name).toBe("minimal");
  });
});

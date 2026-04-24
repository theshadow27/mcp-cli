import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleAlias,
  computeSourceHash,
  executeAliasBundled,
  extractMetadata,
  extractMonitorMetadata,
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

  describe("@mcp-cli/core rewrite", () => {
    test("rewrites named ESM import", () => {
      const input = `import { findModelInSprintPlan } from "@mcp-cli/core";\nconst m = findModelInSprintPlan(1, ".");`;
      const result = stripModuleSyntax(input);
      expect(result).toContain("const { findModelInSprintPlan } = __mcp_core__;");
      expect(result).not.toContain("@mcp-cli/core");
    });

    test("rewrites multiple named imports", () => {
      const input = `import { foo, bar, baz } from "@mcp-cli/core";\nfoo();`;
      const result = stripModuleSyntax(input);
      expect(result).toContain("const { foo, bar, baz } = __mcp_core__;");
    });

    test("rewrites multi-line named imports (Bun.build output)", () => {
      const input = `import {\n  findModelInSprintPlan,\n  parseModelFromSprintTable\n} from "@mcp-cli/core";\nfoo();`;
      const result = stripModuleSyntax(input);
      expect(result).toMatch(/const \{\s*findModelInSprintPlan, parseModelFromSprintTable\s*\} = __mcp_core__;/);
    });

    test("rewrites aliased imports (X as Y)", () => {
      const input = `import { findModelInSprintPlan as find } from "@mcp-cli/core";\nfind(1, ".");`;
      const result = stripModuleSyntax(input);
      expect(result).toContain("const { findModelInSprintPlan: find } = __mcp_core__;");
    });

    test("rewrites namespace import", () => {
      const input = `import * as core from "@mcp-cli/core";\ncore.foo();`;
      const result = stripModuleSyntax(input);
      expect(result).toContain("const core = __mcp_core__;");
    });

    test("rewrites default import", () => {
      const input = `import core from "@mcp-cli/core";\ncore.foo();`;
      const result = stripModuleSyntax(input);
      expect(result).toContain("const core = __mcp_core__.default ?? __mcp_core__;");
    });

    test("drops side-effect import", () => {
      const input = `import "@mcp-cli/core";\nvar x = 1;`;
      expect(stripModuleSyntax(input).trim()).toBe("var x = 1;");
    });

    test("rewrites CJS named require", () => {
      const input = `var { foo } = require("@mcp-cli/core");\nfoo();`;
      const result = stripModuleSyntax(input);
      expect(result).toContain("var { foo } = __mcp_core__;");
    });

    test("rewrites CJS namespace require", () => {
      const input = `const core = require("@mcp-cli/core");\ncore.foo();`;
      const result = stripModuleSyntax(input);
      expect(result).toContain("const core = __mcp_core__;");
    });

    test("preserves mcp-cli stripping alongside core rewrite", () => {
      const input = `import { defineAlias } from "mcp-cli";\nimport { findModelInSprintPlan } from "@mcp-cli/core";\nfoo();`;
      const result = stripModuleSyntax(input);
      expect(result).not.toContain('from "mcp-cli"');
      expect(result).toContain("const { findModelInSprintPlan } = __mcp_core__;");
    });
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

  test("externalizes @mcp-cli/core (end-to-end)", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "core-import.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        'import { findModelInSprintPlan } from "@mcp-cli/core";',
        "defineAlias({",
        '  name: "core-import-test",',
        "  input: z.object({}),",
        "  fn: () => ({ hasFn: typeof findModelInSprintPlan === 'function' }),",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    // The bundled output should reference @mcp-cli/core (externalized, not inlined)
    expect(js).toContain("@mcp-cli/core");
    // After strip, the import is rewritten to use __mcp_core__
    const stripped = stripModuleSyntax(js);
    expect(stripped).toContain("__mcp_core__");
    expect(stripped).not.toMatch(/import[^;]*from\s*["']@mcp-cli\/core["']/);

    // Execute and verify the core function is reachable at runtime
    const result = await executeAliasBundled(
      js,
      {},
      {
        mcp: stubProxy,
        args: {},
        file: async () => "",
        json: async () => null,
        cache: async (_k, p) => p(),
        state: stubState,
        globalState: stubState,
        workItem: null,
        waitForEvent: async () => {
          throw new Error("not in test");
        },
      },
      true,
    );
    expect(result).toEqual({ hasFn: true });
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
        waitForEvent: async () => {
          throw new Error("not in test");
        },
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
          waitForEvent: async () => {
            throw new Error("not in test");
          },
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
          waitForEvent: async () => {
            throw new Error("not in test");
          },
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
        waitForEvent: async () => {
          throw new Error("not in test");
        },
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
        waitForEvent: async () => {
          throw new Error("not in test");
        },
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
        waitForEvent: async () => {
          throw new Error("not in test");
        },
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

describe("defineMonitor metadata extraction", () => {
  test("extractMonitorMetadata returns monitor defs from a monitor-only alias", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "monitor-only.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineMonitor } from "mcp-cli";',
        "export default defineMonitor({",
        '  name: "flaky-watcher",',
        '  description: "Emits events when tests are flaky.",',
        "  async *subscribe(ctx) { yield { event: 'flaky.detected' }; },",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const defs = await extractMonitorMetadata(js);

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("flaky-watcher");
    expect(defs[0].description).toBe("Emits events when tests are flaky.");
  });

  test("extractMonitorMetadata returns empty array for freeform alias with no defineMonitor", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "freeform.ts");
    writeFileSync(scriptPath, "const x = 1;");

    const { js } = await bundleAlias(scriptPath);
    const defs = await extractMonitorMetadata(js);

    expect(defs).toHaveLength(0);
  });

  test("extractMetadata captures monitorDefs from a mixed file", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "mixed.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, defineMonitor, z } from "mcp-cli";',
        "export const monitor = defineMonitor({",
        '  name: "ci-watcher",',
        '  description: "Watches CI.",',
        "  async *subscribe(ctx) { yield { event: 'ci.failed' }; },",
        "});",
        "export default defineAlias({",
        '  name: "trigger-ci",',
        "  fn: () => 'triggered',",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const meta = await extractMetadata(js);

    expect(meta.name).toBe("trigger-ci");
    expect(meta.monitorDefs).toHaveLength(1);
    expect(meta.monitorDefs?.[0].name).toBe("ci-watcher");
  });

  test("validateAliasBundled includes monitorDefs in result for mixed file", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "mixed-validate.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, defineMonitor } from "mcp-cli";',
        "export const monitor = defineMonitor({",
        '  name: "pr-watcher",',
        "  async *subscribe(ctx) { yield { event: 'pr.opened' }; },",
        "});",
        "defineAlias({",
        '  name: "list-prs",',
        "  fn: () => [],",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const result = await validateAliasBundled(js);

    expect(result.valid).toBe(true);
    expect(result.monitorDefs).toHaveLength(1);
    expect(result.monitorDefs?.[0].name).toBe("pr-watcher");
  });

  test("validateAliasBundled captures monitorDefs even when defineAlias is absent", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "monitor-validate.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineMonitor } from "mcp-cli";',
        "export default defineMonitor({",
        '  name: "deploy-watcher",',
        "  async *subscribe(ctx) { yield { event: 'deploy.started' }; },",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const result = await validateAliasBundled(js);

    // No defineAlias → invalid as an alias, but monitorDefs still captured
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Script did not call defineAlias()");
    expect(result.monitorDefs).toHaveLength(1);
    expect(result.monitorDefs?.[0].name).toBe("deploy-watcher");
  });
});

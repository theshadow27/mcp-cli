import { describe, expect, mock, test } from "bun:test";
import type { AliasDetail, AliasInfo } from "@mcp-cli/core";
import { ExitError } from "../test-helpers";
import type { AliasDeps } from "./alias";
import {
  DEFINE_ALIAS_SKELETON,
  cmdAlias,
  extractDefinitionName,
  extractDescription,
  generatePromotionScaffold,
  parseEphemeralScript,
  parsePromoteArgs,
  wrapDefineAlias,
} from "./alias";

/* ── helpers ─────────────────────────────────────────────────────── */

function makeDeps(overrides?: Partial<AliasDeps>): Partial<AliasDeps> {
  return {
    ipcCall: mock(() => Promise.resolve(undefined)) as AliasDeps["ipcCall"],
    readFileWithLimit: mock(() => "file-content"),
    readStdin: mock(() => Promise.resolve("stdin-content")),
    printError: mock(() => {}),
    printAliasList: mock(() => {}),
    printAliasDebug: mock(() => {}),
    safeAliasPath: mock(() => "/tmp/aliases/test.ts"),
    mkdirSync: mock(() => {}),
    writeFileSync: mock(() => {}),
    spawnSync: mock(() => ({ status: 0 })),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as AliasDeps["exit"],
    log: mock(() => {}),
    logError: mock(() => {}),
    ...overrides,
  };
}

/* ── pure function tests ─────────────────────────────────────────── */

describe("wrapDefineAlias", () => {
  test("wraps object literal into full defineAlias script", () => {
    const code = '{ name: "greet", fn: (name) => `Hello, ${name}!` }';
    const result = wrapDefineAlias(code);
    expect(result).toBe(`import { defineAlias, z } from "mcp-cli";\ndefineAlias(({ mcp, z }) => (${code}));\n`);
  });

  test("includes import and defineAlias sentinel", () => {
    const result = wrapDefineAlias("{}");
    expect(result).toContain('import { defineAlias, z } from "mcp-cli"');
    expect(result).toContain("defineAlias(");
  });
});

describe("extractDefinitionName", () => {
  test("extracts name from double-quoted field", () => {
    expect(extractDefinitionName('{ name: "greet", fn: () => {} }')).toBe("greet");
  });

  test("extracts name from single-quoted field", () => {
    expect(extractDefinitionName("{ name: 'my-tool', fn: () => {} }")).toBe("my-tool");
  });

  test("handles extra whitespace around colon", () => {
    expect(extractDefinitionName('{ name :  "spaced" }')).toBe("spaced");
  });

  test("returns undefined when no name field", () => {
    expect(extractDefinitionName("{ fn: () => {} }")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(extractDefinitionName("")).toBeUndefined();
  });

  test("extracts first name if multiple appear", () => {
    const code = '{ name: "first", nested: { name: "second" } }';
    expect(extractDefinitionName(code)).toBe("first");
  });
});

describe("extractDescription", () => {
  test("extracts description from first 5 lines", () => {
    const script = "// description: My cool tool\nconst x = 1;";
    expect(extractDescription(script)).toBe("My cool tool");
  });

  test("case-insensitive match", () => {
    const script = "// Description: Hello World\n";
    expect(extractDescription(script)).toBe("Hello World");
  });

  test("returns undefined when no description comment", () => {
    expect(extractDescription("const x = 1;\nconst y = 2;")).toBeUndefined();
  });

  test("ignores description after line 5", () => {
    const lines = ["line1", "line2", "line3", "line4", "line5", "// description: too late"];
    expect(extractDescription(lines.join("\n"))).toBeUndefined();
  });

  test("trims whitespace from value", () => {
    expect(extractDescription("// description:   padded  ")).toBe("padded");
  });
});

describe("DEFINE_ALIAS_SKELETON", () => {
  test("contains defineAlias import", () => {
    expect(DEFINE_ALIAS_SKELETON).toContain('import { defineAlias, z } from "mcp-cli"');
  });

  test("contains defineAlias call", () => {
    expect(DEFINE_ALIAS_SKELETON).toContain("defineAlias(");
  });

  test("contains placeholder name", () => {
    expect(DEFINE_ALIAS_SKELETON).toContain('name: "my-alias"');
  });
});

/* ── cmdAlias: ls ────────────────────────────────────────────────── */

describe("cmdAlias ls", () => {
  test("calls ipcCall listAliases and prints list", async () => {
    const aliases: AliasInfo[] = [
      { name: "greet", description: "Say hi", filePath: "/a.ts", updatedAt: 1, aliasType: "freeform" },
    ];
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(aliases)) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["ls"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("listAliases");
    expect(deps.printAliasList).toHaveBeenCalledWith(aliases, { verbose: false });
  });

  test("list is an alias for ls", async () => {
    const deps = makeDeps({ ipcCall: mock(() => Promise.resolve([])) as AliasDeps["ipcCall"] });
    await cmdAlias(["list"], deps);
    expect(deps.ipcCall).toHaveBeenCalledWith("listAliases");
  });

  test("passes verbose flag with -v", async () => {
    const deps = makeDeps({ ipcCall: mock(() => Promise.resolve([])) as AliasDeps["ipcCall"] });
    await cmdAlias(["ls", "-v"], deps);
    expect(deps.printAliasList).toHaveBeenCalledWith([], { verbose: true });
  });

  test("passes verbose flag with --verbose", async () => {
    const deps = makeDeps({ ipcCall: mock(() => Promise.resolve([])) as AliasDeps["ipcCall"] });
    await cmdAlias(["ls", "--verbose"], deps);
    expect(deps.printAliasList).toHaveBeenCalledWith([], { verbose: true });
  });
});

/* ── cmdAlias: save (standard) ──────────────────────────────────── */

describe("cmdAlias save (standard)", () => {
  test("saves inline script", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ ok: true, filePath: "/a.ts" })) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["save", "my-alias", "console.log('hi')"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("saveAlias", {
      name: "my-alias",
      script: "console.log('hi')",
      description: undefined,
    });
    expect(deps.logError).toHaveBeenCalled();
  });

  test("joins multiple inline args", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ ok: true, filePath: "/a.ts" })) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["save", "my-alias", "const", "x", "=", "1"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("saveAlias", {
      name: "my-alias",
      script: "const x = 1",
      description: undefined,
    });
  });

  test("reads from file with @ prefix", async () => {
    const deps = makeDeps({
      readFileWithLimit: mock(() => "// description: from file\nfile content"),
      ipcCall: mock(() => Promise.resolve({ ok: true, filePath: "/a.ts" })) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["save", "my-alias", "@script.ts"], deps);

    expect(deps.readFileWithLimit).toHaveBeenCalledWith("script.ts");
    expect(deps.ipcCall).toHaveBeenCalledWith("saveAlias", {
      name: "my-alias",
      script: "// description: from file\nfile content",
      description: "from file",
    });
  });

  test("reads from stdin when source is -", async () => {
    const deps = makeDeps({
      readStdin: mock(() => Promise.resolve("stdin script")),
      ipcCall: mock(() => Promise.resolve({ ok: true, filePath: "/a.ts" })) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["save", "my-alias", "-"], deps);

    expect(deps.readStdin).toHaveBeenCalled();
    expect(deps.ipcCall).toHaveBeenCalledWith("saveAlias", {
      name: "my-alias",
      script: "stdin script",
      description: undefined,
    });
  });

  test("reads from stdin when no source provided", async () => {
    const deps = makeDeps({
      readStdin: mock(() => Promise.resolve("stdin script")),
      ipcCall: mock(() => Promise.resolve({ ok: true, filePath: "/a.ts" })) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["save", "my-alias"], deps);
    expect(deps.readStdin).toHaveBeenCalled();
  });

  test("exits with error when no name provided", async () => {
    const deps = makeDeps();
    await expect(cmdAlias(["save"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalled();
  });

  test("exits with error when script is empty", async () => {
    const deps = makeDeps({
      readStdin: mock(() => Promise.resolve("   ")),
    });
    await expect(cmdAlias(["save", "my-alias", "-"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("Empty script — nothing to save");
  });
});

/* ── cmdAlias: save -c ──────────────────────────────────────────── */

describe("cmdAlias save -c", () => {
  test("saves wrapped defineAlias with -c and positional name", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ ok: true, filePath: "/a.ts" })) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["save", "greet", "-c", '{ name: "greet", fn: () => "hi" }'], deps);

    const call = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("saveAlias");
    expect((call[1] as { name: string }).name).toBe("greet");
    expect((call[1] as { script: string }).script).toContain("defineAlias");
  });

  test("extracts name from code body when no positional name", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ ok: true, filePath: "/a.ts" })) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["save", "-c", '{ name: "auto-name", fn: () => {} }'], deps);

    const call = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[0];
    expect((call[1] as { name: string }).name).toBe("auto-name");
  });

  test("--code is alias for -c", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ ok: true, filePath: "/a.ts" })) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["save", "--code", '{ name: "test", fn: () => {} }'], deps);
    expect(deps.ipcCall).toHaveBeenCalled();
  });

  test("exits when -c has no value", async () => {
    const deps = makeDeps();
    await expect(cmdAlias(["save", "-c"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("Missing code body after -c/--code flag");
  });

  test("exits when no name can be determined", async () => {
    const deps = makeDeps();
    await expect(cmdAlias(["save", "-c", "{ fn: () => {} }"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(
      "No alias name — provide a name field in the definition or as a positional arg",
    );
  });
});

/* ── cmdAlias: show ──────────────────────────────────────────────── */

describe("cmdAlias show", () => {
  const fakeAlias: AliasDetail = {
    name: "greet",
    description: "Say hi",
    filePath: "/a.ts",
    updatedAt: 1,
    aliasType: "freeform",
    script: 'console.log("hello")',
  };

  test("prints alias script", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(fakeAlias)) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["show", "greet"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("getAlias", { name: "greet" });
    expect(deps.log).toHaveBeenCalledWith(fakeAlias.script);
  });

  test("calls printAliasDebug with --debug", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(fakeAlias)) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["show", "greet", "--debug"], deps);

    expect(deps.printAliasDebug).toHaveBeenCalledWith(fakeAlias);
    expect(deps.log).toHaveBeenCalledWith(fakeAlias.script);
  });

  test("--debug flag can come before name", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(fakeAlias)) as AliasDeps["ipcCall"],
    });

    await cmdAlias(["show", "--debug", "greet"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("getAlias", { name: "greet" });
    expect(deps.printAliasDebug).toHaveBeenCalled();
  });

  test("exits when no name provided", async () => {
    const deps = makeDeps();
    await expect(cmdAlias(["show"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("Usage: mcx alias show <name> [--debug]");
  });

  test("exits when alias not found", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(null)) as AliasDeps["ipcCall"],
    });

    await expect(cmdAlias(["show", "missing"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith('Alias "missing" not found');
  });
});

/* ── cmdAlias: edit ──────────────────────────────────────────────── */

describe("cmdAlias edit", () => {
  test("edits existing alias", async () => {
    const alias: AliasDetail = {
      name: "greet",
      description: "hi",
      filePath: "/existing.ts",
      updatedAt: 1,
      aliasType: "freeform",
      script: "old",
    };
    const deps = makeDeps({
      ipcCall: mock()
        .mockResolvedValueOnce(alias) // getAlias
        .mockResolvedValueOnce(undefined), // saveAlias
      readFileWithLimit: mock(() => "updated script"),
      spawnSync: mock(() => ({ status: 0 })),
    });

    await cmdAlias(["edit", "greet"], deps);

    expect(deps.spawnSync).toHaveBeenCalled();
    const spawnCall = (deps.spawnSync as ReturnType<typeof mock>).mock.calls[0];
    expect(spawnCall[1][0]).toBe("/existing.ts");

    // Re-saves after edit
    expect(deps.ipcCall).toHaveBeenCalledTimes(2);
    const saveCall = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[1];
    expect(saveCall[0]).toBe("saveAlias");
    expect(deps.logError).toHaveBeenCalledWith('Updated alias "greet"');
  });

  test("creates new alias with skeleton when not found", async () => {
    const deps = makeDeps({
      ipcCall: mock()
        .mockResolvedValueOnce(null) // getAlias returns null
        .mockResolvedValueOnce(undefined), // saveAlias
      readFileWithLimit: mock(() => "new script"),
      spawnSync: mock(() => ({ status: 0 })),
      safeAliasPath: mock(() => "/tmp/aliases/new-tool.ts"),
    });

    await cmdAlias(["edit", "new-tool"], deps);

    expect(deps.mkdirSync).toHaveBeenCalled();
    expect(deps.writeFileSync).toHaveBeenCalled();
    const writeCall = (deps.writeFileSync as ReturnType<typeof mock>).mock.calls[0];
    expect(writeCall[1]).toContain('name: "new-tool"');
    expect(deps.logError).toHaveBeenCalledWith('Creating new alias "new-tool"…');
    expect(deps.logError).toHaveBeenCalledWith('Saved alias "new-tool"');
  });

  test("exits when editor returns non-zero", async () => {
    const deps = makeDeps({
      ipcCall: mock().mockResolvedValueOnce({
        name: "test",
        description: "",
        filePath: "/a.ts",
        updatedAt: 1,
        aliasType: "freeform" as const,
        script: "",
      }),
      spawnSync: mock(() => ({ status: 1 })),
    });

    await expect(cmdAlias(["edit", "test"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("Editor exited with code 1");
  });

  test("exits when no name provided", async () => {
    const deps = makeDeps();
    await expect(cmdAlias(["edit"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("Usage: mcx alias edit <name>");
  });
});

/* ── cmdAlias: rm ────────────────────────────────────────────────── */

describe("cmdAlias rm", () => {
  test("deletes alias by name", async () => {
    const deps = makeDeps();
    await cmdAlias(["rm", "old-alias"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("deleteAlias", { name: "old-alias" });
    expect(deps.logError).toHaveBeenCalledWith('Deleted alias "old-alias"');
  });

  test("delete is an alias for rm", async () => {
    const deps = makeDeps();
    await cmdAlias(["delete", "old-alias"], deps);
    expect(deps.ipcCall).toHaveBeenCalledWith("deleteAlias", { name: "old-alias" });
  });

  test("exits when no name provided", async () => {
    const deps = makeDeps();
    await expect(cmdAlias(["rm"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("Usage: mcx alias rm <name>");
  });
});

/* ── parsePromoteArgs ────────────────────────────────────────────── */

describe("parsePromoteArgs", () => {
  test("extracts source name", () => {
    expect(parsePromoteArgs(["my-alias"])).toEqual({ source: "my-alias", target: undefined });
  });

  test("extracts source and --name target", () => {
    expect(parsePromoteArgs(["old-name", "--name", "new-name"])).toEqual({
      source: "old-name",
      target: "new-name",
    });
  });

  test("returns undefined when empty", () => {
    expect(parsePromoteArgs([])).toEqual({ source: undefined, target: undefined });
  });
});

/* ── parseEphemeralScript ────────────────────────────────────────── */

describe("parseEphemeralScript", () => {
  test("parses ephemeral script format", () => {
    const script = 'const result = await mcp["my-server"]["my-tool"]({"query":"test"});\nconsole.log(result);';
    const parsed = parseEphemeralScript(script);
    expect(parsed).toEqual({
      server: "my-server",
      tool: "my-tool",
      args: { query: "test" },
    });
  });

  test("returns undefined for non-ephemeral scripts", () => {
    expect(parseEphemeralScript("console.log('hello')")).toBeUndefined();
  });

  test("returns undefined for malformed JSON args", () => {
    const script = 'mcp["s"]["t"]({broken})';
    expect(parseEphemeralScript(script)).toBeUndefined();
  });
});

/* ── generatePromotionScaffold ───────────────────────────────────── */

describe("generatePromotionScaffold", () => {
  test("generates defineAlias scaffold from ephemeral script", () => {
    const script =
      'const result = await mcp["server"]["tool"]({"query":"test","count":5});\nconsole.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));\n';
    const scaffold = generatePromotionScaffold(script, "ephemeral: server/tool", "my-tool");

    expect(scaffold).toContain('import { defineAlias, z } from "mcp-cli"');
    expect(scaffold).toContain('"my-tool"');
    expect(scaffold).toContain("z.string()");
    expect(scaffold).toContain("z.number()");
    expect(scaffold).toContain("input.query");
    expect(scaffold).toContain("input.count");
    expect(scaffold).toContain('"server/tool"'); // description strips "ephemeral: " prefix
  });

  test("wraps unparseable script as-is", () => {
    const scaffold = generatePromotionScaffold("custom code", "desc", "name");
    expect(scaffold).toContain("defineAlias");
    expect(scaffold).toContain("custom code");
    expect(scaffold).toContain('"name"');
  });
});

/* ── cmdAlias: promote ───────────────────────────────────────────── */

describe("cmdAlias promote", () => {
  test("promotes ephemeral alias to permanent", async () => {
    const ephAlias: AliasDetail = {
      name: "get_-abc12345",
      description: "ephemeral: server/tool",
      filePath: "/tmp/aliases/get_-abc12345.ts",
      updatedAt: 1,
      aliasType: "freeform",
      expiresAt: Date.now() + 86400000,
      script: 'const result = await mcp["server"]["tool"]({"query":"test"});\nconsole.log(result);',
    };

    const deps = makeDeps({
      ipcCall: mock()
        .mockResolvedValueOnce(ephAlias) // getAlias
        .mockResolvedValueOnce({ ok: true, filePath: "/tmp/aliases/get_-abc12345.ts" }), // saveAlias
    });

    await cmdAlias(["promote", "get_-abc12345"], deps);

    const saveCall = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[1];
    expect(saveCall[0]).toBe("saveAlias");
    const params = saveCall[1] as { name: string; script: string; expiresAt?: number };
    expect(params.name).toBe("get_-abc12345");
    expect(params.script).toContain("defineAlias");
    expect(params.expiresAt).toBeUndefined(); // permanent
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining("Promoted"));
  });

  test("errors when alias is already permanent", async () => {
    const permAlias: AliasDetail = {
      name: "perm",
      description: "permanent",
      filePath: "/tmp/perm.ts",
      updatedAt: 1,
      aliasType: "freeform",
      expiresAt: null,
      script: "// perm",
    };

    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(permAlias)) as AliasDeps["ipcCall"],
    });

    await expect(cmdAlias(["promote", "perm"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith('Alias "perm" is already permanent — nothing to promote');
  });

  test("errors when alias not found", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(null)) as AliasDeps["ipcCall"],
    });

    await expect(cmdAlias(["promote", "missing"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith('Alias "missing" not found');
  });

  test("promotes with --name override and deletes old", async () => {
    const ephAlias: AliasDetail = {
      name: "get_-abc12345",
      description: "ephemeral: server/tool",
      filePath: "/tmp/aliases/get_-abc12345.ts",
      updatedAt: 1,
      aliasType: "freeform",
      expiresAt: Date.now() + 86400000,
      script: 'const result = await mcp["server"]["tool"]({"query":"test"});\nconsole.log(result);',
    };

    const deps = makeDeps({
      ipcCall: mock()
        .mockResolvedValueOnce(ephAlias) // getAlias
        .mockResolvedValueOnce({ ok: true, filePath: "/tmp/aliases/my-tool.ts" }) // saveAlias
        .mockResolvedValueOnce({ ok: true }), // deleteAlias
    });

    await cmdAlias(["promote", "get_-abc12345", "--name", "my-tool"], deps);

    // saveAlias with new name
    const saveCall = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[1];
    expect((saveCall[1] as { name: string }).name).toBe("my-tool");

    // deleteAlias for old name
    const deleteCall = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[2];
    expect(deleteCall[0]).toBe("deleteAlias");
    expect((deleteCall[1] as { name: string }).name).toBe("get_-abc12345");
  });

  test("errors when no name provided", async () => {
    const deps = makeDeps();
    await expect(cmdAlias(["promote"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("Usage: mcx alias promote <name> [--name <new-name>]");
  });
});

/* ── cmdAlias: help / unknown ────────────────────────────────────── */

describe("cmdAlias help/unknown", () => {
  test("shows help for no args (does not exit)", async () => {
    const deps = makeDeps();
    await cmdAlias([], deps);
    expect(deps.exit).not.toHaveBeenCalled();
  });

  test("shows help for help subcommand", async () => {
    const deps = makeDeps();
    await cmdAlias(["help"], deps);
    expect(deps.exit).not.toHaveBeenCalled();
  });

  test("shows help for --help flag", async () => {
    const deps = makeDeps();
    await cmdAlias(["--help"], deps);
    expect(deps.exit).not.toHaveBeenCalled();
  });

  test("shows help for -h flag", async () => {
    const deps = makeDeps();
    await cmdAlias(["-h"], deps);
    expect(deps.exit).not.toHaveBeenCalled();
  });

  test("exits with error for unknown subcommand", async () => {
    const deps = makeDeps();
    await expect(cmdAlias(["bogus"], deps)).rejects.toThrow(ExitError);
  });
});

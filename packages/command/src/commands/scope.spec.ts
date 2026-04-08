import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testOptions } from "../../../../test/test-options";
import { type ScopeFile, cmdScope } from "./scope";

function makeDeps(cwd: string) {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    deps: {
      cwd: () => cwd,
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    },
    logs,
    errors,
  };
}

describe("mcx scope init", () => {
  test("creates scope file with cwd as root", async () => {
    using opts = testOptions();
    const { deps, logs } = makeDeps("/tmp/my-project");

    await cmdScope(["init", "myproj"], deps);

    const scopeFile = JSON.parse(readFileSync(join(opts.SCOPES_DIR, "myproj.json"), "utf-8")) as ScopeFile;
    expect(scopeFile.root).toBe("/tmp/my-project");
    expect(scopeFile.created).toBeTruthy();
    expect(logs[0]).toContain("myproj");
  });

  test("defaults name to directory basename", async () => {
    using opts = testOptions();
    const { deps } = makeDeps("/tmp/cool-project");

    await cmdScope(["init"], deps);

    expect(existsSync(join(opts.SCOPES_DIR, "cool-project.json"))).toBe(true);
  });

  test("errors on duplicate name without --force", async () => {
    using _opts = testOptions({
      files: { "scopes/existing.json": { root: "/old", created: "2026-01-01T00:00:00Z" } },
    });
    const { deps } = makeDeps("/tmp/new");

    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      expect(() => cmdScope(["init", "existing"], deps)).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("overwrites with --force", async () => {
    using opts = testOptions({
      files: { "scopes/existing.json": { root: "/old", created: "2026-01-01T00:00:00Z" } },
    });
    const { deps } = makeDeps("/tmp/new");

    await cmdScope(["init", "existing", "--force"], deps);

    const scopeFile = JSON.parse(readFileSync(join(opts.SCOPES_DIR, "existing.json"), "utf-8")) as ScopeFile;
    expect(scopeFile.root).toBe("/tmp/new");
  });

  test("warns when cwd is under existing scope", async () => {
    using _opts = testOptions({
      files: { "scopes/parent.json": { root: "/projects/mono", created: "2026-01-01T00:00:00Z" } },
    });
    const { deps, errors } = makeDeps("/projects/mono/packages/lib");

    await cmdScope(["init", "lib"], deps);

    expect(errors.some((e) => e.includes('Already under scope "parent"'))).toBe(true);
  });

  test("rejects invalid scope name", async () => {
    using _opts = testOptions();
    const { deps } = makeDeps("/tmp/test");

    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      expect(() => cmdScope(["init", "bad name!"], deps)).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("mcx scope list", () => {
  test("lists all registered scopes", async () => {
    using _opts = testOptions({
      files: {
        "scopes/alpha.json": { root: "/projects/alpha", created: "2026-01-01T00:00:00Z" },
        "scopes/beta.json": { root: "/projects/beta", created: "2026-01-02T00:00:00Z" },
      },
    });
    const { deps, logs } = makeDeps("/tmp");

    await cmdScope(["list"], deps);

    expect(logs.length).toBe(2);
    expect(logs.some((l) => l.includes("alpha") && l.includes("/projects/alpha"))).toBe(true);
    expect(logs.some((l) => l.includes("beta") && l.includes("/projects/beta"))).toBe(true);
  });

  test("shows message when no scopes exist", async () => {
    using _opts = testOptions();
    const { deps, errors } = makeDeps("/tmp");

    await cmdScope(["list"], deps);

    expect(errors[0]).toContain("No scopes registered");
  });
});

describe("mcx scope rm", () => {
  test("removes an existing scope", async () => {
    using opts = testOptions({
      files: { "scopes/removeme.json": { root: "/old", created: "2026-01-01T00:00:00Z" } },
    });
    const { deps, logs } = makeDeps("/tmp");

    await cmdScope(["rm", "removeme"], deps);

    expect(existsSync(join(opts.SCOPES_DIR, "removeme.json"))).toBe(false);
    expect(logs[0]).toContain("removed");
  });

  test("errors when scope not found", async () => {
    using _opts = testOptions();
    const { deps } = makeDeps("/tmp");

    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      expect(() => cmdScope(["rm", "nonexistent"], deps)).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("errors when no name provided", async () => {
    using _opts = testOptions();
    const { deps } = makeDeps("/tmp");

    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      expect(() => cmdScope(["rm"], deps)).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

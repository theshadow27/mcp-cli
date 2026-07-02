#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";
import type { BunPlugin } from "bun";
import { daemonWorkers } from "./daemon-workers";
import { WORKER_SMOKE_FAILURE_PATTERN } from "./smoke-failure-pattern";

// Ensure deps are installed (fast no-op when already present)
await $`bun install`.quiet();

const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"] as const;

const args = process.argv.slice(2);
const releaseMode = args.includes("--release");
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];

// Read version from package.json
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const version: string = pkg.version;
const versionFlag = `--define=__VERSION__="${version}"`;
console.log(`Version: ${version}`);

// Compute protocol version hash from IPC contract definition
const ipcSource = readFileSync("packages/core/src/ipc.ts", "utf-8");
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(ipcSource);
const protocolHash = hasher.digest("hex").slice(0, 12);
const defineFlag = `--define=__PROTOCOL_HASH__="${protocolHash}"`;
const compiledFlag = "--define=__COMPILED__=true";
const buildEpoch = Math.floor(Date.now() / 1000).toString();
const epochFlag = `--define=__BUILD_EPOCH__="${buildEpoch}"`;
console.log(`Protocol hash: ${protocolHash}`);
console.log(`Build epoch: ${buildEpoch}`);

// ── jq-web build plugin ──
// Patches jq-web's Emscripten loader at build time:
// 1. Inlines the WASM binary via Module.wasmBinary (no __dirname file lookup)
// 2. Fixes the CJS double-export that breaks Bun's __commonJS wrapper
const jqWasmPath = resolve(require.resolve("jq-web", { paths: [resolve("packages/command")] }), "..", "jq.wasm");
const wasmBytes = readFileSync(jqWasmPath);
const wasmBase64 = Buffer.from(wasmBytes).toString("base64");
console.log(`jq-web WASM: ${(wasmBytes.length / 1024).toFixed(0)}KB inlined`);

const jqWasmPlugin: BunPlugin = {
  name: "jq-wasm-inline",
  setup(build) {
    build.onLoad({ filter: /jq-web[/\\]jq\.js$/ }, (loadArgs) => {
      let source = readFileSync(loadArgs.path, "utf-8");

      // Inject wasmBinary so Emscripten skips filesystem WASM loading
      source = source.replace(
        "async function(moduleArg = {}) {",
        `async function(moduleArg = {wasmBinary: Uint8Array.from(atob("${wasmBase64}"), c => c.charCodeAt(0))}) {`,
      );

      // Fix CJS exports. jq-web exports a raw Promise, which breaks Bun's
      // __toESM: it copies .then/.catch/.finally onto the wrapper object,
      // creating a broken thenable ("|this| is not a Promise").
      // Fix: wrap the Promise in a plain object { ready: Promise<JqModule> }.

      // Remove the first module.exports (factory, before Promise is created)
      source = source.replace(
        [
          `if (typeof exports === 'object' && typeof module === 'object') {`,
          "  module.exports = jq;",
          "  // This default export looks redundant, but it allows TS to import this",
          "  // commonjs style module.",
          "  module.exports.default = jq;",
          `} else if (typeof define === 'function' && define['amd'])`,
          "  define([], () => jq);",
        ].join("\n"),
        "// [build: first module.exports removed]",
      );

      // Wrap the final export in a plain object to avoid thenable issues
      source = source.replace(
        [
          `if (typeof exports === 'object' && typeof module === 'object')`,
          "  module.exports = jq;",
          `else if (typeof exports === 'object')`,
          `  exports["jq"] = jq;`,
        ].join("\n"),
        [
          `if (typeof exports === 'object' && typeof module === 'object')`,
          "  module.exports = { ready: jq };",
          `else if (typeof exports === 'object')`,
          `  exports["jq"] = { ready: jq };`,
        ].join("\n"),
      );

      return { contents: source, loader: "js" };
    });
  },
};

// ── react-devtools-core stub plugin ──
// Ink's devtools.js has an unconditional `import devtools from 'react-devtools-core'`.
// Using --external defers resolution to runtime where the package doesn't exist.
// Instead, stub it at build time so the import resolves to a no-op.
const devtoolsStubPlugin: BunPlugin = {
  name: "devtools-stub",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "devtools-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
      contents: "export default { connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

await $`mkdir -p dist`;

// Bun 1.3.12 produces truncated code signatures on macOS (oven-sh/bun#29120).
// Workaround: disable Bun's built-in signing, ad-hoc sign after compile.
process.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";

/** Ad-hoc sign macOS binaries after compile. No-op on non-darwin. */
async function codesignIfDarwin(...paths: string[]): Promise<void> {
  const isDarwin = (target?: string) => !target || target.includes("darwin");
  const darwinPaths = paths.filter((p) => {
    // In release mode, only sign darwin binaries
    const parts = p.split("-");
    return parts.length <= 2 || parts.some((s) => s.startsWith("darwin"));
  });
  if (darwinPaths.length === 0) return;
  for (const p of darwinPaths) {
    await $`codesign --force --sign - ${p}`.quiet().nothrow();
  }
}

// mcpd worker entrypoints (see scripts/daemon-workers.ts) — must be listed
// explicitly for bun build --compile.
//
// `--root` pins the bundler outbase to the workers' directory. Without it,
// Bun computes the output root from the entrypoint set and the result is
// unstable: with ≤8 entrypoints (Bun 1.3.14) the extra entrypoints embed flat
// at /$bunfs/root/<name>.js — next to the main module, where
// worker-path.ts's compiled-mode `./<name>.ts` resolution finds them — but
// with ≥9 they embed at /$bunfs/root/packages/daemon/src/<name>.js and every
// `new Worker()` fails at runtime with `ModuleNotFound resolving "./<name>"`.
// Growing the list from 6 to 9 entries silently broke all session workers
// (the #2721→#2762 regression). Pinning --root makes the layout
// deterministic; smokeDaemonWorkers() below verifies it on every build.
const workerRoot = "packages/daemon/src";
for (const w of [...daemonWorkers, "packages/daemon/src/main.ts"]) {
  if (dirname(w) !== workerRoot) {
    console.error(`daemon worker ${w} is outside ${workerRoot} — compiled-mode workerPath() requires a flat layout`);
    process.exit(1);
  }
}

// Packages excluded from bundling — resolved at runtime from node_modules.
// playwright ships with a large optional-dep tree (electron, chromium-bidi, etc.)
// that can't bundle cleanly; the site-worker loads it via dynamic import only
// when a browser tool is actually invoked.
const daemonExternal = ["playwright", "playwright-core", "electron", "chromium-bidi"];
const externalFlags = daemonExternal.flatMap((p) => ["--external", p]);

interface BinaryBuildConfig {
  entrypoint: string;
  bundleName: string;
  label: string;
  plugins: BunPlugin[];
}

const mcxConfig: BinaryBuildConfig = {
  entrypoint: "packages/command/src/main.ts",
  bundleName: "index",
  label: "mcx",
  plugins: [jqWasmPlugin],
};

const mcpctlConfig: BinaryBuildConfig = {
  entrypoint: "packages/control/src/main.tsx",
  bundleName: "mcpctl-bundle",
  label: "mcpctl",
  plugins: [devtoolsStubPlugin],
};

const bundleCleanup: string[] = [];

// Grace period after SIGTERM before escalating the smoke daemon to SIGKILL.
const SMOKE_KILL_GRACE_MS = 5000;
// Deadline for all worker-backed servers to boot (generous for loaded CI runners).
const SMOKE_DEADLINE_MS = 60_000;

/**
 * Post-compile smoke: boot the freshly compiled mcpd with an isolated state
 * dir and assert every worker-backed virtual server actually starts.
 *
 * This is the guard that the daemon-workers list alone cannot provide — it
 * verifies the *embedded layout* of the binary, not just the entrypoint list.
 * A binary where worker resolution is broken builds green but fails here with
 * the captured daemon log.
 *
 * Only runs when the binary can execute on the build host (dev builds, and
 * the native target of release builds).
 */
async function smokeDaemonWorkers(mcpdPath: string): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "mcpd-smoke-"));
  // Ephemeral WS port so the smoke never collides with a real running daemon.
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({ wsPort: 0 }));

  // Unconditional worker-backed servers, plus the ones gated on host binaries
  // (mirrors the gating in packages/daemon/src/index.ts).
  const expected = ["Claude session server started", "Mock session server started", "Site server started"];
  if (Bun.which("codex")) expected.push("Codex session server started");
  if (Bun.which("gh") || Bun.which("gemini") || Bun.which("grok")) expected.push("ACP session server started");
  if (Bun.which("opencode")) expected.push("OpenCode session server started");

  const proc = Bun.spawn([mcpdPath], {
    env: { ...process.env, MCP_CLI_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });

  let output = "";
  let failure: string | null = null;
  try {
    const decoder = new TextDecoder();
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) output += decoder.decode(chunk);
    };
    const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);

    const deadline = Date.now() + SMOKE_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (WORKER_SMOKE_FAILURE_PATTERN.test(output)) {
        failure = "daemon reported a worker startup failure";
        break;
      }
      if (expected.every((line) => output.includes(line))) break;
      if (proc.exitCode !== null) {
        failure = `daemon exited early (code ${proc.exitCode})`;
        break;
      }
      await Bun.sleep(100);
    }

    proc.kill();
    // Bounded grace period: a wedged worker thread must not hang the required
    // `build` job indefinitely on an un-timed `await proc.exited`.
    const killTimer = setTimeout(() => proc.kill(9), SMOKE_KILL_GRACE_MS);
    await proc.exited;
    clearTimeout(killTimer);
    await pumps;

    const missing = expected.filter((line) => !output.includes(line));
    if (!failure && missing.length > 0) {
      failure = `timed out waiting for: ${missing.join(", ")}`;
    }
  } finally {
    // Guard against a throw between spawn and kill leaking the daemon + tmpdir.
    if (proc.exitCode === null) proc.kill(9);
    rmSync(stateDir, { recursive: true, force: true });
  }

  if (failure) {
    console.error(`mcpd worker smoke FAILED (${mcpdPath}): ${failure}`);
    console.error("--- daemon output ---");
    console.error(output);
    process.exit(1);
  }
  console.log(`mcpd worker smoke passed: ${expected.length} worker-backed servers started`);
}

async function buildBinary(config: BinaryBuildConfig, outfile: string, target?: string): Promise<void> {
  // Always bundle for generic "bun" target — the JS bundle is platform-agnostic.
  // Platform-specific cross-compilation happens in the subsequent --compile step.
  const result = await Bun.build({
    entrypoints: [resolve(config.entrypoint)],
    outdir: resolve("dist"),
    naming: `${config.bundleName}.[ext]`,
    minify: true,
    target: "bun",
    plugins: config.plugins,
    define: {
      __PROTOCOL_HASH__: JSON.stringify(protocolHash),
      __VERSION__: JSON.stringify(version),
      __COMPILED__: "true",
      __BUILD_EPOCH__: JSON.stringify(buildEpoch),
    },
  });
  if (!result.success) {
    console.error(`${config.label} build failed:`);
    for (const msg of result.logs) console.error(msg);
    process.exit(1);
  }
  // Bun.build doesn't support --compile, so compile the bundle
  const bundlePath = resolve(`dist/${config.bundleName}.js`);
  bundleCleanup.push(bundlePath);
  // Ensure the bundle is flushed to disk before compiling (CI race fix #884)
  const bundleFile = Bun.file(bundlePath);
  for (let i = 0; i < 50; i++) {
    if (await bundleFile.exists()) break;
    await Bun.sleep(100);
  }
  if (!(await bundleFile.exists())) {
    console.error(`${config.label}: bundle not found at ${bundlePath} after waiting`);
    process.exit(1);
  }
  if (target) {
    await $`bun build --compile --minify --target=${target} ${bundlePath} --outfile ${outfile}`;
  } else {
    await $`bun build --compile --minify ${bundlePath} --outfile ${outfile}`;
  }
}

if (releaseMode) {
  const targets = targetArg ? TARGETS.filter((t) => t === targetArg) : [...TARGETS];

  if (targetArg && targets.length === 0) {
    console.error(`Unknown target: ${targetArg}`);
    console.error(`Valid targets: ${TARGETS.join(", ")}`);
    process.exit(1);
  }

  for (const target of targets) {
    const suffix = target.replace("bun-", "");
    console.log(`Building for ${suffix}...`);
    await Promise.all([
      $`bun build --compile --minify ${defineFlag} ${compiledFlag} ${versionFlag} ${epochFlag} ${externalFlags} --root=${workerRoot} --target=${target} packages/daemon/src/main.ts ${daemonWorkers} --outfile dist/mcpd-${suffix}`,
      buildBinary(mcxConfig, `dist/mcx-${suffix}`, target),
      buildBinary(mcpctlConfig, `dist/mcpctl-${suffix}`, target),
    ]);
    if (target.includes("darwin")) {
      await codesignIfDarwin(`dist/mcpd-${suffix}`, `dist/mcx-${suffix}`, `dist/mcpctl-${suffix}`);
    }
    // Verify the embedded worker layout when the binary runs on this host.
    const nativeTarget = `bun-${process.platform}-${process.arch}`;
    if (target === nativeTarget) {
      await smokeDaemonWorkers(resolve(`dist/mcpd-${suffix}`));
    } else {
      console.log(`Skipping mcpd worker smoke for ${target} (host is ${nativeTarget})`);
    }
  }

  // Clean up intermediate bundles after all compiles finish
  for (const p of bundleCleanup) {
    try {
      unlinkSync(p);
    } catch {} // dotw-ignore prod-empty-catch: best-effort cleanup of temp files
  }
  console.log("Release build complete.");
} else {
  // Dev build: current platform, simple names
  await Promise.all([
    $`bun build --compile --minify ${defineFlag} ${compiledFlag} ${versionFlag} ${epochFlag} ${externalFlags} --root=${workerRoot} packages/daemon/src/main.ts ${daemonWorkers} --outfile dist/mcpd`,
    buildBinary(mcxConfig, "dist/mcx"),
    buildBinary(mcpctlConfig, "dist/mcpctl"),
  ]);
  // Ad-hoc sign on macOS (oven-sh/bun#29120 workaround)
  if (process.platform === "darwin") {
    await codesignIfDarwin("dist/mcpd", "dist/mcx", "dist/mcpctl");
  }
  // Verify the embedded worker layout — boots the compiled daemon with an
  // isolated state dir and asserts every worker-backed server starts.
  await smokeDaemonWorkers(resolve("dist/mcpd"));
  // Clean up intermediate bundles after all compiles finish
  for (const p of bundleCleanup) {
    try {
      unlinkSync(p);
    } catch {} // dotw-ignore prod-empty-catch: best-effort cleanup of temp files
  }
  console.log("Built: dist/mcpd, dist/mcx, dist/mcpctl");
}

#!/usr/bin/env bun
import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import type { BunPlugin } from "bun";

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

// mcpd worker entrypoints — must be listed explicitly for bun build --compile
const daemonWorkers = [
  "packages/daemon/src/alias-executor.ts",
  "packages/daemon/src/claude-session-worker.ts",
  "packages/daemon/src/codex-session-worker.ts",
];

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
      $`bun build --compile --minify ${defineFlag} ${compiledFlag} ${versionFlag} ${epochFlag} --target=${target} packages/daemon/src/main.ts ${daemonWorkers} --outfile dist/mcpd-${suffix}`,
      buildBinary(mcxConfig, `dist/mcx-${suffix}`, target),
      buildBinary(mcpctlConfig, `dist/mcpctl-${suffix}`, target),
    ]);
  }

  // Clean up intermediate bundles after all compiles finish
  for (const p of bundleCleanup) {
    try {
      unlinkSync(p);
    } catch {}
  }
  console.log("Release build complete.");
} else {
  // Dev build: current platform, simple names
  await Promise.all([
    $`bun build --compile --minify ${defineFlag} ${compiledFlag} ${versionFlag} ${epochFlag} packages/daemon/src/main.ts ${daemonWorkers} --outfile dist/mcpd`,
    buildBinary(mcxConfig, "dist/mcx"),
    buildBinary(mcpctlConfig, "dist/mcpctl"),
  ]);
  // Clean up intermediate bundles after all compiles finish
  for (const p of bundleCleanup) {
    try {
      unlinkSync(p);
    } catch {}
  }
  console.log("Built: dist/mcpd, dist/mcx, dist/mcpctl");
}

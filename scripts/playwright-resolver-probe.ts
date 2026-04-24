#!/usr/bin/env bun
/**
 * Compiled-binary probe for playwright runtime resolution.
 *
 * Accepts an on-disk playwright candidate path as argv[2], attempts to
 * resolve it via resolvePlaywright(), and prints {"ok":true} on success.
 *
 * Designed to be compiled with `bun build --compile --external playwright`
 * so it mimics the bunfs environment where static playwright imports fail
 * and only absolute-path dynamic imports work.
 */

import { _resetCache, resolvePlaywright } from "../packages/daemon/src/site/browser/resolve-playwright";

const candidatePath = process.argv[2];
if (!candidatePath) {
  process.stderr.write("Usage: playwright-resolver-probe <candidate-path>\n");
  process.exit(2);
}

_resetCache();
const chromium = await resolvePlaywright({
  candidates: [candidatePath],
  install: () => {
    throw new Error("playwright not found at candidate path — pass a valid on-disk playwright installation");
  },
});
if (!chromium || typeof chromium.launchPersistentContext !== "function") {
  process.stderr.write("resolvePlaywright returned invalid chromium object\n");
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ ok: true })}\n`);

/**
 * Rule: provider-drift
 *
 * Every agent provider has a `packages/daemon/src/<slug>-session-worker.ts`
 * worker. The set of those slugs must be a subset of the `PROVIDER_NAMES`
 * array in `agent-grid/versions-schema.ts` — otherwise a newly-landed
 * provider is silently absent from the agent-grid schema, and the
 * `versions.yaml` CI validation passes while omitting it (detection,
 * install, and version-pinning tooling never learn about the provider).
 *
 * Direction is one-way: a worker present on disk MUST be listed in
 * PROVIDER_NAMES. PROVIDER_NAMES entries without a worker (e.g. `grok`,
 * `copilot`, `gemini` — providers detected/installed but not hosted as a
 * daemon session worker) are NOT flagged.
 *
 * agent-grid/ is outside the file-loader scan roots, so the schema is read
 * from disk directly rather than via ctx.files/anchors (same shape as
 * `protocol-version-spec-sync`). The anchor on claude-session-worker.ts
 * guarantees the daemon worker set is actually in the loaded file set — a
 * --filter or rename that hides it fails loud instead of silently passing.
 *
 * Escape hatch for a `*-session-worker.ts` file that is genuinely not an
 * agent provider: add `// dotw-ignore provider-drift: <reason>` anywhere in
 * the worker file.
 *
 * Source: #2603 (discovered in adversarial review of #2598, epic #2538).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckRule } from "./_engine/rule";

const CLAUDE_WORKER_REL = "packages/daemon/src/claude-session-worker.ts";
const SCHEMA_REL = "agent-grid/versions-schema.ts";

// Matches packages/daemon/src/<slug>-session-worker.ts (no nested dirs, not a spec).
const WORKER_REL = /^packages\/daemon\/src\/([a-z0-9-]+)-session-worker\.ts$/;
const PROVIDER_NAMES_ARRAY = /\bPROVIDER_NAMES\s*=\s*\[([\s\S]*?)\]/;
const QUOTED = /["']([\w-]+)["']/g;
const IGNORE = /\/\/\s*dotw-ignore\s+provider-drift\s*:\s*\S/;

const rule: CheckRule = {
  id: "provider-drift",
  kind: "check",
  anchors: [CLAUDE_WORKER_REL],
  scold: "a *-session-worker.ts provider is missing from PROVIDER_NAMES in agent-grid/versions-schema.ts",
  guidance: [
    "add the provider slug to the PROVIDER_NAMES array in agent-grid/versions-schema.ts",
    "then add a matching entry to agent-grid/versions.yaml so the schema and CI validation cover it",
    "if this worker is genuinely not an agent provider, annotate it: // dotw-ignore provider-drift: <reason>",
  ],
  documentation: "#2603",
  appliesToTests: false,
  check(ctx) {
    const match = WORKER_REL.exec(ctx.file.relPath);
    if (!match) return;
    ctx.checked();

    const slug = match[1] as string;
    if (IGNORE.test(ctx.file.content)) return;

    const repoRoot = ctx.file.path.slice(0, ctx.file.path.length - ctx.file.relPath.length);
    let schema: string;
    try {
      schema = readFileSync(resolve(repoRoot, SCHEMA_REL), "utf8");
    } catch {
      ctx.violated(1, 1, `${SCHEMA_REL} not found on disk — cannot verify provider coverage`);
      return;
    }

    const arrayMatch = PROVIDER_NAMES_ARRAY.exec(schema);
    if (!arrayMatch) {
      ctx.violated(1, 1, `PROVIDER_NAMES array not found in ${SCHEMA_REL}`);
      return;
    }

    const providers = new Set<string>();
    for (const m of (arrayMatch[1] as string).matchAll(QUOTED)) providers.add(m[1] as string);

    if (!providers.has(slug)) {
      ctx.violated(1, 1, `provider "${slug}" has a session worker but is absent from PROVIDER_NAMES`);
    }
  },
};

export default rule;

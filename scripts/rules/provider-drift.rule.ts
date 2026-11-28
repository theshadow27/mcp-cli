/**
 * Rule: provider-drift
 *
 * Every agent provider has a `packages/daemon/src/<slug>-session-worker.ts`
 * worker. The set of those slugs must be a subset of the `PROVIDER_NAMES`
 * array in `agent-grid/versions-schema.ts`: otherwise a newly-landed
 * provider is silently absent from the agent-grid schema, and the
 * `versions.yaml` CI validation passes while omitting it (detection,
 * install, and version-pinning tooling never learn about the provider).
 *
 * Direction is one-way: a worker present on disk MUST be listed in
 * PROVIDER_NAMES. PROVIDER_NAMES entries without a worker (e.g. `grok`,
 * `copilot`, `gemini`: providers detected/installed but not hosted as a
 * daemon session worker) are NOT flagged.
 *
 * The schema is listed in the rule's `files` and read from `ctx.files`. The
 * anchors guarantee both the daemon worker set and the schema are actually in
 * the tree: a rename that hides either fails loud instead of silently passing.
 *
 * Escape hatch for a `*-session-worker.ts` file that is genuinely not an
 * agent provider: a `doing-it-wrong-ignore-file provider-drift: <reason> (#issue)`
 * comment in the worker file.
 *
 * Source: #2603 (discovered in adversarial review of #2598, epic #2538).
 */

import type { Rule } from "am-i-done";

const CLAUDE_WORKER_REL = "packages/daemon/src/claude-session-worker.ts";
const SCHEMA_REL = "agent-grid/versions-schema.ts";

// Matches packages/daemon/src/<slug>-session-worker.ts (no nested dirs, not a spec).
const WORKER_REL = /^packages\/daemon\/src\/([a-z0-9-]+)-session-worker\.ts$/;
const PROVIDER_NAMES_ARRAY = /\bPROVIDER_NAMES\s*=\s*\[([\s\S]*?)\]/;
const QUOTED = /["']([\w-]+)["']/g;

export default {
  id: "provider-drift",
  type: "check",
  category: "architecture",
  files: ["packages/daemon/src/*-session-worker.ts", SCHEMA_REL],
  tests: "exclude",
  anchors: [(files) => files.has(CLAUDE_WORKER_REL), (files) => files.has(SCHEMA_REL)],
  scold: "a *-session-worker.ts provider is missing from PROVIDER_NAMES in agent-grid/versions-schema.ts",
  guidance: [
    "add the provider slug to the PROVIDER_NAMES array in agent-grid/versions-schema.ts",
    "then add a matching entry to agent-grid/versions.yaml so the schema and CI validation cover it",
    "if this worker is genuinely not an agent provider, annotate it: // doing-it-wrong-ignore-file provider-drift: <reason> (#issue)",
  ],
  documentation: "#2603",
  check(ctx) {
    const match = WORKER_REL.exec(ctx.file.relativePath);
    if (!match) return ctx.skipped();

    const slug = match[1] as string;

    const schema = ctx.files.get(SCHEMA_REL);
    if (schema === undefined) {
      ctx.violated(1, 1, `${SCHEMA_REL} not found: cannot verify provider coverage`);
      return ctx.checked();
    }

    const arrayMatch = PROVIDER_NAMES_ARRAY.exec(schema.content);
    if (!arrayMatch) {
      ctx.violated(1, 1, `PROVIDER_NAMES array not found in ${SCHEMA_REL}`);
      return ctx.checked();
    }

    const providers = new Set<string>();
    for (const m of (arrayMatch[1] as string).matchAll(QUOTED)) providers.add(m[1] as string);

    if (!providers.has(slug)) {
      ctx.violated(1, 1, `provider "${slug}" has a session worker but is absent from PROVIDER_NAMES`);
    }
    return ctx.checked();
  },
} satisfies Rule;

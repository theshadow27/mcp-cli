/**
 * Rule: protocol-version-spec-sync
 *
 * The AGENT_PROTOCOL_VERSION constant in packages/core/src/agent-protocol.ts
 * and the "Version:" line in docs/agent-protocol.md must agree. If they
 * diverge, one was bumped without the other: a spec/code mismatch that
 * defeats the point of having a spec.
 *
 * The spec is not source, so the rule widens `files` to include it and reads
 * it from `ctx.files`.
 */

import type { Rule } from "am-i-done";

const CORE_REL_PATH = "packages/core/src/agent-protocol.ts";
const SPEC_REL_PATH = "docs/agent-protocol.md";

const VERSION_CONST = /\bAGENT_PROTOCOL_VERSION\s*=\s*(\d+)/;
const SPEC_VERSION = /^\*\*Version:\*\*\s*(\d+)/m;

export default {
  id: "protocol-version-spec-sync",
  type: "check",
  category: "architecture",
  files: [CORE_REL_PATH, SPEC_REL_PATH],
  anchors: [(files) => files.has(CORE_REL_PATH), (files) => files.has(SPEC_REL_PATH)],
  scold: "AGENT_PROTOCOL_VERSION and docs/agent-protocol.md version line are out of sync",
  guidance: [
    "The version number in AGENT_PROTOCOL_VERSION (packages/core/src/agent-protocol.ts)",
    "must match the **Version:** line in docs/agent-protocol.md.",
    "When bumping the protocol version, update both files and add a changelog entry.",
  ],
  documentation: "docs/agent-protocol.md §8 Versioning",

  check(ctx) {
    if (ctx.file.relativePath !== CORE_REL_PATH) return ctx.skipped();

    const coreMatch = VERSION_CONST.exec(ctx.file.content);
    if (!coreMatch) {
      ctx.violated(1, 1, "AGENT_PROTOCOL_VERSION constant not found in agent-protocol.ts");
      return ctx.checked();
    }

    const spec = ctx.files.get(SPEC_REL_PATH);
    if (spec === undefined) {
      ctx.violated(1, 1, `${SPEC_REL_PATH} not found: cannot verify version sync`);
      return ctx.checked();
    }

    const specMatch = SPEC_VERSION.exec(spec.content);
    if (!specMatch) {
      ctx.violated(1, 1, "**Version:** line not found in docs/agent-protocol.md");
      return ctx.checked();
    }

    const codeVersion = coreMatch[1];
    const specVersion = specMatch[1];

    if (codeVersion !== specVersion) {
      const line = ctx.file.content.substring(0, coreMatch.index).split("\n").length;
      ctx.violated(line, 1, `AGENT_PROTOCOL_VERSION = ${codeVersion} but spec says Version: ${specVersion}`);
    }
    return ctx.checked();
  },
} satisfies Rule;

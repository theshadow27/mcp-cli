/**
 * Rule: protocol-version-spec-sync
 *
 * The AGENT_PROTOCOL_VERSION constant in packages/core/src/agent-protocol.ts
 * and the "Version:" line in docs/agent-protocol.md must agree. If they
 * diverge, one was bumped without the other — a spec/code mismatch that
 * defeats the point of having a spec.
 *
 * docs/ is outside the file-loader scan roots, so the spec is read from
 * disk directly rather than via ctx.files/anchors.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckRule } from "./_engine/rule";

const CORE_REL_PATH = "packages/core/src/agent-protocol.ts";
const SPEC_REL_PATH = "docs/agent-protocol.md";

const VERSION_CONST = /\bAGENT_PROTOCOL_VERSION\s*=\s*(\d+)/;
const SPEC_VERSION = /^\*\*Version:\*\*\s*(\d+)/m;

const rule: CheckRule = {
  id: "protocol-version-spec-sync",
  kind: "check",
  anchors: [CORE_REL_PATH],
  scold: "AGENT_PROTOCOL_VERSION and docs/agent-protocol.md version line are out of sync",
  guidance: [
    "The version number in AGENT_PROTOCOL_VERSION (packages/core/src/agent-protocol.ts)",
    "must match the **Version:** line in docs/agent-protocol.md.",
    "When bumping the protocol version, update both files and add a changelog entry.",
  ],
  documentation: "docs/agent-protocol.md §8 Versioning",

  check(ctx) {
    if (ctx.file.relPath !== CORE_REL_PATH) return;
    ctx.checked();

    const coreMatch = VERSION_CONST.exec(ctx.file.content);
    if (!coreMatch) {
      ctx.violated(1, 1, "AGENT_PROTOCOL_VERSION constant not found in agent-protocol.ts");
      return;
    }

    const repoRoot = resolve(ctx.file.path, "../../../..");
    let specContent: string;
    try {
      specContent = readFileSync(resolve(repoRoot, SPEC_REL_PATH), "utf8");
    } catch {
      ctx.violated(1, 1, `${SPEC_REL_PATH} not found on disk — cannot verify version sync`);
      return;
    }

    const specMatch = SPEC_VERSION.exec(specContent);
    if (!specMatch) {
      ctx.violated(1, 1, "**Version:** line not found in docs/agent-protocol.md");
      return;
    }

    const codeVersion = coreMatch[1];
    const specVersion = specMatch[1];

    if (codeVersion !== specVersion) {
      const line = ctx.file.content.substring(0, coreMatch.index).split("\n").length;
      ctx.violated(line, 1, `AGENT_PROTOCOL_VERSION = ${codeVersion} but spec says Version: ${specVersion}`);
    }
  },
};

export default rule;

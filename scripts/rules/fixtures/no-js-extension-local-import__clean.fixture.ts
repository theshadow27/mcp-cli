/**
 * @rule no-js-extension-local-import
 * @expect 0
 * @path packages/daemon/src/example-fn.ts
 *
 * Extensionless relative imports and package imports are both fine.
 * Asset imports with `with { type: ... }` are also exempt.
 */

// extensionless — clean
import type { GhResult } from "./phase-types";
import { doWork } from "./work-fn";
import { helper } from "../shared/helper";

// external package with .js — NOT a relative import, so fine
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// asset import — exempt
import templateSrc from "./template.js" with { type: "text" };

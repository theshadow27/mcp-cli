/**
 * @rule no-js-extension-local-import
 * @expect 4
 * @path packages/daemon/src/example.ts
 *
 * Relative imports with .js extension in packages/ must be flagged.
 * Non-relative package imports like @modelcontextprotocol/sdk/types.js
 * must NOT be flagged. Text/asset imports with `with { type: }` must
 * NOT be flagged.
 */

// four relative .js imports — all should be flagged
import { Foo } from "./foo.js";
import type { Bar } from "./bar.js";
import { Baz } from "../sibling/baz.js";
export { Qux } from "./qux.js";

// not relative — should NOT be flagged
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

// asset import with `with { type: "text" }` — should NOT be flagged
import wiggleSrc from "./seeds/wiggle.js" with { type: "text" };

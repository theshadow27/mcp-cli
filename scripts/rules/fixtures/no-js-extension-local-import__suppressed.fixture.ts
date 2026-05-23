/**
 * @rule no-js-extension-local-import
 * @expect 0
 * @path packages/command/src/example-suppressed.ts
 *
 * A dotw-ignore comment on the preceding line suppresses the violation.
 */

// dotw-ignore no-js-extension-local-import: transitional — migrating post bundle-rewrite
import { legacyHelper } from "./legacy-helper.js";

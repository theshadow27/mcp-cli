/**
 * Seal the listener entry points as a side effect of being imported.
 *
 * This module exists purely for import *ordering*, and that is the whole point.
 * ESM hoists imports and evaluates them before any statement in the importing
 * module's body, so a `sealNoHttp()` call inside the worker's `init` handler
 * runs **after** every module in the worker's static import graph has already
 * been evaluated. Any of them holding `import { serve } from "bun"` captured a
 * pre-seal reference, and a captured reference is not affected by redefining the
 * property afterwards — the seal reports success while a real listener can still
 * be opened.
 *
 * Imported **first** in `domain-worker.ts`, this evaluates before its siblings,
 * so their bindings resolve to the sealed functions.
 *
 * It does not close the hole completely and is not the only layer:
 * - anything imported by *this* module's own graph would still precede it (it
 *   imports one local module and nothing else, deliberately);
 * - `node:http`/`node:net`/`node:dgram`/`node:http2`/`node:tls` namespaces
 *   cannot be redefined at all;
 * so `domain-worker.ts` additionally *verifies* the property by attempting a
 * bind at startup, and #3045 lands the static rule. Ordering makes the common
 * case safe; verification is what makes the claim true.
 */

import { sealNoHttp } from "../no-http";

sealNoHttp();

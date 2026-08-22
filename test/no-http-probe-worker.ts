/**
 * Probes the no-HTTP guarantee from inside a worker thread, by trying to listen.
 *
 * The review that prompted this found that `guards: { http: "sealed" }` reported a
 * marker rather than the property, and that a static `import { serve } from "bun"`
 * evaluated *before* the seal keeps a live pre-seal reference and opens a real
 * port. No test attempted to open a port from inside a sealed worker; this one
 * does, through exactly that binding.
 *
 * Import order below mirrors `domain-worker.ts`: the autoseal side-effect module
 * comes **first**, so `serve` resolves to the sealed function. That ordering is
 * the fix, and this fixture is what makes it a tested property rather than a
 * claim about how ESM evaluates.
 */

import "../packages/daemon/src/domain/autoseal";
import { serve } from "bun";
import { isHttpSealed, verifyCannotListen } from "../packages/daemon/src/no-http";

declare const self: Worker;

/**
 * A value copy of the global, taken at module scope.
 *
 * Measured on Bun 1.4.0, this — not the static import above — is the reference
 * that survives a later seal: `import { serve } from "bun"` is a *live* binding
 * onto the global and follows the redefinition, while a copied value does not.
 * Because the autoseal import evaluates first, this copies the already-sealed
 * function and is refused. That ordering is the property under test.
 */
const copiedServe = Bun.serve;

/** Try the captured binding — the exact path that bypassed the seal. */
function probeCapturedBinding(): { opened: boolean; detail: string } {
  try {
    const server = serve({ port: 0, fetch: () => new Response("") });
    const port = server.port;
    server.stop(true);
    return { opened: true, detail: `listener opened on port ${port}` };
  } catch (err) {
    return { opened: false, detail: err instanceof Error ? err.name : String(err) };
  }
}

/** Try a value copy of the global taken at module scope — the reference that genuinely survives a late seal. */
function probeCopiedValue(): { opened: boolean; detail: string } {
  try {
    const server = copiedServe({ port: 0, fetch: () => new Response("") });
    const port = server.port;
    server.stop(true);
    return { opened: true, detail: `listener opened on port ${port}` };
  } catch (err) {
    return { opened: false, detail: err instanceof Error ? err.name : String(err) };
  }
}

self.onmessage = (): void => {
  const verification = verifyCannotListen();
  self.postMessage({
    // The marker-based answer — what the guard used to report.
    marker: isHttpSealed(),
    // The property, established by attempting a bind through the global.
    canListenViaGlobal: verification.canListen,
    // The property, established through a statically-imported binding.
    captured: probeCapturedBinding(),
    // The property, established through a module-scope value copy.
    copied: probeCopiedValue(),
  });
};

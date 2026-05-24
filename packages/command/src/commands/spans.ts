/**
 * mcx spans — view and manage trace spans from the daemon.
 *
 * Options:
 *   --json, -j     Output as JSON array to stdout
 *   --limit N      Number of spans to show (default: 100)
 *   --since MS     Filter spans starting after this timestamp (ms)
 *   --unexported   Only show unexported spans
 *
 * Subcommands:
 *   mcx spans prune   — delete exported spans
 */

import type { IpcMethod, IpcMethodResult, SpanRow } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { parseFlags } from "../flags";
import { printError } from "../output";

export interface SpansDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  printError: (msg: string) => void;
  exit: (code: number) => never;
}

const defaultDeps: SpansDeps = {
  ipcCall,
  printError,
  exit: (code) => process.exit(code),
};

export async function cmdSpans(args: string[], deps?: Partial<SpansDeps>): Promise<void> {
  const d = { ...defaultDeps, ...deps };

  // Subcommand: prune
  if (args[0] === "prune") {
    const result = await d.ipcCall("pruneSpans", {});
    console.log(JSON.stringify({ pruned: result.pruned }));
    return;
  }

  const { flags } = parseFlags(args, {
    json: { type: "boolean", alias: "j" },
    limit: { type: "number" },
    since: { type: "number" },
    unexported: { type: "boolean" },
  });

  const json = flags.json === true;
  const limit = (flags.limit as number | undefined) ?? 100;
  const since = flags.since as number | undefined;
  const unexported = flags.unexported === true;

  const result = await d.ipcCall("getSpans", { limit, since, unexported });

  if (json) {
    console.log(JSON.stringify(result.spans, null, 2));
  } else {
    if (result.spans.length === 0) {
      console.error("No spans found.");
      return;
    }
    for (const span of result.spans) {
      printSpan(span);
    }
  }
}

function printSpan(span: SpanRow): void {
  const time = new Date(span.startTimeMs).toISOString().slice(11, 23);
  const dur = `${span.durationMs}ms`.padStart(7);
  const status = span.status === "OK" ? "OK " : span.status === "ERROR" ? "ERR" : "---";
  const trace = span.traceId.slice(0, 8);
  const exported = span.exportedAt ? "E" : " ";
  console.log(`${time} ${dur} ${status} ${exported} [${trace}] ${span.name}`);
}

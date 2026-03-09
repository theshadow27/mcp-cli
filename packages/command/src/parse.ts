/** Read all of stdin as a trimmed UTF-8 string. */
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

/** Read stdin and parse as JSON. Returns {} on empty input. */
export async function readStdinJson(): Promise<Record<string, unknown>> {
  const text = await readStdin();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * Validate a --scope / -s flag value against a list of allowed scopes.
 * Throws if the value is not in the allowed list.
 */
export function parseScope<T extends string>(val: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(val)) {
    throw new Error(`Invalid scope "${val}": must be ${allowed.join(", ")}`);
  }
  return val as T;
}

/**
 * Parse a KEY=VALUE string (for --env flags).
 * Throws if the value doesn't contain an '='.
 */
export function parseEnvVar(val: string): [string, string] {
  const eqIndex = val?.indexOf("=") ?? -1;
  if (eqIndex < 0) {
    throw new Error(`Invalid --env value "${val}": expected KEY=VALUE`);
  }
  return [val.slice(0, eqIndex), val.slice(eqIndex + 1)];
}

/**
 * Split "server/tool" slash notation into [server, tool].
 * Returns null if the input doesn't contain a slash or is malformed.
 */
export function splitServerTool(arg: string): [string, string] | null {
  const idx = arg.indexOf("/");
  if (idx <= 0 || idx === arg.length - 1) return null;
  return [arg.slice(0, idx), arg.slice(idx + 1)];
}

/**
 * Extract --format json / -j flag from args.
 * Returns whether JSON output was requested and the remaining args.
 */
export function extractJsonFlag(args: string[]): { json: boolean; rest: string[] } {
  const rest: string[] = [];
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-j" || args[i] === "--json") {
      json = true;
    } else if (args[i] === "--format") {
      if (args[i + 1] === "json") {
        json = true;
        i++; // skip "json"
      } else {
        rest.push(args[i]);
      }
    } else {
      rest.push(args[i]);
    }
  }

  return { json, rest };
}

/**
 * Extract --full / -f flag from args.
 * Returns whether full output was requested and the remaining args.
 */
export function extractFullFlag(args: string[]): { full: boolean; rest: string[] } {
  const rest: string[] = [];
  let full = false;

  for (const arg of args) {
    if (arg === "--full" || arg === "-f") {
      full = true;
    } else {
      rest.push(arg);
    }
  }

  return { full, rest };
}

/**
 * Extract --timeout <seconds> flag from args.
 * Returns the timeout in milliseconds (or undefined) and the remaining args.
 */
export function extractTimeoutFlag(args: string[]): { timeoutMs: number | undefined; rest: string[] } {
  const rest: string[] = [];
  let timeoutMs: number | undefined;

  const parseSeconds = (s: string): number | undefined => {
    const val = Number(s);
    return !Number.isNaN(val) && val > 0 ? val * 1000 : undefined;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--timeout" && i + 1 < args.length) {
      const ms = parseSeconds(args[i + 1]);
      if (ms !== undefined) {
        timeoutMs = ms;
        i++;
      } else {
        rest.push(arg);
      }
    } else if (arg.startsWith("--timeout=")) {
      const ms = parseSeconds(arg.slice("--timeout=".length));
      if (ms !== undefined) {
        timeoutMs = ms;
      } else {
        rest.push(arg);
      }
    } else {
      rest.push(arg);
    }
  }

  return { timeoutMs, rest };
}

/**
 * Extract --jq '<filter>' flag from args.
 * Returns the jq filter string (or undefined) and the remaining args.
 */
export function extractJqFlag(args: string[]): { jq: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let jq: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--jq" && i + 1 < args.length) {
      jq = args[i + 1];
      i++; // skip filter value
    } else {
      rest.push(args[i]);
    }
  }

  return { jq, rest };
}

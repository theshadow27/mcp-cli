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
    if (args[i] === "-j") {
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

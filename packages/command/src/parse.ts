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

/**
 * Split "server/tool" slash notation into [server, tool].
 * Returns null if the input doesn't contain a slash or is malformed.
 */
export function splitServerTool(arg: string): [string, string] | null {
  const idx = arg.indexOf("/");
  if (idx <= 0 || idx === arg.length - 1) return null;
  return [arg.slice(0, idx), arg.slice(idx + 1)];
}

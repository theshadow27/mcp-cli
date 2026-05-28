import { type LookupResult, lookupFailure } from "./lookup-result";
import { spawnCapture, spawnCaptureSync } from "./subprocess";

export async function runOrLookupFailure(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<LookupResult<string>> {
  const result = await spawnCapture(cmd, args, opts);
  if (!result.ok) return lookupFailure(`${cmd} ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  return result.stdout;
}

export function runSyncOrLookupFailure(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): LookupResult<string> {
  const result = spawnCaptureSync(cmd, args, opts);
  if (!result.ok) return lookupFailure(`${cmd} ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  return result.stdout;
}

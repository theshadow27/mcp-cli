export interface LookupFailure {
  readonly _tag: "lookup-failure";
  readonly message: string;
}

export type LookupResult<T> = T | LookupFailure;

export function lookupFailure(message: string): LookupFailure {
  return { _tag: "lookup-failure", message };
}

export function isLookupFailure(value: unknown): value is LookupFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value as { _tag: unknown })._tag === "lookup-failure"
  );
}

export function resolveGitRootOrCwd(
  getGitRoot: () => LookupResult<string | null>,
  printError: (msg: string) => void,
  cwd: () => string = () => process.cwd(),
): string {
  const gitRoot = getGitRoot();
  if (isLookupFailure(gitRoot)) printError(gitRoot.message);
  return isLookupFailure(gitRoot) || gitRoot === null ? cwd() : gitRoot;
}

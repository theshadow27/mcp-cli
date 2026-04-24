/** Regex matching test/fixture file paths — shared between the poller and /estimate skill. */
export const TEST_PATH_RE = /\.spec\.|\.test\.|__tests__\/|(?:^|\/)tests\/|(?:^|\/)test\/fixtures\//;

/** Sum additions+deletions for non-test source files. */
export function computeSrcChurn(files: ReadonlyArray<{ path: string; additions: number; deletions: number }>): number {
  return files.filter((f) => !TEST_PATH_RE.test(f.path)).reduce((sum, f) => sum + f.additions + f.deletions, 0);
}

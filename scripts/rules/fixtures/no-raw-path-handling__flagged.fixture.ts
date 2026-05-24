/**
 * @rule no-raw-path-handling
 * @expect 3
 * @path packages/daemon/src/example-flagged.ts
 *
 * Raw path handling patterns that should be flagged.
 */

// startsWith("/") — use path.isAbsolute instead
if (target.startsWith("/")) doSomething();

// startsWith("\\\\") — UNC path check, use path.isAbsolute instead
if (target.startsWith("\\\\")) doSomething();

// process.cwd() in === comparison (daemon scope)
if (repoRoot === process.cwd()) doSomething();

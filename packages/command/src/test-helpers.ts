/**
 * Shared test helpers for command spec files.
 */
export class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

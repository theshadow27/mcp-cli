/**
 * Minimal logger interface for dependency injection.
 *
 * Production code accepts an optional Logger via constructor/function param.
 * Tests pass silentLogger to suppress console output.
 * The daemon writes everything to stderr via console.error — this interface
 * formalizes that pattern without adding log levels or transports.
 */

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** Default logger that writes to console.error (stderr). */
export const consoleLogger: Logger = {
  error: (...args) => console.error(...args),
  warn: (...args) => console.error(...args),
  info: (...args) => console.error(...args),
  debug: (...args) => console.error(...args),
};

/** Silent logger for tests — suppresses all output. */
export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

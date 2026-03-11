/**
 * Minimal logger interface for dependency injection.
 *
 * Production code accepts an optional Logger via constructor/function param.
 * Tests pass silentLogger to suppress console output, or capturingLogger()
 * to capture and assert on log messages.
 */

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** Default logger that routes each level to its corresponding console method. */
export const consoleLogger: Logger = {
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args),
  info: (...args) => console.info(...args),
  debug: (...args) => console.debug(...args),
};

/** Silent logger for tests — suppresses all output. */
export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

/** Captured log message with its severity level. */
export interface CapturedMessage {
  level: "error" | "warn" | "info" | "debug";
  args: unknown[];
}

/**
 * Create a logger that captures all messages to an array for test assertions.
 * Access `.messages` for level-tagged entries, or `.texts` for string representations.
 */
export function capturingLogger(): { logger: Logger; messages: CapturedMessage[]; texts: string[] } {
  const messages: CapturedMessage[] = [];
  const texts: string[] = [];
  const capture = (level: CapturedMessage["level"]) => {
    return (...args: unknown[]) => {
      messages.push({ level, args });
      texts.push(String(args[0]));
    };
  };
  const logger: Logger = {
    error: capture("error"),
    warn: capture("warn"),
    info: capture("info"),
    debug: capture("debug"),
  };
  return { logger, messages, texts };
}

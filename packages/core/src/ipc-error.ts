/**
 * IPC error codes, and the factory that attaches one to an `Error`.
 *
 * ## Why this is its own module, and not part of `ipc.ts`
 *
 * `ipc-server.ts` classifies a thrown error by reading `err.code`: a numeric one is
 * used verbatim, anything else becomes `INTERNAL_ERROR`. So "which code does the
 * caller see" is decided at the **throw site**, not at the boundary — which means the
 * pure validators that reject caller input need to reach these codes.
 *
 * `ipc.ts` imports `Domain` from `domain.ts`, so `domain.ts` importing `IPC_ERROR`
 * back out of `ipc.ts` is an import cycle (the `no-import-cycles` rule counts a
 * type-only import as an edge, because at that layer it cannot know it is erasable).
 * A leaf module with no imports of its own breaks that: both sides depend on it, and
 * it depends on nothing. `ipc.ts` re-exports {@link IPC_ERROR} so every existing
 * `import { IPC_ERROR } from "@mcp-cli/core"` is untouched.
 */

// -- Error codes --

export const IPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_FOUND: -1001,
  TOOL_NOT_FOUND: -1002,
  CONNECTION_FAILED: -1003,
  AUTH_REQUIRED: -1004,
  TIMEOUT: -1005,
} as const;

/**
 * An `Error` that the IPC boundary will report as `INVALID_PARAMS` rather than
 * `INTERNAL_ERROR`.
 *
 * The distinction is not cosmetic: `INTERNAL_ERROR` tells a caller "the daemon broke,
 * there is nothing you can do", while `INVALID_PARAMS` tells it "you sent something
 * wrong, fix it and retry". A validator that rejects a relative path is squarely the
 * second, and reporting it as the first sends the caller looking for a daemon bug
 * (#3246).
 */
export function invalidParamsError(message: string): Error {
  return Object.assign(new Error(message), { code: IPC_ERROR.INVALID_PARAMS });
}

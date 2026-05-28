import type { NdjsonRecorder } from "@mcp-cli/core";
import type { WorkerClientTransport } from "./worker-transport";

export interface RecordingSetup {
  rawTransportHandler(): ((this: Worker, event: MessageEvent) => void) | null;
}

/**
 * Wire NDJSON recording onto a worker + transport pair.
 *
 * Must be called AFTER the transport is constructed but BEFORE
 * client.connect() so the MCP initialize handshake is captured.
 *
 * Patches:
 *   - transport.send  → records every daemon→worker MCP message
 *   - transport.start → wraps the worker.onmessage that start() installs,
 *     recording every worker→daemon message during the handshake
 *
 * Returns a handle whose rawTransportHandler() yields the transport's
 * original (un-wrapped) worker.onmessage — use it as the MCP fallthrough
 * in the post-connect wrapper to avoid double-recording.
 */
export function setupRecording(
  worker: Worker,
  transport: WorkerClientTransport,
  recorder: NdjsonRecorder,
): RecordingSetup {
  const origSend = transport.send.bind(transport);
  transport.send = (msg, opts) => {
    recorder.recordMessage("daemon->worker", msg);
    return origSend(msg, opts);
  };

  let _rawHandler: ((this: Worker, event: MessageEvent) => void) | null = null;
  const origStart = transport.start.bind(transport);
  transport.start = async () => {
    await origStart();
    _rawHandler = worker.onmessage as typeof _rawHandler;
    const raw = _rawHandler;
    worker.onmessage = (event: MessageEvent) => {
      recorder.recordMessage("worker->daemon", event.data);
      raw?.call(worker, event);
    };
  };

  return { rawTransportHandler: () => _rawHandler };
}

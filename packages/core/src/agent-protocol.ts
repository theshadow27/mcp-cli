export const AGENT_PROTOCOL_VERSION = 1;

export const AGENT_PROTOCOL_SPEC_URL = "docs/agent-protocol.md";

export class ProtocolVersionMismatchError extends Error {
  readonly requested: number;
  readonly supported: number;
  readonly docUrl: string;

  constructor(requested: number, supported: number) {
    super(
      `Protocol version mismatch: daemon requested v${requested}, worker supports v${supported}. See ${AGENT_PROTOCOL_SPEC_URL}`,
    );
    this.name = "ProtocolVersionMismatchError";
    this.requested = requested;
    this.supported = supported;
    this.docUrl = AGENT_PROTOCOL_SPEC_URL;
  }
}

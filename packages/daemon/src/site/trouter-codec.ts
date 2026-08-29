/**
 * socket.io 0.9 frame codec for the Trouter transport.
 *
 * Trouter (Microsoft Teams' push endpoint) speaks the *legacy* socket.io 0.9
 * wire protocol — colon-delimited `type:id:endpoint:data` strings — NOT modern
 * socket.io / Engine.IO v4. No client library speaks 0.9 any more, so we
 * hand-roll the ~framing here. This module is pure string<->struct with no I/O,
 * which is what makes the worker unit-testable against synthetic frames.
 *
 * Frame grammar (`<type>:<id>:<endpoint>:<data>`):
 *   - `type`     one ASCII digit (0-8), the socket.io packet type.
 *   - `id`       optional message id; a trailing `+` means "ack required".
 *   - `endpoint` optional namespace (always empty for Trouter).
 *   - `data`     the remainder of the string (may itself contain colons).
 *
 * Packet types we care about:
 *   0  disconnect      `0:::{"reason":"timeout"}`  server-initiated close
 *   1  connect         `1::`                        connect ack
 *   2  heartbeat       `2::`                        ping/pong keepalive
 *   3  message         `3:::{...}`                  Trouter HTTP-shaped envelope
 *   5  event           `5:1::{"name":"...","args":[...]}`
 *   6  ack             `6:::<id>+<jsonArgs>`        ack for an id+ event
 */

export const TROUTER_PACKET = {
  disconnect: 0,
  connect: 1,
  heartbeat: 2,
  message: 3,
  json: 4,
  event: 5,
  ack: 6,
  error: 7,
  noop: 8,
} as const;

export interface TrouterFrame {
  /** socket.io packet type (0-8). */
  type: number;
  /** Message id without the ack marker, or "" when absent. */
  id: string;
  /** True when the id carried a trailing `+` (server wants an ack). */
  needsAck: boolean;
  /** Namespace/endpoint segment (always "" for Trouter). */
  endpoint: string;
  /** Raw data segment (everything after the third colon). */
  data: string;
}

/** A decoded `5:...::{"name","args"}` event frame. */
export interface TrouterEventFrame {
  id: string;
  needsAck: boolean;
  name: string;
  args: unknown[];
}

/**
 * Parse one raw socket.io-0.9 frame string into its parts.
 *
 * Splits on the first three colons only; the `data` segment keeps any further
 * colons intact (JSON bodies contain them). Returns null for a frame whose type
 * segment is not a single digit.
 */
export function parseFrame(raw: string): TrouterFrame | null {
  // Split into at most 4 pieces: type, id, endpoint, data. The trailing `data`
  // colon is omitted when there is no data (`1::`, `2::`), so the third colon
  // is optional.
  const first = raw.indexOf(":");
  if (first < 0) return null;
  const second = raw.indexOf(":", first + 1);
  if (second < 0) return null;
  const third = raw.indexOf(":", second + 1);

  const typeStr = raw.slice(0, first);
  const type = Number(typeStr);
  if (typeStr.length === 0 || !Number.isInteger(type)) return null;

  let idPart = raw.slice(first + 1, second);
  const endpoint = third < 0 ? raw.slice(second + 1) : raw.slice(second + 1, third);
  const data = third < 0 ? "" : raw.slice(third + 1);

  let needsAck = false;
  if (idPart.endsWith("+")) {
    needsAck = true;
    idPart = idPart.slice(0, -1);
  }

  return { type, id: idPart, needsAck, endpoint, data };
}

/** Decode a type-5 event frame's data payload (`{"name","args"}`). */
export function parseEventFrame(frame: TrouterFrame): TrouterEventFrame | null {
  if (frame.type !== TROUTER_PACKET.event) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { name?: unknown; args?: unknown };
  if (typeof obj.name !== "string") return null;
  const args = Array.isArray(obj.args) ? obj.args : [];
  return { id: frame.id, needsAck: frame.needsAck, name: obj.name, args };
}

/** Encode a `5:::{"name","args"}` event frame (id omitted — no ack expected). */
export function encodeEvent(name: string, args: unknown[]): string {
  return `5:::${JSON.stringify({ name, args })}`;
}

/** Encode a type-3 message frame carrying an arbitrary JSON envelope. */
export function encodeMessage(body: unknown): string {
  return `3:::${JSON.stringify(body)}`;
}

/** The socket.io heartbeat reply. */
export function encodeHeartbeat(): string {
  return "2::";
}

/**
 * Encode a type-6 ack for an `id+` event frame. The id and the JSON-encoded
 * args are packed into the data segment separated by `+`
 * (e.g. `6:::7+["pong"]`).
 */
export function encodeAck(id: string, args: unknown[]): string {
  return `6:::${id}+${JSON.stringify(args)}`;
}

/** True for the server's initiated-close frame (`0:::...`). */
export function isDisconnect(frame: TrouterFrame): boolean {
  return frame.type === TROUTER_PACKET.disconnect;
}

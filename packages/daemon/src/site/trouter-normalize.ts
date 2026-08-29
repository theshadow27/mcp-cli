/**
 * Normalise a Trouter `messaging`-flow event body into a flat, source-agnostic
 * record for the daemon event bus.
 *
 * The wire shapes handled here are documented from a live probe (see
 * docs/watch.md § "Event schema"). All field names and discriminators below
 * come from that probe; no real ids, names, or content are embedded — the
 * synthetic fixtures in `trouter-normalize.spec.ts` exercise every branch.
 *
 * Event-kind discrimination:
 *   - deleted  ⟺ properties.deletetime present (content is tombstoned to "")
 *   - edited   ⟺ properties.edittime present  (and version > id)
 *   - reaction ⟺ MessageUpdate with version != id but no edit/delete
 *                (the change is in properties.emotions / annotationsSummary)
 *   - thread   ⟺ ThreadUpdate / ConversationUpdate, or a ThreadActivity/* system message
 *   - new      ⟺ NewMessage with a normal messagetype
 */

/** Discriminated kind of a normalised site message event. */
export type SiteMessageKind = "new" | "edited" | "deleted" | "reaction" | "thread";

/** Flat record spread onto a `site.message` monitor event. */
export interface NormalisedSiteMessage {
  site: string;
  /** Thread id (mri/conversation id). */
  thread: string;
  /** Human thread title when the wire carried one (topic); overridden by the caller with a configured name when known. */
  threadName?: string;
  /** Stable message id (epoch-ms string). Unchanged across edit/delete. */
  id: string;
  /** Mutation clock (epoch-ms string). `version > id` after edit/delete/reaction. */
  version: string;
  /** ISO timestamp of the message (composetime, falling back to the envelope time). */
  at: string;
  /** Sender display name, when present. */
  from?: string;
  /** Sender MRI (e.g. `8:orgid:<oid>`). */
  from_id?: string;
  /** True when the sender is us. */
  is_me: boolean;
  /** True when the message @-mentions us. */
  mentions_me: boolean;
  kind: SiteMessageKind;
  /** Plain-text rendering of the message content (HTML stripped). */
  text: string;
  /** Quoted-reply target message id, when this is a reply. */
  reply_to?: string;
}

interface ParsedMention {
  mri?: string;
  displayName?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

/** Extract the thread id and message id from a Trouter `resourceLink`. */
export function parseResourceLink(link: string): { thread?: string; message?: string } {
  // .../conversations/<threadId>/messages/<msgId>
  const m = link.match(/\/conversations\/([^/]+)(?:\/messages\/([^/?]+))?/);
  if (!m) return {};
  return {
    thread: m[1] ? decodeURIComponent(m[1]) : undefined,
    message: m[2] ? decodeURIComponent(m[2]) : undefined,
  };
}

/** The sender MRI from a `from` field that may be a bare MRI or a `.../contacts/<mri>` URL. */
export function senderMri(from: unknown): string | undefined {
  const s = str(from);
  if (!s) return undefined;
  return s.includes("/") ? (s.split("/").pop() ?? undefined) : s;
}

/** Parse `properties.mentions`, which is either a JSON-encoded string or an array. */
export function parseMentions(raw: unknown): ParsedMention[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "" || raw.trim() === "[]") return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((m) => asRecord(m))
    .filter((m): m is Record<string, unknown> => m !== null)
    .map((m) => ({ mri: str(m.mri), displayName: str(m.displayName) }));
}

/** Strip HTML tags and decode the handful of entities Teams emits, yielding plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<blockquote[^>]*schema\.skype\.com\/Reply[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function replyTarget(props: Record<string, unknown> | null): string | undefined {
  if (!props) return undefined;
  const qtd = props.qtdMsgs;
  if (Array.isArray(qtd) && qtd.length > 0) {
    const first = asRecord(qtd[0]);
    if (first) return str(first.messageId);
  }
  return undefined;
}

function classifyKind(
  resourceType: string,
  props: Record<string, unknown> | null,
  messageType: string,
): SiteMessageKind {
  if (resourceType === "ThreadUpdate" || resourceType === "ConversationUpdate") return "thread";
  if (messageType.startsWith("ThreadActivity/")) return "thread";
  if (props?.deletetime !== undefined) return "deleted";
  if (props?.edittime !== undefined) return "edited";
  if (resourceType === "MessageUpdate") return "reaction";
  return "new";
}

/**
 * Normalise one raw chatsvc `messages[]` row (the `get_messages` REST shape,
 * which is the same lowercase shape as a push event's `resource`) into a
 * {@link NormalisedSiteMessage}. Used for REST gap-fill on reconnect.
 *
 * The REST feed carries no envelope `resourceType`, so the kind is inferred from
 * `version` vs `id` plus the edit/delete markers: `version == id` → new;
 * `deletetime` → deleted; `edittime` → edited; otherwise a bare `version > id`
 * is a reaction/annotation change.
 */
export function normaliseChatsvcMessage(
  msg: unknown,
  site: string,
  thread: string,
  ourMri: string | undefined,
): NormalisedSiteMessage | null {
  const m = asRecord(msg);
  if (!m) return null;
  const id = str(m.id);
  if (!id) return null;
  const version = str(m.version) ?? id;
  const props = asRecord(m.properties);
  const messageType = str(m.messagetype) ?? "";

  let kind: SiteMessageKind;
  if (messageType.startsWith("ThreadActivity/")) kind = "thread";
  else if (props?.deletetime !== undefined) kind = "deleted";
  else if (props?.edittime !== undefined) kind = "edited";
  else if (version !== id) kind = "reaction";
  else kind = "new";

  const fromId = senderMri(m.from);
  const fromName = str(m.imdisplayname);
  const mentions = parseMentions(props?.mentions);

  return {
    site,
    thread,
    id,
    version,
    at: str(m.composetime) ?? str(m.originalarrivaltime) ?? new Date().toISOString(),
    ...(fromName ? { from: fromName } : {}),
    ...(fromId ? { from_id: fromId } : {}),
    is_me: ourMri !== undefined && fromId === ourMri,
    mentions_me: ourMri !== undefined && mentions.some((mm) => mm.mri === ourMri),
    kind,
    text: htmlToText(str(m.content) ?? ""),
    ...(replyTarget(props) ? { reply_to: replyTarget(props) } : {}),
  };
}

/**
 * Normalise one parsed Trouter messaging-event body into a {@link NormalisedSiteMessage}.
 *
 * @param body   the parsed JSON envelope (already `JSON.parse`d from the frame's `body` string)
 * @param site   site name (e.g. "teams")
 * @param ourMri our own MRI, for `is_me` / `mentions_me` derivation (may be undefined if unknown)
 * @returns the normalised record, or null when the body is not a recognisable message event
 */
export function normaliseTrouterMessage(
  body: unknown,
  site: string,
  ourMri: string | undefined,
): NormalisedSiteMessage | null {
  const env = asRecord(body);
  if (!env) return null;

  const resourceType = str(env.resourceType) ?? "";
  const resource = asRecord(env.resource);
  const link = str(env.resourceLink) ?? "";
  const linkParts = parseResourceLink(link);

  const props = resource ? asRecord(resource.properties) : null;
  const messageType = (resource ? str(resource.messagetype) : undefined) ?? "";

  const thread = (resource ? str(resource.to) : undefined) ?? linkParts.thread;
  const id = (resource ? str(resource.id) : undefined) ?? linkParts.message;
  if (!thread || !id) return null;

  const version = (resource ? str(resource.version) : undefined) ?? id;
  const at = (resource ? str(resource.composetime) : undefined) ?? str(env.time) ?? new Date().toISOString();
  const fromId = resource ? senderMri(resource.from) : undefined;
  const fromName = resource ? str(resource.imdisplayname) : undefined;

  const mentions = parseMentions(props?.mentions);
  const mentionsMe = ourMri !== undefined && mentions.some((m) => m.mri === ourMri);
  const isMe = ourMri !== undefined && fromId === ourMri;

  const content = (resource ? str(resource.content) : undefined) ?? "";
  const text = htmlToText(content);

  const threadName = resource ? str(resource.threadtopic) : undefined;

  return {
    site,
    thread,
    ...(threadName ? { threadName } : {}),
    id,
    version,
    at,
    ...(fromName ? { from: fromName } : {}),
    ...(fromId ? { from_id: fromId } : {}),
    is_me: isMe,
    mentions_me: mentionsMe,
    kind: classifyKind(resourceType, props, messageType),
    text,
    ...(replyTarget(props) ? { reply_to: replyTarget(props) } : {}),
  };
}

import { describe, expect, test } from "bun:test";
import {
  htmlToText,
  normaliseChatsvcMessage,
  normaliseTrouterMessage,
  parseMentions,
  parseResourceLink,
  senderMri,
} from "./trouter-normalize";

// Synthetic MRIs / ids only — no real tenant, person, or thread data.
const ME = "8:orgid:00000000-0000-0000-0000-00000000aaaa";
const OTHER = "8:orgid:00000000-0000-0000-0000-00000000bbbb";
const THREAD = "19:synthetic_thread_id@thread.v2";

function newMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    time: "2026-08-28T10:00:00.000Z",
    type: "EventMessage",
    resourceType: "NewMessage",
    resourceLink: `https://notifications.example/v1/users/ME/conversations/${THREAD}/messages/1700000000001`,
    resource: {
      messagetype: "RichText/Html",
      id: "1700000000001",
      version: "1700000000001",
      composetime: "2026-08-28T10:00:00.000Z",
      from: `https://example/users/ME/contacts/${OTHER}`,
      imdisplayname: "Synthetic Sender",
      to: THREAD,
      threadtopic: "Synthetic Topic",
      content: "<p>hello <b>world</b></p>",
      properties: {},
      ...(overrides.resource as Record<string, unknown>),
    },
    ...overrides,
  };
}

describe("parseResourceLink", () => {
  test("extracts thread and message ids", () => {
    const r = parseResourceLink(`https://x/conversations/${THREAD}/messages/1700000000001`);
    expect(r.thread).toBe(THREAD);
    expect(r.message).toBe("1700000000001");
  });
  test("handles a conversation-only link", () => {
    const r = parseResourceLink(`https://x/conversations/${THREAD}`);
    expect(r.thread).toBe(THREAD);
    expect(r.message).toBeUndefined();
  });
});

describe("senderMri", () => {
  test("takes the last path segment of a contacts url", () => {
    expect(senderMri(`https://x/users/ME/contacts/${ME}`)).toBe(ME);
  });
  test("passes a bare mri through", () => {
    expect(senderMri(ME)).toBe(ME);
  });
  test("returns undefined for nothing", () => {
    expect(senderMri(undefined)).toBeUndefined();
  });
});

describe("parseMentions", () => {
  test("parses a JSON-encoded string", () => {
    const raw = JSON.stringify([{ mri: ME, displayName: "Me" }]);
    expect(parseMentions(raw)).toEqual([{ mri: ME, displayName: "Me" }]);
  });
  test("parses an already-array value", () => {
    expect(parseMentions([{ mri: OTHER, displayName: "Other" }])).toEqual([{ mri: OTHER, displayName: "Other" }]);
  });
  test("returns [] for empty string / '[]'", () => {
    expect(parseMentions("")).toEqual([]);
    expect(parseMentions("[]")).toEqual([]);
  });
  test("returns [] for garbage", () => {
    expect(parseMentions("{not json")).toEqual([]);
  });
});

describe("htmlToText", () => {
  test("strips tags and decodes entities", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt;</p>")).toBe("a & b <c>");
  });
  test("removes a leading quoted-reply blockquote", () => {
    const html =
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="9"><p itemprop="preview">old</p></blockquote><p>new</p>';
    expect(htmlToText(html)).toBe("new");
  });
});

describe("normaliseTrouterMessage", () => {
  test("normalises a new message and derives is_me=false", () => {
    const r = normaliseTrouterMessage(newMessage(), "teams", ME);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("new");
    expect(r?.thread).toBe(THREAD);
    expect(r?.id).toBe("1700000000001");
    expect(r?.from_id).toBe(OTHER);
    expect(r?.is_me).toBe(false);
    expect(r?.mentions_me).toBe(false);
    expect(r?.text).toBe("hello world");
    expect(r?.threadName).toBe("Synthetic Topic");
  });

  test("derives is_me when we are the sender", () => {
    const r = normaliseTrouterMessage(
      newMessage({ resource: { from: `https://example/users/ME/contacts/${ME}` } }),
      "teams",
      ME,
    );
    expect(r?.is_me).toBe(true);
  });

  test("derives mentions_me from properties.mentions", () => {
    const r = normaliseTrouterMessage(
      newMessage({ resource: { properties: { mentions: JSON.stringify([{ mri: ME, displayName: "Me" }]) } } }),
      "teams",
      ME,
    );
    expect(r?.mentions_me).toBe(true);
  });

  test("classifies an edit", () => {
    const r = normaliseTrouterMessage(
      newMessage({
        resourceType: "MessageUpdate",
        resource: { version: "1700000000999", properties: { edittime: 1700000000999 } },
      }),
      "teams",
      ME,
    );
    expect(r?.kind).toBe("edited");
    expect(r?.version).toBe("1700000000999");
  });

  test("classifies a delete", () => {
    const r = normaliseTrouterMessage(
      newMessage({
        resourceType: "MessageUpdate",
        resource: { content: "", properties: { deletetime: 1700000000999 } },
      }),
      "teams",
      ME,
    );
    expect(r?.kind).toBe("deleted");
  });

  test("classifies a reaction-only update", () => {
    const r = normaliseTrouterMessage(
      newMessage({
        resourceType: "MessageUpdate",
        resource: { version: "1700000000999", properties: { emotions: [{ key: "like", users: [] }] } },
      }),
      "teams",
      ME,
    );
    expect(r?.kind).toBe("reaction");
  });

  test("classifies a thread update", () => {
    const r = normaliseTrouterMessage(newMessage({ resourceType: "ThreadUpdate" }), "teams", ME);
    expect(r?.kind).toBe("thread");
  });

  test("extracts reply_to from qtdMsgs", () => {
    const r = normaliseTrouterMessage(
      newMessage({ resource: { properties: { qtdMsgs: [{ messageId: 1700000000000 }] } } }),
      "teams",
      ME,
    );
    expect(r?.reply_to).toBe("1700000000000");
  });

  test("returns null when thread or id is missing", () => {
    expect(normaliseTrouterMessage({ resourceType: "NewMessage" }, "teams", ME)).toBeNull();
  });

  test("mentions_me is false when our mri is unknown", () => {
    const r = normaliseTrouterMessage(
      newMessage({ resource: { properties: { mentions: JSON.stringify([{ mri: ME }]) } } }),
      "teams",
      undefined,
    );
    expect(r?.mentions_me).toBe(false);
    expect(r?.is_me).toBe(false);
  });
});

describe("normaliseChatsvcMessage (gap-fill)", () => {
  const base = {
    id: "1700000000001",
    version: "1700000000001",
    messagetype: "RichText/Html",
    composetime: "2026-08-28T10:00:00.000Z",
    from: `https://x/users/ME/contacts/${OTHER}`,
    imdisplayname: "Sender",
    content: "<p>backfilled</p>",
    properties: {},
  };

  test("maps a new message", () => {
    const r = normaliseChatsvcMessage(base, "teams", THREAD, ME);
    expect(r?.kind).toBe("new");
    expect(r?.thread).toBe(THREAD);
    expect(r?.text).toBe("backfilled");
    expect(r?.from_id).toBe(OTHER);
  });

  test("infers edited from edittime", () => {
    const r = normaliseChatsvcMessage(
      { ...base, version: "1700000009999", properties: { edittime: 1700000009999 } },
      "teams",
      THREAD,
      ME,
    );
    expect(r?.kind).toBe("edited");
  });

  test("infers reaction from version>id with no edit/delete", () => {
    const r = normaliseChatsvcMessage({ ...base, version: "1700000009999", properties: {} }, "teams", THREAD, ME);
    expect(r?.kind).toBe("reaction");
  });

  test("returns null without an id", () => {
    expect(normaliseChatsvcMessage({ version: "1" }, "teams", THREAD, ME)).toBeNull();
  });
});

/**
 * Contract tests for the teams seed's jq transforms.
 *
 * The teams catalog carries most of its behaviour in jq — the normalised
 * `get_messages` projection, the mention/quoted-reply body shaping on
 * `send_message`, the thread directory, and the `captureVars` that feed
 * `$vars`. None of that is exercised by the generic seed tests in
 * seeds.spec.ts, and a typo in an escaped jq string is invisible until a live
 * call fails, so every expression runs here against synthetic fixtures.
 *
 * Fixtures are wholly synthetic (`8:orgid:0000…`, `User One`) — no captured
 * account data, ids or message content belongs in the repo.
 *
 * Requires the external `jq` binary, which is also what the daemon shells out
 * to; skipped rather than failed where it is absent.
 */

import { describe, expect, test } from "bun:test";
import type { CaptureVarSpec } from "./config";
import { BUILTIN_SEEDS } from "./seeds";
import { bunJqRunner } from "./transforms";

const ME = "8:orgid:00000000-0000-0000-0000-00000000000a";
const OTHER = "8:orgid:00000000-0000-0000-0000-00000000000b";
const THIRD = "8:orgid:00000000-0000-0000-0000-00000000000c";
const CONTACT = "https://amer.ng.msg.teams.microsoft.com/v1/users/ME/contacts/";

const teams = BUILTIN_SEEDS.teams;
const catalog = teams.catalog;
const captureVars = (teams.config.captureVars ?? []) as CaptureVarSpec[];

const hasJq = Boolean(Bun.which("jq"));

/** Run a catalog jq expression, returning the parsed result. */
async function runJq(expr: string, input: unknown, named?: Record<string, unknown>): Promise<unknown> {
  const out = await bunJqRunner(expr, JSON.stringify(input), named);
  return JSON.parse(out);
}

/** A jq_output expression, with the daemon's `$vars`/`$params` named args bound. */
function output(call: string): string {
  const expr = catalog[call]?.jq_output;
  if (!expr) throw new Error(`seed call '${call}' has no jq_output`);
  return expr;
}

function input(call: string): string {
  const expr = catalog[call]?.jq_input;
  if (!expr) throw new Error(`seed call '${call}' has no jq_input`);
  return expr;
}

/** The jq_input document shape applyJqInput builds (transforms.ts). */
function inputDoc(call: string, params: Record<string, unknown>, vars: Record<string, string> = {}) {
  return { params, body_default: catalog[call]?.body_default ?? null, vars };
}

/** The quoted-reply blockquote Teams puts at the head of a reply's content. */
function replyBlockquote(mri: string, name: string, preview: string, id = "1700000000400"): string {
  return (
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="${id}">` +
    `<strong itemprop="mri" itemid="${mri}">${name}</strong>` +
    `<span itemprop="time" itemid="${id}"></span>` +
    `<p itemprop="preview">${preview}</p></blockquote>`
  );
}

const messagesFixture = {
  messages: [
    {
      id: "1700000000900",
      version: "1700000000900",
      sequenceId: 108,
      messagetype: "RichText/Html",
      from: `${CONTACT}${ME}`,
      imdisplayname: "User One",
      composetime: "2026-08-27T10:00:00.9000000Z",
      originalarrivaltime: "2026-08-27T10:00:00.9000000Z",
      content: "<p>plain hello</p>",
      properties: {},
    },
    {
      id: "1700000000800",
      version: "1700000000800",
      sequenceId: 107,
      messagetype: "RichText/Html",
      from: `${CONTACT}${OTHER}`,
      imdisplayname: "User Two",
      originalarrivaltime: "2026-08-27T09:59:00.8000000Z",
      content:
        '<p><span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">User One</span>' +
        ' and <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="1">User Three</span>, look</p>',
      properties: {
        mentions: JSON.stringify([
          {
            "@type": "http://schema.skype.com/Mention",
            itemid: 0,
            mri: ME,
            mentionType: "person",
            displayName: "User One",
          },
          {
            "@type": "http://schema.skype.com/Mention",
            itemid: 1,
            mri: THIRD,
            mentionType: "person",
            displayName: "User Three",
          },
        ]),
      },
    },
    {
      id: "1700000000700",
      version: "1700000000750",
      messagetype: "RichText/Html",
      from: `${CONTACT}${OTHER}`,
      imdisplayname: "User Two",
      originalarrivaltime: "2026-08-27T09:58:00.7000000Z",
      content: "<p>edited text</p>",
      properties: { edittime: 1700000000750, composetime: "2026-08-27T09:58:00.700Z" },
    },
    {
      id: "1700000000600",
      version: "1700000000650",
      messagetype: "RichText/Html",
      from: `${CONTACT}${OTHER}`,
      imdisplayname: "User Two",
      originalarrivaltime: "2026-08-27T09:57:00.6000000Z",
      content: "",
      properties: {
        deletetime: 1700000000650,
        hardDeleteTime: 1700000000650,
        hardDeleteReason: "ThreadServiceDeleteMessage",
      },
    },
    {
      id: "1700000000500",
      version: "1700000000500",
      messagetype: "RichText/Html",
      from: `${CONTACT}${ME}`,
      imdisplayname: "User One",
      originalarrivaltime: "2026-08-27T09:56:00.5000000Z",
      content: `${replyBlockquote(OTHER, "User Two", "earlier line")}\n<p>replying now</p>`,
      properties: {
        qtdMsgs: [{ messageId: 1700000000400, sender: OTHER, time: 1700000000400, validationResult: "Valid" }],
        hasValidMsgReferences: true,
      },
    },
    {
      id: "1700000000300",
      version: "1700000000300",
      messagetype: "ThreadActivity/AddMember",
      from: `${CONTACT}19:00000000000000000000000000000000@thread.v2`,
      originalarrivaltime: "2026-08-27T09:54:00.3000000Z",
      content: `<addmember><initiator>${OTHER}</initiator><target>${THIRD}</target></addmember>`,
      properties: {},
    },
  ],
  _metadata: {
    lastCompleteSegmentStartTime: 1700000000300,
    lastCompleteSegmentEndTime: 1700000000900,
    syncState:
      "https://teams.cloud.microsoft/api/chatsvc/amer/v1/users/ME/conversations/19:x@thread.v2/messages" +
      "?startTime=0&syncState=3e450000abcd&pageSize=5&view=msnp24Equivalent",
  },
};

const updatesFixture = {
  chats: [
    {
      id: "19:00000000000000000000000000000000@thread.v2",
      title: "Synthetic Thread",
      threadType: "meeting",
      chatType: "meeting",
      isOneOnOne: false,
      isExternal: false,
      isRead: false,
      hidden: false,
      isHighImportance: false,
      isLastMessageFromMe: false,
      members: [
        { mri: ME, objectId: "00000000-0000-0000-0000-00000000000a", role: "Admin" },
        { mri: OTHER, objectId: "00000000-0000-0000-0000-00000000000b", role: "User" },
      ],
      lastMessage: {
        imDisplayName: "User Two",
        from: OTHER,
        originalArrivalTime: "2026-08-27T09:59:00.8000000Z",
        content: "<p>preview&nbsp;text</p>",
      },
    },
  ],
  channels: [
    {
      id: "19:11111111111111111111111111111111@thread.tacv2",
      displayName: "General",
      parentTeamId: "19:22222222222222222222222222222222@thread.tacv2",
      isMessageRead: false,
      isMuted: false,
      membershipSummary: { totalMemberCount: 5 },
      lastMessage: {
        imDisplayName: "User Two",
        originalArrivalTime: "2026-08-27T09:50:00.0000000Z",
        content: "<p>hi</p>",
      },
    },
  ],
  teams: [
    {
      id: "19:22222222222222222222222222222222@thread.tacv2",
      displayName: "Synthetic Team",
      channels: [{ id: "19:11111111111111111111111111111111@thread.tacv2", displayName: "General" }],
    },
  ],
  metadata: { syncToken: "synthetic-sync-token", isPartialData: false },
};

describe.skipIf(!hasJq)("teams seed — get_messages jq_output", () => {
  test("normalises every message and exposes a version cursor", async () => {
    const result = (await runJq(output("get_messages"), messagesFixture, {
      vars: { me_mri: ME },
      params: { threadId: "19:x@thread.v2" },
    })) as {
      count: number;
      cursor: number;
      next_start_time: number;
      sync_state: string;
      messages: Record<string, unknown>[];
    };

    expect(result.count).toBe(6);
    // The cursor is max(version), not max(id) — the server filters startTime on version.
    expect(result.cursor).toBe(1700000000900);
    expect(result.next_start_time).toBe(1700000000901);
    // _metadata.syncState is a URL; only the token inside it is a usable param.
    expect(result.sync_state).toBe("3e450000abcd");

    const [plain, mentions, edited, deleted, quoted, system] = result.messages;

    expect(plain).toMatchObject({
      id: "1700000000900",
      version: 1700000000900,
      at: "2026-08-27T10:00:00.900Z",
      from_id: ME,
      from: "User One",
      is_me: true,
      mentions: [],
      mentions_me: false,
      edited: false,
      deleted: false,
      reply_to: null,
      text: "plain hello",
    });

    expect(mentions).toMatchObject({
      is_me: false,
      mentions_me: true,
      mentions: [
        { mri: ME, name: "User One" },
        { mri: THIRD, name: "User Three" },
      ],
      text: "@User One and @User Three, look",
    });

    // id survives an edit; version is the mutation clock.
    expect(edited).toMatchObject({ id: "1700000000700", version: 1700000000750, edited: true, deleted: false });
    expect(deleted).toMatchObject({ deleted: true, hard_deleted: true, text: "" });

    // reply_to is the QUOTED message (properties.qtdMsgs), as a string to match `id`.
    expect(quoted).toMatchObject({ reply_to: "1700000000400", text: "replying now" });
    expect(system).toMatchObject({ from: "system", type: "ThreadActivity/AddMember", text: `[joined: ${THIRD}]` });
  });

  test("is_me and mentions_me read false when me_mri was never captured", async () => {
    const result = (await runJq(output("get_messages"), messagesFixture, { vars: {}, params: {} })) as {
      messages: { is_me: boolean; mentions_me: boolean }[];
    };
    expect(result.messages.every((m) => m.is_me === false)).toBe(true);
    expect(result.messages.every((m) => m.mentions_me === false)).toBe(true);
  });

  test("an empty message list yields a null cursor rather than an error", async () => {
    const result = await runJq(output("get_messages"), { messages: [] }, { vars: {}, params: {} });
    expect(result).toEqual({ count: 0, cursor: null, next_start_time: null, sync_state: null, messages: [] });
  });
});

describe.skipIf(!hasJq)("teams seed — send_message jq_input", () => {
  test("weaves mention spans in place and emits the JSON-encoded properties.mentions", async () => {
    const body = (await runJq(
      input("send_message"),
      inputDoc(
        "send_message",
        {
          threadId: "48:notes",
          content: "<p>hi @User One and @User Three, see this</p>",
          mention: `${ME}=User One,${THIRD}=User Three`,
          clientmessageid: "123",
        },
        { me_mri: ME },
      ),
    )) as { content: string; clientmessageid: string; properties: { mentions: string }; threadId?: string };

    expect(body.content).toBe(
      '<p>hi <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">User One</span>' +
        ' and <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="1">User Three</span>, see this</p>',
    );
    // properties.mentions is a JSON-encoded STRING on the wire, not an object.
    expect(typeof body.properties.mentions).toBe("string");
    expect(JSON.parse(body.properties.mentions)).toEqual([
      {
        "@type": "http://schema.skype.com/Mention",
        itemid: 0,
        mri: ME,
        mentionType: "person",
        displayName: "User One",
      },
      {
        "@type": "http://schema.skype.com/Mention",
        itemid: 1,
        mri: THIRD,
        mentionType: "person",
        displayName: "User Three",
      },
    ]);
    // threadId is a URL param, not a body field.
    expect(body.threadId).toBeUndefined();
    expect(body.clientmessageid).toBe("123");
  });

  test("prepends spans inside the leading <p> when the content has no @name to replace", async () => {
    const body = (await runJq(
      input("send_message"),
      inputDoc("send_message", { threadId: "48:notes", content: "<p>look</p>", mention: `${THIRD}=User Three` }),
    )) as { content: string };
    expect(body.content).toBe(
      '<p><span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">User Three</span> look</p>',
    );
  });

  test("an mri with no display name falls back to the mri", async () => {
    const body = (await runJq(
      input("send_message"),
      inputDoc("send_message", { threadId: "48:notes", content: "<p>x</p>", mention: THIRD }),
    )) as { properties: { mentions: string } };
    expect(JSON.parse(body.properties.mentions)[0]).toMatchObject({ mri: THIRD, displayName: THIRD });
  });

  test("--mentions passes a raw JSON-encoded string through and overrides --mention", async () => {
    const raw = '[{"itemid":7}]';
    const body = (await runJq(
      input("send_message"),
      inputDoc("send_message", { threadId: "48:notes", content: "<p>x</p>", mention: THIRD, mentions: raw }),
    )) as { properties: { mentions: string }; content: string };
    expect(body.properties.mentions).toBe(raw);
    // the span is still woven, so a caller-supplied itemid can be matched
    expect(body.content).toContain("schema.skype.com/Mention");
  });

  test("--reply-to emits the Reply blockquote plus properties.qtdMsgs", async () => {
    const body = (await runJq(
      input("send_message"),
      inputDoc("send_message", {
        threadId: "48:notes",
        content: "<p>replying</p>",
        replyTo: 1700000000400,
        replyToMri: OTHER,
        replyToName: "User Two",
        replyToPreview: "earlier line",
      }),
    )) as { content: string; properties: { qtdMsgs: unknown[]; hasValidMsgReferences: boolean } };

    expect(body.content).toBe(`${replyBlockquote(OTHER, "User Two", "earlier line")}\n<p>replying</p>`);
    // messageId/time are NUMBERS in qtdMsgs, unlike the string `id` in the feed.
    expect(body.properties.qtdMsgs).toEqual([
      {
        messageId: 1700000000400,
        sender: OTHER,
        time: 1700000000400,
        message: null,
        validationResult: "Valid",
        sharedRefId: null,
        replyChainId: null,
      },
    ]);
    expect(body.properties.hasValidMsgReferences).toBe(true);
  });

  test("--reply-to defaults the quoted sender to the captured me_mri", async () => {
    const body = (await runJq(
      input("send_message"),
      inputDoc("send_message", { threadId: "48:notes", content: "<p>x</p>", replyTo: "1700000000400" }, { me_mri: ME }),
    )) as { content: string; properties: { qtdMsgs: { sender: string }[] } };
    expect(body.content).toContain(`itemid="${ME}"`);
    expect(body.properties.qtdMsgs[0].sender).toBe(ME);
  });

  test("--quote-mode blockquote omits properties.qtdMsgs", async () => {
    const body = (await runJq(
      input("send_message"),
      inputDoc("send_message", {
        threadId: "48:notes",
        content: "<p>x</p>",
        replyTo: "1700000000400",
        quoteMode: "blockquote",
      }),
    )) as { content: string; properties?: Record<string, unknown> };
    expect(body.content).toContain("schema.skype.com/Reply");
    expect(body.properties?.qtdMsgs).toBeUndefined();
  });

  test("a plain send carries only the default body plus a generated clientmessageid", async () => {
    const body = (await runJq(
      input("send_message"),
      inputDoc("send_message", { threadId: "48:notes", content: "<p>x</p>" }),
    )) as Record<string, unknown>;
    expect(body).toMatchObject({ messagetype: "RichText/Html", contenttype: "text", content: "<p>x</p>" });
    expect(body.properties).toBeUndefined();
    expect(typeof body.clientmessageid).toBe("string");
    expect(body.clientmessageid as string).toMatch(/^\d+$/);
  });
});

describe.skipIf(!hasJq)("teams seed — send_message jq_output", () => {
  test("OriginalArrivalTime is the message id", async () => {
    const result = await runJq(
      output("send_message"),
      { OriginalArrivalTime: 1700000000400 },
      { vars: {}, params: {} },
    );
    expect(result).toEqual({ id: "1700000000400", at: "2023-11-14T22:13:20.400Z" });
  });
});

describe.skipIf(!hasJq)("teams seed — list_threads / list_updates jq_output", () => {
  test("list_threads names every chat, channel and team", async () => {
    const result = (await runJq(output("list_threads"), updatesFixture, { vars: {}, params: {} })) as {
      chats: Record<string, unknown>[];
      channels: Record<string, unknown>[];
      teams: Record<string, unknown>[];
    };
    expect(result.chats[0]).toEqual({
      threadId: "19:00000000000000000000000000000000@thread.v2",
      title: "Synthetic Thread",
      type: "meeting",
      oneOnOne: false,
      external: false,
      memberCount: 2,
      members: [ME, OTHER],
    });
    expect(result.channels[0]).toEqual({
      threadId: "19:11111111111111111111111111111111@thread.tacv2",
      displayName: "General",
      team: "19:22222222222222222222222222222222@thread.tacv2",
      memberCount: 5,
    });
    expect(result.teams[0]).toMatchObject({ displayName: "Synthetic Team" });
  });

  test("list_updates triages unread items and surfaces the next syncToken", async () => {
    const result = (await runJq(output("list_updates"), updatesFixture, { vars: {}, params: {} })) as {
      counts: Record<string, number>;
      syncToken: string;
      unreadChats: Record<string, unknown>[];
      unreadChannels: Record<string, unknown>[];
    };
    expect(result.counts).toEqual({ unreadChats: 1, unreadChannels: 1, chatsInWindow: 1, channelsInWindow: 1 });
    expect(result.syncToken).toBe("synthetic-sync-token");
    expect(result.unreadChats[0]).toMatchObject({
      title: "Synthetic Thread",
      from: "User Two",
      preview: " preview text ",
    });
    expect(result.unreadChannels[0]).toMatchObject({ channel: "General" });
  });
});

describe.skipIf(!hasJq)("teams seed — user_fetch", () => {
  test("jq_input posts a bare array of MRI strings", async () => {
    const body = await runJq(input("user_fetch"), inputDoc("user_fetch", { mri: `${ME}, ${OTHER}` }));
    expect(body).toEqual([ME, OTHER]);
  });

  test("jq_input defaults to the captured me_mri", async () => {
    const body = await runJq(input("user_fetch"), inputDoc("user_fetch", {}, { me_mri: ME }));
    expect(body).toEqual([ME]);
  });

  test("jq_output flattens the IUserIdentity envelope", async () => {
    const result = await runJq(
      output("user_fetch"),
      {
        type: "Microsoft.SkypeSpaces.MiddleTier.Models.User",
        value: [
          {
            mri: ME,
            objectId: "00000000-0000-0000-0000-00000000000a",
            displayName: "User One",
            email: "user.one@example.com",
            userPrincipalName: "user.one@example.com",
            jobTitle: "Engineer",
            department: "Eng",
            companyName: "Example",
            userLocation: "Remote",
            userType: "NonGuest",
            isShortProfile: false,
          },
        ],
      },
      { vars: {}, params: {} },
    );
    expect(result).toEqual([
      {
        mri: ME,
        objectId: "00000000-0000-0000-0000-00000000000a",
        name: "User One",
        email: "user.one@example.com",
        upn: "user.one@example.com",
        jobTitle: "Engineer",
        department: "Eng",
        companyName: "Example",
        location: "Remote",
        userType: "NonGuest",
        shortProfile: false,
      },
    ]);
  });
});

describe.skipIf(!hasJq)("teams seed — every jq_output survives a non-object body", () => {
  // A 4xx from the csa/chatsvc proxy arrives as an empty or HTML string body
  // (proxy.ts returns unparseable bodies verbatim), and a jq_output that indexes
  // it blindly replaces the HTTP status with an opaque "jq exited 5" error.
  for (const [name, call] of Object.entries(catalog)) {
    if (!call.jq_output) continue;
    test(`${name} reports the body instead of throwing`, async () => {
      expect(await runJq(call.jq_output as string, "", { vars: {}, params: {} })).toEqual({ error: "" });
      expect(await runJq(call.jq_output as string, "<html>401</html>", { vars: {}, params: {} })).toEqual({
        error: "<html>401</html>",
      });
    });
  }
});

describe.skipIf(!hasJq)("teams seed — captureVars", () => {
  function spec(name: string): CaptureVarSpec {
    const found = captureVars.find((s) => s.name === name);
    if (!found) throw new Error(`teams config declares no captureVar '${name}'`);
    return found;
  }

  /** The normalized document capture.ts evaluates a spec against (CaptureSample). */
  function sample(over: Partial<Record<string, unknown>>) {
    return {
      file: "f.json",
      url: "https://teams.cloud.microsoft/api/chatsvc/amer/v1/users/ME/conversations/48:notes/messages",
      method: "GET",
      status: 200,
      requestHeaders: {},
      requestBody: null,
      responseHeaders: {},
      responseBody: null,
      ...over,
    };
  }

  function jwt(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${b64({ alg: "RS256" })}.${b64(payload)}.signature`;
  }

  test("updatesSyncToken reads .metadata.syncToken off an updates response", async () => {
    const out = await bunJqRunner(
      spec("updatesSyncToken").jq,
      JSON.stringify(sample({ responseBody: { metadata: { syncToken: "synthetic-sync-token" } } })),
    );
    expect(JSON.parse(out)).toBe("synthetic-sync-token");
    expect(spec("updatesSyncToken").urlMatch).toBeTruthy();
  });

  test("updatesSyncToken misses (empty output) when the response carries no token", async () => {
    const out = await bunJqRunner(spec("updatesSyncToken").jq, JSON.stringify(sample({ responseBody: { chats: [] } })));
    expect(out.trim()).toBe("");
  });

  test("me_mri prefers the x-ms-object-id request header", async () => {
    const out = await bunJqRunner(
      spec("me_mri").jq,
      JSON.stringify(sample({ requestHeaders: { "x-ms-object-id": "00000000-0000-0000-0000-00000000000a" } })),
    );
    expect(JSON.parse(out)).toBe(ME);
  });

  test("me_mri falls back to the Bearer JWT oid claim", async () => {
    const token = jwt({ aud: "https://ic3.teams.office.com", oid: "00000000-0000-0000-0000-00000000000a" });
    const out = await bunJqRunner(
      spec("me_mri").jq,
      JSON.stringify(sample({ requestHeaders: { authorization: `Bearer ${token}` } })),
    );
    expect(JSON.parse(out)).toBe(ME);
  });

  test("me_mri misses rather than throwing on a non-JWT or absent authorization", async () => {
    for (const headers of [{}, { authorization: "Bearer notajwt" }, { authorization: "Basic abc" }]) {
      const out = await bunJqRunner(spec("me_mri").jq, JSON.stringify(sample({ requestHeaders: headers })));
      expect(out.trim()).toBe("");
    }
  });

  test("me_mri rejects an oid that is not a guid", async () => {
    const out = await bunJqRunner(
      spec("me_mri").jq,
      JSON.stringify(sample({ requestHeaders: { authorization: `Bearer ${jwt({ oid: "short" })}` } })),
    );
    expect(out.trim()).toBe("");
  });
});

describe("teams seed — catalog invariants", () => {
  test("every api/csa call declares the chatsvcagg audience hint", () => {
    for (const [name, call] of Object.entries(catalog)) {
      if (!call.url.includes("/api/csa/")) continue;
      expect(call.audHints, `${name} audHints`).toContain("chatsvcagg.teams.microsoft.com");
    }
  });

  test("list_updates takes its sync token from a captured var, never a baked-in value", () => {
    expect(catalog.list_updates.headers?.["x-ms-synctoken"]).toBe("${updatesSyncToken}");
    expect(captureVars.map((s) => s.name)).toContain("updatesSyncToken");
  });

  test("no catalog value embeds an account identity", () => {
    const text = JSON.stringify(catalog);
    // Every MRI the seed mentions must be a doc placeholder ("8:orgid:<guid>") or an
    // all-zero synthetic id — a captured one would pin the seed to one tenant's user.
    // A doc placeholder ("8:orgid:<guid>") or an all-zero synthetic id is fine; any
    // MRI carrying a non-zero hex digit would be a captured one.
    expect(text).not.toMatch(/8:orgid:(?!<)[0-]*[1-9a-f]/);
  });
});

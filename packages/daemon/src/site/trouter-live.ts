/**
 * Live wiring for the Trouter watcher inside the `_site` worker.
 *
 * This is the thin, network-touching adapter layer that constructs a
 * {@link TrouterWatcher} (the pure, unit-tested core) with real dependencies:
 *   - the Bun built-in `WebSocket` for the Trouter socket,
 *   - `proxyCall` + the site's `CredentialVault` for the registrar POST/DELETE
 *     and the REST gap-fill (the ic3 bearer never leaves the worker),
 *   - the daemon event bus via the `publishEvent` IPC (like the vfs producer),
 *   - the mcx.db watch cursor via the `siteWatchCursor{Get,Set}` IPC methods.
 *
 * None of this is exercised by unit tests (which drive the core with fakes); it
 * is the code path the one out-of-band live check runs. `--dry-run` /
 * `dryRun: true` stops before any socket open or registrar POST.
 */

import { SITE_MESSAGE, ipcCall } from "@mcp-cli/core";
import { loadCatalog } from "./catalog";
import { getSite } from "./config";
import type { CredentialVault } from "./credentials";
import { type ProxyCallResult, proxyCall } from "./proxy";
import { resolve as resolveCall } from "./resolver";
import { loadThreads, watchedThreadIds } from "./threads";
import { type NormalisedSiteMessage, normaliseChatsvcMessage } from "./trouter-normalize";
import { type SocketFactory, type TrouterCredential, TrouterWatcher, type TrouterWatcherDeps } from "./trouter-worker";

const REGISTRAR_URL = "https://teams.cloud.microsoft/registrar/prod/V2/registrations";
const IC3_AUD_HINT = "ic3.teams.office.com";
/**
 * Env override for the initial Trouter pool host (e.g.
 * `pub-ent-usea2-10-t.trouter.teams.microsoft.com`). The pool is dynamic and the
 * authoritative surl comes from `trouter.connected`, but the first socket still
 * needs a `-t` host to dial. The out-of-band live check sets this.
 */
const POOL_HOST_ENV = "MCX_TEAMS_TROUTER_HOST";

/** Bun-WebSocket-backed socket factory. */
const liveSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (ev: MessageEvent) => {
    handlers.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
  });
  ws.addEventListener("close", (ev: CloseEvent) => handlers.onClose(ev.reason || "close"));
  ws.addEventListener("error", (ev) => handlers.onError(ev));
  return {
    send: (frame) => ws.send(frame),
    close: () => ws.close(),
  };
};

function credentialProviderFor(vault: CredentialVault, site: string): () => Promise<TrouterCredential | null> {
  return async () => {
    const cred = vault.pickCredentialFor(REGISTRAR_URL, "POST", [IC3_AUD_HINT], site);
    if (!cred) return null;
    const oid = typeof cred.claims.oid === "string" ? cred.claims.oid : undefined;
    return { bearer: cred.bearer, mri: oid ? `8:orgid:${oid}` : undefined };
  };
}

function registrarFor(vault: CredentialVault, site: string): TrouterWatcherDeps["registrar"] {
  return {
    register: async ({ surl, registrationId }) => {
      const body = JSON.stringify({
        clientDescription: {
          appId: "TeamsCDLWebWorker",
          templateKey: "TeamsCDLWebWorker_2.6",
          platform: "chrome",
          languageId: "en-US",
          platformUIVersion: "1415/26080200620",
          aesKey: "",
        },
        registrationId,
        nodeId: "",
        transports: { TROUTER: [{ context: "", path: surl, ttl: 3600 }] },
      });
      const res = await proxyCall(vault, {
        site,
        resolved: {
          url: REGISTRAR_URL,
          method: "POST",
          body,
          headers: { "content-type": "application/json" },
          consumedParams: [],
          residualParams: [],
        },
        audHints: [IC3_AUD_HINT],
      });
      return { status: res.status };
    },
    deregister: async ({ registrationId }) => {
      const res = await proxyCall(vault, {
        site,
        resolved: {
          url: `${REGISTRAR_URL}/${encodeURIComponent(registrationId)}`,
          method: "DELETE",
          headers: {},
          consumedParams: [],
          residualParams: [],
        },
        audHints: [IC3_AUD_HINT],
      });
      return { status: res.status };
    },
  };
}

/** Our own MRI, derived from the ic3 credential's `oid` claim. */
function selfMri(vault: CredentialVault, site: string): string | undefined {
  const cred = vault.pickCredentialFor(REGISTRAR_URL, "POST", [IC3_AUD_HINT], site);
  const oid = cred && typeof cred.claims.oid === "string" ? cred.claims.oid : undefined;
  return oid ? `8:orgid:${oid}` : undefined;
}

/**
 * REST backfill for one thread from `sinceVersion` (epoch-ms string, inclusive)
 * via the site's `get_messages` call, which returns the raw chatsvc `messages[]`.
 * Shared by the watcher's reconnect gap-fill and the `site_backfill` tool
 * (`mcx watch --since`).
 */
export async function backfillThread(
  vault: CredentialVault,
  site: string,
  thread: string,
  sinceVersion: string,
): Promise<NormalisedSiteMessage[]> {
  const cfg = getSite(site);
  if (!cfg) return [];
  const catalog = loadCatalog(site, cfg.seed ?? site);
  const call = catalog.get_messages;
  if (!call) return [];
  const resolved = resolveCall(call, { threadId: thread, startTime: sinceVersion, pageSize: 50 });
  let res: ProxyCallResult;
  try {
    res = await proxyCall(vault, { site, resolved, audHints: call.audHints });
  } catch {
    return [];
  }
  const body = res.body as { messages?: unknown[] } | null;
  const rows = Array.isArray(body?.messages) ? body.messages : [];
  const mri = selfMri(vault, site);
  const out: NormalisedSiteMessage[] = [];
  for (const row of rows) {
    const rec = normaliseChatsvcMessage(row, site, thread, mri);
    if (rec) out.push(rec);
  }
  // Oldest-first so a consumer sees them in chronological order.
  out.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return out;
}

function gapFillFor(vault: CredentialVault): TrouterWatcherDeps["gapFill"] {
  return (site, thread, sinceVersion) => backfillThread(vault, site, thread, sinceVersion);
}

function buildConnectUrlFor(): TrouterWatcherDeps["buildConnectUrl"] {
  return async ({ epid, corId, conNum }) => {
    const host = process.env[POOL_HOST_ENV];
    if (!host) {
      throw new Error(
        `${POOL_HOST_ENV} is not set — cannot dial the initial Trouter pool host. Set it to a '<pool>-t.trouter.teams.microsoft.com' host for the live check.`,
      );
    }
    const tc = JSON.stringify({ cv: "2026.29.01.1", ua: "TeamsCDL", hr: "", v: "1415/26080200620" });
    const qs = new URLSearchParams({
      tc,
      timeout: "40",
      epid,
      ccid: "",
      cor_id: corId,
      con_num: conNum,
      v: "v4",
      auth: "true",
    });
    return `wss://${host}/v4/c?${qs.toString()}`;
  };
}

/** Manages one {@link TrouterWatcher} per site inside the `_site` worker. */
export class TrouterManager {
  private watchers = new Map<string, TrouterWatcher>();

  constructor(private vault: CredentialVault) {}

  private make(site: string): TrouterWatcher {
    return new TrouterWatcher({
      site,
      socketFactory: liveSocketFactory,
      registrar: registrarFor(this.vault, site),
      credentialProvider: credentialProviderFor(this.vault, site),
      buildConnectUrl: buildConnectUrlFor(),
      publish: (record) => {
        void ipcCall("publishEvent", { src: "site.trouter", event: SITE_MESSAGE, category: "site", extra: record });
      },
      cursor: {
        get: async (s, thread) => (await ipcCall("siteWatchCursorGet", { site: s, thread })).lastVersion,
        set: async (s, thread, v) => {
          await ipcCall("siteWatchCursorSet", { site: s, thread, lastVersion: v });
        },
      },
      gapFill: gapFillFor(this.vault),
      log: (msg) => console.error(msg),
    });
  }

  /** Start (or reuse) the watcher for a site and add threads to its gap-fill set. */
  async ensure(site: string, threads: string[]): Promise<ReturnType<TrouterWatcher["status"]>> {
    let w = this.watchers.get(site);
    if (!w) {
      w = this.make(site);
      this.watchers.set(site, w);
    }
    w.addThreads(threads);
    await w.start();
    return w.status();
  }

  async stop(site: string): Promise<void> {
    const w = this.watchers.get(site);
    if (w) {
      await w.stop();
      this.watchers.delete(site);
    }
  }

  status(site?: string): Array<ReturnType<TrouterWatcher["status"]>> {
    if (site) {
      const w = this.watchers.get(site);
      return w ? [w.status()] : [];
    }
    return [...this.watchers.values()].map((w) => w.status());
  }

  /** At worker boot, auto-start watchers for every site whose threads.yaml has watch:true entries. */
  async bootAutoStart(sites: string[]): Promise<void> {
    for (const site of sites) {
      const ids = watchedThreadIds(loadThreads(site));
      if (ids.length > 0) {
        try {
          await this.ensure(site, ids);
        } catch (err) {
          console.error(`[trouter] boot auto-start failed for ${site}: ${String(err)}`);
        }
      }
    }
  }
}

import type { Domain } from "@mcp-cli/core";
import { canonicalizeDomainPath, ipcCall, resolveDomainForPath } from "@mcp-cli/core";
import { useEffect, useState } from "react";

/**
 * The domain filter behind `S:switch`.
 *
 * Replaces `useScopes`, which read `~/.mcp-cli/scopes/*.json` directly (#3042). Domains
 * live in `mcx.db`, which only the daemon opens, so the list comes over IPC — but the
 * "which one am I in?" walk-up stays local to `resolveDomainForPath`, the single rule
 * `mcx domain which` and the daemon's resolver also use.
 */
export interface UseDomainsResult {
  /** All registered domains. */
  domains: Domain[];
  /** Currently selected domain, or null for "all". */
  selectedDomain: Domain | null;
  /** Switch to a domain, or null for "all". */
  setSelectedDomain: (domain: Domain | null) => void;
  /** Cycle to the next domain: domain1 → domain2 → ... → all → domain1. */
  cycleDomain: () => void;
}

export interface UseDomainsOptions {
  /** Override for testing. */
  ipcCallFn?: typeof ipcCall;
  /** Override for testing. */
  cwd?: () => string;
  /** Poll interval in ms (default: 30000 — domains change rarely). */
  intervalMs?: number;
}

export function useDomains(opts: UseDomainsOptions = {}): UseDomainsResult {
  const { ipcCallFn = ipcCall, cwd = () => process.cwd(), intervalMs = 30_000 } = opts;
  const [domains, setDomains] = useState<Domain[]>([]);
  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      let current: Domain[];
      try {
        current = await ipcCallFn("domainList");
      } catch {
        // No daemon, or a daemon too old to know the method: show no filter rather than
        // taking the whole TUI down over an optional one.
        return;
      }
      if (cancelled) return;
      setDomains(current);

      // Auto-detect on first load
      if (!initialized) {
        setSelectedDomain(detect(current, cwd()));
        setInitialized(true);
      }
    }

    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ipcCallFn, cwd, intervalMs, initialized]);

  function cycleDomain() {
    if (domains.length === 0) return;
    if (selectedDomain === null) {
      setSelectedDomain(domains[0]);
      return;
    }
    const idx = domains.findIndex((d) => d.id === selectedDomain.id);
    if (idx < 0 || idx === domains.length - 1) {
      // After the last domain, go to "all" (null)
      setSelectedDomain(null);
    } else {
      setSelectedDomain(domains[idx + 1]);
    }
  }

  return { domains, selectedDomain, setSelectedDomain, cycleDomain };
}

/**
 * The domain owning `cwd`, or null when it is outside every domain.
 *
 * `resolveDomainForPath` owns the walk-up rule — including skipping host-bound domains —
 * and throws on a non-absolute path. A TUI cannot do anything useful with that throw, so
 * it becomes "no domain selected" rather than a crash on startup.
 */
export function detect(domains: Domain[], cwd: string): Domain | null {
  try {
    return resolveDomainForPath(canonicalizeDomainPath(cwd), domains);
  } catch {
    return null;
  }
}

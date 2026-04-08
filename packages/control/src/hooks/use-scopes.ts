import type { ScopeMatch } from "@mcp-cli/core";
import { detectScope, listScopes } from "@mcp-cli/core";
import { useEffect, useState } from "react";

export interface UseScopesResult {
  /** All registered scopes. */
  scopes: ScopeMatch[];
  /** Currently selected scope, or null for "all". */
  selectedScope: ScopeMatch | null;
  /** Switch to a scope by name, or null for "all". */
  setSelectedScope: (scope: ScopeMatch | null) => void;
  /** Cycle to the next scope: scope1 → scope2 → ... → all → scope1. */
  cycleScope: () => void;
}

export interface UseScopesOptions {
  /** Override for testing. */
  listScopesFn?: typeof listScopes;
  /** Override for testing. */
  detectScopeFn?: typeof detectScope;
  /** Poll interval in ms (default: 30000 — scopes change rarely). */
  intervalMs?: number;
}

export function useScopes(opts: UseScopesOptions = {}): UseScopesResult {
  const { listScopesFn = listScopes, detectScopeFn = detectScope, intervalMs = 30_000 } = opts;
  const [scopes, setScopes] = useState<ScopeMatch[]>([]);
  const [selectedScope, setSelectedScope] = useState<ScopeMatch | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function refresh() {
      const current = listScopesFn();
      if (cancelled) return;
      setScopes(current);

      // Auto-detect on first load
      if (!initialized) {
        const detected = detectScopeFn();
        if (detected) {
          // Find matching scope from list (by root)
          const match = current.find((s) => s.root === detected.root) ?? detected;
          setSelectedScope(match);
        }
        setInitialized(true);
      }
    }

    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [listScopesFn, detectScopeFn, intervalMs, initialized]);

  function cycleScope() {
    if (scopes.length === 0) return;
    if (selectedScope === null) {
      setSelectedScope(scopes[0]);
      return;
    }
    const idx = scopes.findIndex((s) => s.root === selectedScope.root);
    if (idx < 0 || idx === scopes.length - 1) {
      // After last scope, go to "all" (null)
      setSelectedScope(null);
    } else {
      setSelectedScope(scopes[idx + 1]);
    }
  }

  return { scopes, selectedScope, setSelectedScope, cycleScope };
}

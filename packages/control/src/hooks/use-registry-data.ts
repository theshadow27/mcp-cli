import { useCallback, useRef, useState } from "react";
import type { RegistryEntry } from "./registry-client.js";
import { listRegistry, searchRegistry } from "./registry-client.js";

const SEARCH_DEBOUNCE_MS = 300;

export interface UseRegistryDataResult {
  entries: RegistryEntry[];
  loading: boolean;
  error: string | null;
  search: (query: string) => void;
  loadPopular: () => void;
}

export interface UseRegistryDataDeps {
  searchRegistry: (query: string, limit?: number) => Promise<{ servers: RegistryEntry[] }>;
  listRegistry: (limit?: number) => Promise<{ servers: RegistryEntry[] }>;
}

export function useRegistryData(deps?: UseRegistryDataDeps): UseRegistryDataResult {
  const searchFn = deps?.searchRegistry ?? searchRegistry;
  const listFn = deps?.listRegistry ?? listRegistry;
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(
    (query: string) => {
      // Cancel any pending debounced search
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const id = ++abortRef.current;
      setLoading(true);
      setError(null);

      debounceRef.current = setTimeout(() => {
        searchFn(query, 50)
          .then((res) => {
            if (abortRef.current === id) {
              setEntries(res.servers);
              setLoading(false);
            }
          })
          .catch((err) => {
            if (abortRef.current === id) {
              setError(err instanceof Error ? err.message : String(err));
              setLoading(false);
            }
          });
      }, SEARCH_DEBOUNCE_MS);
    },
    [searchFn],
  );

  const loadPopular = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const id = ++abortRef.current;
    setLoading(true);
    setError(null);
    listFn(50)
      .then((res) => {
        if (abortRef.current === id) {
          setEntries(res.servers);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (abortRef.current === id) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
  }, [listFn]);

  return { entries, loading, error, search, loadPopular };
}

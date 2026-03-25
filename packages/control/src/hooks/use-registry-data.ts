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

export function useRegistryData(): UseRegistryDataResult {
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback((query: string) => {
    // Cancel any pending debounced search
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const id = ++abortRef.current;
    setLoading(true);
    setError(null);

    debounceRef.current = setTimeout(() => {
      searchRegistry(query, 50)
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
  }, []);

  const loadPopular = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const id = ++abortRef.current;
    setLoading(true);
    setError(null);
    listRegistry(50)
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
  }, []);

  return { entries, loading, error, search, loadPopular };
}

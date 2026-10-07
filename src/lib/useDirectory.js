import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads the entries of `path`, or recursive search results when `search.recursive` and
 * `search.query` are set. Re-loads on live folder changes reported by the main process.
 */
export function useDirectory(path, search) {
  const [state, setState] = useState({ entries: [], loading: true, error: null, truncated: false });
  const [reloadTick, setReloadTick] = useState(0);
  const reqRef = useRef(0);
  const searchIdRef = useRef(0);

  const refresh = useCallback(() => setReloadTick((t) => t + 1), []);

  const recursive = !!(search && search.recursive && search.query && search.query.trim());
  const query = recursive ? search.query.trim() : '';
  const showHidden = !!(search && search.showHidden);

  // Folder listing (always loaded; recursive search replaces entries when active)
  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    const req = ++reqRef.current;
    const api = window.fsApi;

    // Don't blank the view on background refreshes of the same folder.
    setState((s) => ({ ...s, loading: true, error: null }));

    const run = async () => {
      if (recursive) {
        // Debounce typing before walking the tree.
        await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;
        const id = ++searchIdRef.current + Date.now();
        searchIdRef.current = id;
        cancelRef.current = () => api.cancelSearch(id);
        const res = await api.search({ id, root: path, query, showHidden });
        if (cancelled || req !== reqRef.current) return;
        setState({
          entries: res.entries || [],
          loading: false,
          error: res.ok ? null : res.error,
          truncated: !!res.truncated,
        });
      } else {
        const res = await api.listDir(path);
        if (cancelled || req !== reqRef.current) return;
        if (res.ok) setState({ entries: res.entries, loading: false, error: null, truncated: false });
        else setState({ entries: [], loading: false, error: res.error, truncated: false });
      }
    };
    const cancelRef = { current: null };
    run();

    return () => {
      cancelled = true;
      if (cancelRef.current) cancelRef.current();
    };
  }, [path, recursive, query, showHidden, reloadTick]);

  // Live updates
  useEffect(() => {
    if (!path) return undefined;
    const api = window.fsApi;
    api.watch(path);
    const off = api.onChanged(({ dir }) => {
      if (dir === path) refresh();
    });
    return () => {
      off();
      api.unwatch();
    };
  }, [path, refresh]);

  return { ...state, refresh };
}

import { useEffect, useState } from 'react';

/** Free/total bytes for the volume containing `path`; refreshed on a timer. */
export function useDiskSpace(path, tick = 0, intervalMs = 15000) {
  const [space, setSpace] = useState(null);
  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    const load = async () => {
      const r = await window.fsApi.diskSpace(path);
      if (!cancelled) setSpace(r && r.ok ? r : null);
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [path, tick, intervalMs]);
  return space;
}

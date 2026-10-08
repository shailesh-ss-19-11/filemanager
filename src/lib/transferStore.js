import { useSyncExternalStore } from 'react';

/**
 * Progress entries live outside React state so a progress tick re-renders only the progress panel,
 * not the whole app and its thousands of file rows.
 */
let items = [];
const subs = new Set();
const emit = () => subs.forEach((f) => f());

export const transferStore = {
  add(entry) {
    items = [...items, entry];
    emit();
  },
  remove(id) {
    if (!items.some((t) => t.id === id)) return;
    items = items.filter((t) => t.id !== id);
    emit();
  },
  update(m) {
    if (m.state !== 'running' || !items.some((t) => t.id === m.id)) return;
    items = items.map((t) =>
      t.id === m.id
        ? { ...t, label: m.label || t.label, unit: m.unit, sub: m.sub, current: m.current, done: m.done, total: m.total, items: m.items, elapsed: m.elapsed }
        : t
    );
    emit();
  },
  subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  getSnapshot: () => items,
};

export const useTransfers = () => useSyncExternalStore(transferStore.subscribe, transferStore.getSnapshot);

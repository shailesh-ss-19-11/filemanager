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
  /** Keep the entry on screen, flagged as interrupted, with what is needed to resume it. */
  interrupt(id, resume, done, total) {
    items = items.map((t) => (t.id === id ? { ...t, interrupted: true, resume, done, total } : t));
    emit();
  },
  restart(id) {
    items = items.map((t) => (t.id === id ? { ...t, interrupted: false } : t));
    emit();
  },
  get(id) {
    return items.find((t) => t.id === id);
  },
  update(m) {
    if (m.state !== 'running' || !items.some((t) => t.id === m.id)) return;
    items = items.map((t) =>
      t.id === m.id
        ? { ...t, interrupted: false, label: m.label || t.label, unit: m.unit, sub: m.sub, current: m.current, done: m.done, total: m.total, items: m.items, elapsed: m.elapsed }
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

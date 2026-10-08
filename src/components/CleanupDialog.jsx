import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Trash2, X } from 'lucide-react';
import { KINDS, formatDate, formatSize, getKind, isMac, plural } from '../lib/fileUtils.js';

const MB = 1024 * 1024;
const MIN_SIZES = [
  { v: 100 * MB, label: '100 MB+' },
  { v: 250 * MB, label: '250 MB+' },
  { v: 500 * MB, label: '500 MB+' },
  { v: 1024 * MB, label: '1 GB+' },
  { v: 4096 * MB, label: '4 GB+' },
];
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const kindOf = (f) => getKind({ isDir: false, extension: extOf(f.name) });

const TABS = [
  { key: 'large', label: 'Large files' },
  { key: 'duplicates', label: 'Duplicates' },
  { key: 'installers', label: 'Installers' },
  { key: 'old', label: 'Old files' },
  { key: 'caches', label: 'Caches' },
];

export default function CleanupDialog({ scopes, onClose, onToast }) {
  const api = window.fsApi;
  const [state, setState] = useState({ loading: true });
  const [tab, setTab] = useState('large');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState('all');
  const [minSize, setMinSize] = useState(MIN_SIZES[0].v);
  const [root, setRoot] = useState(scopes[0].path);
  const [caches, setCaches] = useState(null); // null = not loaded, [] = none

  const scan = async () => {
    setState({ loading: true });
    setPicked(new Set());
    const r = await api.cleanScan(root);
    setState(r.ok ? { data: r } : { error: r.error });
  };
  const loadCaches = async () => {
    const r = await api.cacheScan();
    setCaches(r.ok ? r.caches : []);
  };
  useEffect(() => {
    if (tab === 'caches' && caches === null) loadCaches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = state.data;
  const rows = useMemo(() => {
    if (tab === 'caches') return (caches || []).map((f) => ({ ...f, group: null }));
    if (!data) return [];
    if (tab === 'large') {
      return data.large
        .filter((f) => f.size >= minSize && (kind === 'all' || kindOf(f) === kind))
        .map((f) => ({ ...f, group: null }));
    }
    if (tab === 'caches') return (caches || []).map((f) => ({ ...f, group: null }));
    if (tab !== 'duplicates') return data[tab].map((f) => ({ ...f, group: null }));
    // Within each duplicate set, the oldest copy is kept; the rest are listed.
    return data.duplicates.flatMap((g, gi) =>
      [...g.files].sort((a, b) => a.mtime - b.mtime).map((f, i) => ({ ...f, group: gi, keep: i === 0 }))
    );
  }, [data, tab, kind, minSize, caches]);

  const kindCounts = useMemo(() => {
    const c = {};
    (data ? data.large : []).forEach((f) => {
      if (f.size < minSize) return;
      const k = kindOf(f);
      c[k] = (c[k] || 0) + 1;
    });
    return c;
  }, [data, minSize]);

  const total = useMemo(() => {
    if (!data) return 0;
    const all = new Map();
    [...data.large, ...data.installers, ...data.old, ...(caches || []), ...data.duplicates.flatMap((g) => g.files)].forEach((f) => all.set(f.path, f.size));
    return [...picked].reduce((n, p) => n + (all.get(p) || 0), 0);
  }, [data, picked, caches]);

  const toggle = (p) =>
    setPicked((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const selectDuplicateExtras = () =>
    setPicked((s) => {
      const n = new Set(s);
      rows.forEach((r) => !r.keep && n.add(r.path));
      return n;
    });

  const selectAllShown = () => setPicked(new Set(rows.map((r) => r.path)));

  const remove = async (paths) => {
    if (!paths.length || busy) return;
    setBusy(true);
    const r = await api.trash(paths);
    r.errors.forEach((m) => onToast(m));
    setBusy(false);
    onToast(`Moved ${plural(paths.length - r.errors.length, 'file')} to the ${isMac ? 'Trash' : 'Recycle Bin'}.`, 'info');
    scan();
  };
  const clean = () => remove([...picked]);
  const cleanRef = useRef(clean);
  cleanRef.current = clean;

  // ⌘⌫ (macOS) / Delete (Windows) moves the checked files to the Trash
  useEffect(() => {
    const onKey = (e) => {
      if ((isMac ? e.metaKey && e.key === 'Backspace' : e.key === 'Delete') && !e.target.closest?.('select')) {
        e.preventDefault();
        cleanRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cleanup" role="dialog" aria-label="Clean up storage">
        <header className="modal-head">
          <Sparkles size={18} />
          <h2>Clean up</h2>
          <select className="scope-select" value={root} onChange={(e) => setRoot(e.target.value)} aria-label="Where to scan">
            {scopes.map((s) => (
              <option key={s.path} value={s.path}>{s.label}</option>
            ))}
          </select>
          <span className="modal-sub" title={root}>{root}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="cleanup-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
              {t.label}{t.key === 'caches' ? (caches ? ` (${caches.length})` : '') : data ? ` (${data[t.key].length})` : ''}
            </button>
          ))}
        </div>
        <div className="cleanup-body">
          {tab === 'large' && data && (
            <div className="cleanup-filters">
              <select value={minSize} onChange={(e) => setMinSize(Number(e.target.value))} aria-label="Minimum size">
                {MIN_SIZES.map((m) => (
                  <option key={m.v} value={m.v}>{m.label}</option>
                ))}
              </select>
              {[{ id: 'all', label: 'All types' }, ...KINDS.filter((k) => kindCounts[k.id])].map((k) => (
                <button key={k.id} className={`chip${kind === k.id ? ' active' : ''}`} onClick={() => setKind(k.id)}>
                  {k.label}{k.id !== 'all' ? ` (${kindCounts[k.id]})` : ''}
                </button>
              ))}
            </div>
          )}
          {tab === 'caches' && caches === null && <div className="cleanup-empty">Measuring cache folders…</div>}
          {tab === 'old' && data && <div className="cleanup-note">Files over 10 MB that haven’t been modified or opened in over a year.</div>}
          {tab === 'caches' && caches && <div className="cleanup-note">Temporary data apps rebuild on demand. Safe to remove; apps may start a bit slower once.</div>}
          {state.loading && <div className="cleanup-empty">Scanning for files you can remove…</div>}
          {state.error && <div className="cleanup-empty">{state.error}</div>}
          {((data && tab !== 'caches') || (tab === 'caches' && caches)) && rows.length === 0 && <div className="cleanup-empty">Nothing to clean here.</div>}
          {rows.length > 0 && (
            <div className="cleanup-actions">
              <button className="link-btn" onClick={selectAllShown}>Select all {rows.length}</button>
              {tab === 'duplicates' && (
                <button className="link-btn" onClick={selectDuplicateExtras}>Select all extra copies</button>
              )}
              {picked.size > 0 && <button className="link-btn" onClick={() => setPicked(new Set())}>Clear</button>}
            </div>
          )}
          {rows.map((r, i) => (
            <label key={r.path} className={`cleanup-row${r.group != null && rows[i - 1]?.group !== r.group ? ' group-start' : ''}`}>
              <input type="checkbox" checked={picked.has(r.path)} onChange={() => toggle(r.path)} />
              <span className="cleanup-name" title={r.path}>
                {r.name}{r.keep ? ' (oldest)' : ''}
                <small>{r.path}</small>
              </span>
              <span className="cleanup-meta">{formatDate(r.mtime)}</span>
              <span className="cleanup-size">{formatSize(r.size)}</span>
              <button
                className="icon-btn small"
                title={`Move to ${isMac ? 'Trash' : 'Recycle Bin'}`}
                aria-label={`Delete ${r.name}`}
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  remove([r.path]);
                }}
              >
                <Trash2 size={14} />
              </button>
            </label>
          ))}
        </div>
        <footer className="modal-foot">
          <span>
            {data && `${data.scanned.toLocaleString()} files scanned${data.truncated ? ' (partial)' : ''}`}
          </span>
          <button className="btn danger" disabled={!picked.size || busy} onClick={clean}>
            {busy ? 'Deleting…' : `Delete selected · ${formatSize(total) || '0 B'}  ${isMac ? '⌘⌫' : 'Del'}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

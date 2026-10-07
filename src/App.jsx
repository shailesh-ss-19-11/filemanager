import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import TabBar, { tabTitle } from './components/TabBar.jsx';
import Toolbar from './components/Toolbar.jsx';
import CommandBar from './components/CommandBar.jsx';
import Sidebar from './components/Sidebar.jsx';
import FilterPanel from './components/FilterPanel.jsx';
import FileView from './components/FileView.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import { useDirectory } from './lib/useDirectory.js';
import {
  applyFilters,
  computeCounts,
  countActiveFilters,
  dirname,
  emptyFilters,
  formatSize,
  groupEntries,
  isMac,
  isRootPath,
  plural,
  samePath,
  sortEntries,
} from './lib/fileUtils.js';

const api = window.fsApi;

let tabSeq = 1;
const makeTab = (path) => ({ id: tabSeq++, history: [path], index: 0, query: '', recursive: false });

function usePersisted(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem('fm:' + key);
      if (!raw) return initial;
      const parsed = JSON.parse(raw);
      return initial && typeof initial === 'object' ? { ...initial, ...parsed } : parsed;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('fm:' + key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue];
}

const isTextTarget = (el) =>
  !!el &&
  (el.tagName === 'TEXTAREA' ||
    el.isContentEditable ||
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(el.type)));

const mod = (key) => (isMac ? `⌘${key}` : `Ctrl+${key}`);

function normalizeTyped(p) {
  let v = p.trim().replace(/^"(.*)"$/, '$1');
  if (/^[A-Za-z]:$/.test(v)) v += '\\';
  return v;
}

export default function App() {
  const [tabs, setTabs] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [quick, setQuick] = useState([]);
  const [drives, setDrives] = useState([]);
  const [home, setHome] = useState('');

  const [view, setView] = usePersisted('view', 'details');
  const [sort, setSort] = usePersisted('sort', { key: 'name', dir: 'asc', foldersFirst: true });
  const [groupBy, setGroupBy] = usePersisted('group', 'none');
  const [filtersOpen, setFiltersOpen] = usePersisted('filtersOpen', false);
  const [filters, setFilters] = useState(emptyFilters);

  const [selection, setSelection] = useState(() => new Set());
  const [focusPath, setFocusPath] = useState(null);
  const [clipboard, setClipboard] = useState(null); // { paths, mode }
  const [renamingPath, setRenamingPath] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [addressTick, setAddressTick] = useState(0);
  const [findTick, setFindTick] = useState(0);

  const anchorRef = useRef(null);
  const colsRef = useRef(1);
  const pendingRef = useRef(null);
  const tabsRef = useRef(null);
  const activeRef = useRef(null);
  tabsRef.current = tabs;
  activeRef.current = activeId;

  /* ------------------------------ bootstrap ----------------------------- */

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    (async () => {
      const q = await api.quickAccess();
      if (cancelled) return;
      setQuick(q);
      const h = (q.find((x) => x.key === 'home') || q[0] || { path: '/' }).path;
      setHome(h);
      const initial = new URLSearchParams(window.location.search).get('path') || h;
      const t = makeTab(initial);
      setTabs([t]);
      setActiveId(t.id);
      off = api.onDrivesChanged(setDrives);
      const d = await api.drives();
      if (!cancelled) setDrives(d);
    })();
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  /* ------------------------------ derived ------------------------------- */

  const tab = tabs && tabs.find((t) => t.id === activeId);
  const path = tab ? tab.history[tab.index] : null;
  const query = tab ? tab.query : '';
  const recursive = tab ? tab.recursive : false;

  const dir = useDirectory(path, { query, recursive, showHidden: filters.showHidden });
  const { refresh } = dir;

  const activeCount = countActiveFilters(filters);

  const sorted = useMemo(
    () => sortEntries(applyFilters(dir.entries, filters, query), sort),
    [dir.entries, filters, query, sort]
  );
  const groups = useMemo(
    () => groupEntries(sorted, groupBy, filters.dateField, sort.dir),
    [sorted, groupBy, filters.dateField, sort.dir]
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const counts = useMemo(() => computeCounts(dir.entries, filters, query), [dir.entries, filters, query]);
  const totalVisible = useMemo(
    () => (filters.showHidden ? dir.entries.length : dir.entries.filter((e) => !e.hidden).length),
    [dir.entries, filters.showHidden]
  );
  const selected = useMemo(() => flat.filter((e) => selection.has(e.path)), [flat, selection]);
  const cutSet = useMemo(
    () => (clipboard && clipboard.mode === 'cut' ? new Set(clipboard.paths) : new Set()),
    [clipboard]
  );

  const flatRef = useRef(flat);
  const selectionRef = useRef(selection);
  const focusRef = useRef(focusPath);
  flatRef.current = flat;
  selectionRef.current = selection;
  focusRef.current = focusPath;

  /* ---------------------------- housekeeping ---------------------------- */

  // New folder: reset per-folder filters, selection, rename.
  useEffect(() => {
    setFilters((f) => ({ ...emptyFilters(), showHidden: f.showHidden, dateField: f.dateField }));
    setSelection(new Set());
    setFocusPath(null);
    setRenamingPath(null);
    anchorRef.current = null;
  }, [path, activeId]);

  useEffect(() => {
    if (path) document.title = `${tabTitle(path)} — File Manager`;
  }, [path]);

  // After a reload: drop vanished selections and apply any pending selection (paste, new folder, rename).
  useEffect(() => {
    const present = new Set(dir.entries.map((e) => e.path));
    setSelection((prev) => {
      const next = new Set([...prev].filter((p) => present.has(p)));
      return next.size === prev.size ? prev : next;
    });
    setRenamingPath((r) => (r && !present.has(r) ? null : r));
    const pending = pendingRef.current;
    if (pending) {
      const found = pending.paths.filter((p) => present.has(p));
      if (found.length) {
        pendingRef.current = null;
        setSelection(new Set(found));
        setFocusPath(found[0]);
        anchorRef.current = found[0];
        if (pending.rename) setRenamingPath(found[0]);
      }
    }
  }, [dir.entries]);

  /* ------------------------------- toasts ------------------------------- */

  const toast = useCallback((message, type = 'error') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 6000 : 5000);
  }, []);

  /* ------------------------------- tabs --------------------------------- */

  const updateTab = useCallback((id, fn) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
  }, []);

  const navigate = useCallback(
    (target) => {
      const p = normalizeTyped(target);
      if (!p) return;
      updateTab(activeRef.current, (t) => {
        const cur = t.history[t.index];
        if (samePath(cur, p)) return { ...t, query: '' };
        return { ...t, history: [...t.history.slice(0, t.index + 1), p], index: t.index + 1, query: '' };
      });
    },
    [updateTab]
  );

  const go = useCallback(
    (delta) => {
      updateTab(activeRef.current, (t) => {
        const i = t.index + delta;
        if (i < 0 || i >= t.history.length) return t;
        return { ...t, index: i, query: '' };
      });
    },
    [updateTab]
  );

  const goUp = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeRef.current);
    const cur = t.history[t.index];
    if (!isRootPath(cur)) navigate(dirname(cur));
  }, [navigate]);

  const openTab = useCallback((p, activate = true) => {
    const t = makeTab(p);
    setTabs((ts) => [...ts, t]);
    if (activate) setActiveId(t.id);
  }, []);

  const closeTab = useCallback((id) => {
    const ts = tabsRef.current;
    if (ts.length === 1) {
      window.close();
      return;
    }
    const i = ts.findIndex((t) => t.id === id);
    const next = ts.filter((t) => t.id !== id);
    setTabs(next);
    if (id === activeRef.current) setActiveId(next[Math.min(i, next.length - 1)].id);
  }, []);

  const cycleTab = useCallback((d) => {
    const ts = tabsRef.current;
    const i = ts.findIndex((t) => t.id === activeRef.current);
    setActiveId(ts[(i + d + ts.length) % ts.length].id);
  }, []);

  /* ----------------------------- selection ------------------------------ */

  const selectRange = (from, to) => {
    const f = flatRef.current;
    const a = f.findIndex((e) => e.path === from);
    const b = f.findIndex((e) => e.path === to);
    if (a < 0 || b < 0) return new Set([to]);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return new Set(f.slice(lo, hi + 1).map((e) => e.path));
  };

  const onSelect = useCallback((entry, e) => {
    const m = isMac ? e.metaKey : e.ctrlKey;
    setFocusPath(entry.path);
    if (e.shiftKey && anchorRef.current) {
      setSelection(selectRange(anchorRef.current, entry.path));
    } else if (m) {
      setSelection((prev) => {
        const n = new Set(prev);
        if (n.has(entry.path)) n.delete(entry.path);
        else n.add(entry.path);
        return n;
      });
      anchorRef.current = entry.path;
    } else {
      setSelection(new Set([entry.path]));
      anchorRef.current = entry.path;
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    anchorRef.current = null;
  }, []);

  const selectAll = useCallback(() => {
    setSelection(new Set(flatRef.current.map((e) => e.path)));
  }, []);

  const moveFocus = (delta, extend) => {
    const f = flatRef.current;
    if (!f.length) return;
    const cur = focusRef.current ? f.findIndex((e) => e.path === focusRef.current) : -1;
    let next;
    if (cur < 0) next = delta > 0 ? 0 : f.length - 1;
    else next = Math.max(0, Math.min(f.length - 1, cur + delta));
    const p = f[next].path;
    setFocusPath(p);
    if (extend) {
      const anchor = anchorRef.current || f[Math.max(cur, 0)].path;
      anchorRef.current = anchor;
      setSelection(selectRange(anchor, p));
    } else {
      setSelection(new Set([p]));
      anchorRef.current = p;
    }
  };

  /* ------------------------------ actions ------------------------------- */

  const openEntries = (list) => {
    if (!list.length) return;
    const dirs = list.filter((e) => e.isDir);
    const files = list.filter((e) => !e.isDir);
    if (dirs.length === 1 && files.length === 0) navigate(dirs[0].path);
    else dirs.forEach((d) => openTab(d.path, false));
    if (files.length) {
      api.open(files.map((f) => f.path)).then((r) => {
        if (!r.ok) toast(r.error || 'Could not open the file.');
      });
    }
  };

  const doCopy = (list = selected) => {
    if (list.length) setClipboard({ paths: list.map((e) => e.path), mode: 'copy' });
  };
  const doCut = (list = selected) => {
    if (list.length) setClipboard({ paths: list.map((e) => e.path), mode: 'cut' });
  };

  const doPaste = async (dest = path) => {
    if (!clipboard || !clipboard.paths.length) return;
    const r = await api.paste(clipboard.paths, dest, clipboard.mode);
    r.errors.forEach((m) => toast(m));
    if (clipboard.mode === 'cut' && r.pasted.length) setClipboard(null);
    if (samePath(dest, path) && r.pasted.length) pendingRef.current = { paths: r.pasted };
    refresh();
  };

  const doNewFolder = async () => {
    const r = await api.newFolder(path);
    if (!r.ok) return toast(r.error);
    pendingRef.current = { paths: [r.path], rename: true };
    refresh();
  };

  const startRename = () => {
    if (selected.length === 1) setRenamingPath(selected[0].path);
  };

  const commitRename = useCallback(
    async (entry, newName) => {
      setRenamingPath(null);
      if (newName === entry.name) return;
      const r = await api.rename(entry.path, newName);
      if (!r.ok) return toast(r.error);
      pendingRef.current = { paths: [r.path] };
      refresh();
    },
    [refresh, toast]
  );
  const cancelRename = useCallback(() => setRenamingPath(null), []);

  const doTrash = async () => {
    if (!selected.length) return;
    const r = await api.trash(selected.map((e) => e.path));
    r.errors.forEach((m) => toast(m));
    clearSelection();
    refresh();
  };

  const folderSize = async (entry) => {
    toast(`Calculating size of “${entry.name}”…`, 'info');
    const r = await api.folderSize(entry.path);
    if (!r.ok) return toast(r.error);
    toast(
      `“${entry.name}”: ${formatSize(r.size)} in ${plural(r.count, 'item')}${r.truncated ? ' (partial — folder is very large)' : ''}`,
      'info'
    );
  };

  const copyPath = (list) => api.copyText(list.map((e) => e.path).join('\n'));
  const toggleHidden = () => setFilters((f) => ({ ...f, showHidden: !f.showHidden }));
  const clearAll = () => {
    setFilters((f) => ({ ...emptyFilters(), showHidden: f.showHidden, dateField: f.dateField }));
    updateTab(activeId, (t) => ({ ...t, query: '' }));
  };

  /* -------------------------- commands & keyboard ----------------------- */

  const act = {
    newTab: () => openTab(home),
    newFolder: doNewFolder,
    open: () => openEntries(selected),
    closeTab: () => closeTab(activeRef.current),
    cut: () => (isTextTarget(document.activeElement) ? api.textEdit('cut') : doCut()),
    copy: () => (isTextTarget(document.activeElement) ? api.textEdit('copy') : doCopy()),
    paste: () => (isTextTarget(document.activeElement) ? api.textEdit('paste') : doPaste()),
    selectAll: () => (isTextTarget(document.activeElement) ? api.textEdit('selectAll') : selectAll()),
    find: () => setFindTick((n) => n + 1),
    viewDetails: () => setView('details'),
    viewIcons: () => setView('icons'),
    toggleFilters: () => setFiltersOpen((o) => !o),
    toggleHidden,
    refresh,
    back: () => go(-1),
    forward: () => go(1),
    up: goUp,
    home: () => navigate(home),
    goToAddress: () => setAddressTick((n) => n + 1),
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    rename: startRename,
    trash: doTrash,
    clear: clearSelection,
    move: moveFocus,
  };
  const actRef = useRef(act);
  actRef.current = act;

  useEffect(() => api.onCommand(({ cmd }) => actRef.current[cmd] && actRef.current[cmd]()), []);

  useEffect(() => {
    const onKey = (e) => {
      if (isTextTarget(e.target)) return;
      const a = actRef.current;
      const m = isMac ? e.metaKey : e.ctrlKey;
      const icons = document.querySelector('.fileview.icons');
      const cols = icons ? colsRef.current : 1;
      let handled = true;

      if (e.key === 'F5') a.refresh();
      else if (e.altKey && isMac && !e.ctrlKey && !e.metaKey && e.key === 'ArrowLeft') a.back();
      else if (e.altKey && isMac && !e.ctrlKey && !e.metaKey && e.key === 'ArrowRight') a.forward();
      else if (e.altKey && isMac && !e.ctrlKey && !e.metaKey && e.key === 'ArrowUp') a.up();
      else if (m || e.altKey) handled = false; // leave menu accelerators alone
      else if (e.key === 'ArrowDown') a.move(icons ? cols : 1, e.shiftKey);
      else if (e.key === 'ArrowUp') a.move(icons ? -cols : -1, e.shiftKey);
      else if (e.key === 'ArrowRight' && icons) a.move(1, e.shiftKey);
      else if (e.key === 'ArrowLeft' && icons) a.move(-1, e.shiftKey);
      else if (e.key === 'Enter') a.open();
      else if (e.key === 'F2') a.rename();
      else if (e.key === 'Delete' && !isMac) a.trash();
      else if (e.key === 'Backspace' && !isMac) a.back();
      else if (e.key === 'Escape') a.clear();
      else handled = false;

      // ⌘⌫ on macOS
      if (!handled && isMac && e.metaKey && e.key === 'Backspace') {
        handled = true;
        a.trash();
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onColsChange = useCallback((n) => {
    colsRef.current = n;
  }, []);

  /* ----------------------------- context menu --------------------------- */

  const onContext = useCallback((e, entry) => {
    e.preventDefault();
    e.stopPropagation();
    if (entry) {
      if (!selectionRef.current.has(entry.path)) {
        setSelection(new Set([entry.path]));
        anchorRef.current = entry.path;
      }
      setFocusPath(entry.path);
    } else {
      clearSelection();
    }
    setCtx({ x: e.clientX, y: e.clientY, item: !!entry });
  }, [clearSelection]);

  const fm = isMac ? 'Finder' : 'Explorer';

  const tidy = (items) =>
    items
      .filter(Boolean)
      .filter((it, i, arr) => !(it.separator && (i === 0 || i === arr.length - 1 || arr[i - 1].separator)));

  const menuItems = () => {
    if (!ctx) return [];
    if (ctx.item && selected.length) {
      const sel = selected;
      const single = sel.length === 1 ? sel[0] : null;
      const dirs = sel.filter((e) => e.isDir);
      return tidy([
        { label: sel.length > 1 ? `Open ${sel.length} items` : 'Open', shortcut: 'Enter', onClick: () => openEntries(sel) },
        dirs.length > 0 && {
          label: dirs.length > 1 ? `Open ${dirs.length} folders in new tabs` : 'Open in new tab',
          onClick: () => dirs.forEach((d) => openTab(d.path, false)),
        },
        single && single.isDir && { label: 'Open in new window', onClick: () => api.newWindow(single.path) },
        { label: `Show in ${fm}`, onClick: () => api.showInFolder(sel[0].path) },
        { separator: true },
        { label: 'Cut', shortcut: mod('X'), onClick: () => doCut(sel) },
        { label: 'Copy', shortcut: mod('C'), onClick: () => doCopy(sel) },
        single &&
          single.isDir && {
            label: 'Paste into folder',
            shortcut: mod('V'),
            disabled: !clipboard,
            onClick: () => doPaste(single.path),
          },
        { separator: true },
        single && { label: 'Rename', shortcut: 'F2', onClick: startRename },
        { label: sel.length > 1 ? 'Copy paths' : 'Copy path', onClick: () => copyPath(sel) },
        single && single.isDir && { label: 'Calculate folder size', onClick: () => folderSize(single) },
        { separator: true },
        {
          label: isMac ? 'Move to Trash' : 'Delete',
          shortcut: isMac ? '⌘⌫' : 'Del',
          onClick: doTrash,
        },
      ]);
    }
    return tidy([
      { label: 'New folder', shortcut: mod('⇧N'), onClick: doNewFolder },
      { label: 'Paste', shortcut: mod('V'), disabled: !clipboard, onClick: () => doPaste() },
      { separator: true },
      { label: 'Select all', shortcut: mod('A'), onClick: selectAll },
      { label: filters.showHidden ? 'Hide hidden files' : 'Show hidden files', onClick: toggleHidden },
      { label: 'Refresh', shortcut: 'F5', onClick: refresh },
      { separator: true },
      { label: `Open folder in ${fm}`, onClick: () => api.openFolder(path) },
      { label: 'Copy folder path', onClick: () => api.copyText(path) },
    ]);
  };

  /* ------------------------------ rendering ----------------------------- */

  if (!tabs || !tab) return <div className="app boot" />;

  let emptyState = null;
  if (dir.error) emptyState = { kind: 'error', message: dir.error };
  else if (!dir.loading && sorted.length === 0) {
    const hasCriteria = query.trim() || activeCount > 0;
    if (dir.entries.length === 0 && !hasCriteria) emptyState = { kind: 'empty' };
    else if (!hasCriteria && !filters.showHidden) emptyState = { kind: 'hidden', onShowHidden: toggleHidden };
    else emptyState = { kind: 'nomatch', onClear: clearAll };
  }

  const selSize = selected.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0);
  const q = query.trim();

  return (
    <div className={`app ${isMac ? 'mac' : 'win'}`}>
      <TabBar tabs={tabs} activeId={activeId} onSelect={setActiveId} onClose={closeTab} onNew={() => openTab(home)} />

      <Toolbar
        path={path}
        canBack={tab.index > 0}
        canForward={tab.index < tab.history.length - 1}
        canUp={!isRootPath(path)}
        onBack={() => go(-1)}
        onForward={() => go(1)}
        onUp={goUp}
        onRefresh={refresh}
        onNavigate={navigate}
        query={query}
        onQueryChange={(v) => updateTab(activeId, (t) => ({ ...t, query: v }))}
        recursive={recursive}
        onToggleRecursive={() => updateTab(activeId, (t) => ({ ...t, recursive: !t.recursive }))}
        addressTick={addressTick}
        findTick={findTick}
      />

      <CommandBar
        selectionCount={selected.length}
        canPaste={!!clipboard}
        onNewFolder={doNewFolder}
        onCut={() => doCut()}
        onCopy={() => doCopy()}
        onPaste={() => doPaste()}
        onRename={startRename}
        onDelete={doTrash}
        onOpenMany={() => openEntries(selected)}
        sort={sort}
        onSortChange={setSort}
        groupBy={groupBy}
        onGroupChange={setGroupBy}
        view={view}
        onViewChange={setView}
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen((o) => !o)}
        activeFilters={activeCount}
      />

      <div className="main">
        <Sidebar quick={quick} drives={drives} currentPath={path} onNavigate={navigate} />
        <FileView
          view={view}
          groups={groups}
          selection={selection}
          focusPath={focusPath}
          cutSet={cutSet}
          renamingPath={renamingPath}
          onSelect={onSelect}
          onOpen={(entry) => openEntries([entry])}
          onContext={onContext}
          onBackgroundClick={clearSelection}
          sort={sort}
          onSortColumn={(key) =>
            setSort((s) => (s.key === key ? { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { ...s, key, dir: 'asc' }))
          }
          showFolder={recursive && !!q}
          dateField={filters.dateField}
          onRenameCommit={commitRename}
          onRenameCancel={cancelRename}
          onColsChange={onColsChange}
          emptyState={emptyState}
        />
        {filtersOpen && (
          <FilterPanel
            filters={filters}
            onChange={setFilters}
            counts={counts}
            activeCount={activeCount}
            onClear={() =>
              setFilters((f) => ({ ...emptyFilters(), showHidden: f.showHidden, dateField: f.dateField }))
            }
            onClose={() => setFiltersOpen(false)}
          />
        )}
      </div>

      <footer className="statusbar" role="status">
        <span>
          {sorted.length} {sorted.length === 1 ? 'item' : 'items'} of {totalVisible}
        </span>
        {selected.length > 0 && (
          <span>
            {selected.length} selected{selSize > 0 ? `, ${formatSize(selSize)}` : ''}
          </span>
        )}
        {q && (
          <span>
            {recursive
              ? dir.loading
                ? `Searching subfolders for “${q}”…`
                : `${plural(dir.entries.length, 'result')} in subfolders${dir.truncated ? ' (limited to 3,000)' : ''}`
              : `Filtering by “${q}”`}
          </span>
        )}
        {dir.loading && <span className="loading">Loading…</span>}
      </footer>

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={menuItems()} onClose={() => setCtx(null)} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
            {t.type === 'error' ? <AlertCircle size={16} /> : <Info size={16} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

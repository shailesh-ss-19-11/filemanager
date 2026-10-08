import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import TabBar, { tabTitle } from './components/TabBar.jsx';
import Toolbar from './components/Toolbar.jsx';
import CommandBar from './components/CommandBar.jsx';
import Sidebar from './components/Sidebar.jsx';
import FilterPanel from './components/FilterPanel.jsx';
import FileView from './components/FileView.jsx';
import PreviewDialog from './components/PreviewDialog.jsx';
import PropertiesDialog from './components/PropertiesDialog.jsx';
import ConnectDialog from './components/ConnectDialog.jsx';
import CleanupDialog from './components/CleanupDialog.jsx';
import TransferPanel from './components/TransferPanel.jsx';
import { transferStore } from './lib/transferStore.js';
import ConflictDialog from './components/ConflictDialog.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import { useDirectory } from './lib/useDirectory.js';
import { useDiskSpace } from './lib/useDiskSpace.js';
import {
  applyFilters,
  computeCounts,
  countActiveFilters,
  dirname,
  isArchiveName,
  isRemotePath,
  remoteNames,
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

  const [pins, setPins] = usePersisted('pins', []);
  const [showExt, setShowExt] = usePersisted('showExt', true);
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
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connections, setConnections] = useState([]);
  const [usbPhone, setUsbPhone] = useState(null);
  const [previewPath, setPreviewPath] = useState(null);
  const [propsFor, setPropsFor] = useState(null); // entries shown in Properties
  const [dropPath, setDropPath] = useState(null); // folder currently hovered by a drag ('' = this folder)
  const undoRef = useRef([]);
  const [conflict, setConflict] = useState(null); // { names, resolve }
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
      setConnections(await api.ftpList());
      const offUsb = api.onMtpChanged(setUsbPhone);
      const prevOff = off;
      off = () => {
        prevOff();
        offUsb();
      };
      setUsbPhone(await api.mtpDevice());
      const d = await api.drives();
      if (!cancelled) setDrives(d);
    })();
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    Object.keys(remoteNames).forEach((k) => delete remoteNames[k]);
    connections.forEach((c) => {
      remoteNames[c.id] = c.name;
    });
    if (usbPhone) remoteNames.phone = usbPhone.name;
  }, [connections, usbPhone]);

  /* ------------------------------ derived ------------------------------- */

  const tab = tabs && tabs.find((t) => t.id === activeId);
  const path = tab ? tab.history[tab.index] : null;
  const [reloadTick, setReloadTick] = useState(0);
  const space = useDiskSpace(path, reloadTick);
  const query = tab ? tab.query : '';
  const recursive = tab ? tab.recursive : false;

  const dir = useDirectory(path, { query, recursive, showHidden: filters.showHidden });
  const { refresh: reloadFolder } = dir;
  // Reload = re-read this folder AND everything around it: free space, drives, phone, connections.
  const refresh = useCallback(() => {
    reloadFolder();
    setReloadTick((n) => n + 1);
    api.drives(true).then(setDrives).catch(() => {});
    api.mtpDevice().then(setUsbPhone).catch(() => {});
    api.ftpList().then(setConnections).catch(() => {});
  }, [reloadFolder]);

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
      const remoteFiles = files.filter((f) => isRemotePath(f.path));
      if (remoteFiles.length) {
        toast(`Opening “${remoteFiles[0].name}” from the phone (${formatSize(remoteFiles[0].size)})…`, 'info');
      }
      const meta = Object.fromEntries(remoteFiles.map((f) => [f.path, { size: f.size, mtime: f.mtime }]));
      api.open(files.map((f) => f.path), meta).then((r) => {
        if (!r.ok) toast(r.error || 'Could not open the file.');
      });
    }
  };

  const openEntriesRef = useRef(null);
  openEntriesRef.current = openEntries;
  const onOpenEntry = useCallback((entry) => openEntriesRef.current([entry]), []);

  const doCopy = (list = selected) => {
    if (list.length) setClipboard({ paths: list.map((e) => e.path), mode: 'copy' });
  };
  const doCut = (list = selected) => {
    if (list.length) setClipboard({ paths: list.map((e) => e.path), mode: 'cut' });
  };

  /* -------------------------------- undo -------------------------------- */

  const pushUndo = useCallback((label, fn) => {
    undoRef.current.push({ label, fn });
    if (undoRef.current.length > 50) undoRef.current.shift();
  }, []);

  const doUndo = async () => {
    const u = undoRef.current.pop();
    if (!u) return toast('Nothing to undo.', 'info');
    try {
      await u.fn();
      toast(`Undid: ${u.label}`, 'info');
    } catch (err) {
      toast(`Couldn’t undo “${u.label}”: ${(err && err.message) || 'unknown error'}`);
    }
    refresh();
  };

  // Copy/move `items` into `dest` with conflict prompt, progress and cancel.
  const transferItems = async (items, dest, mode) => {
    if (!items.length) return null;
    const c = await api.pasteConflicts(items, dest);
    let policy = 'keep';
    if (c.names.length) {
      policy = await new Promise((resolve) => setConflict({ names: c.names, resolve }));
      setConflict(null);
      if (!policy) return null;
    }
    const id = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const sizes = Object.fromEntries(dir.entries.filter((e) => !e.isDir).map((e) => [e.path, e.size]));
    if (mode === 'cut' && !samePath(dest, path) && items.every((p) => samePath(dirname(p), path))) dir.removeEntries(items);
    transferStore.add({ id, mode, current: '', done: 0, total: 0, items: items.length, elapsed: 0 });
    const r = await api.paste(items, dest, mode, { id, policy, sizes });
    transferStore.remove(id);
    r.errors.forEach((m) => toast(m));
    if (r.cancelled) toast('Cancelled.', 'info');
    if (mode === 'cut' && r.pasted.length) setClipboard(null);
    if (samePath(dest, path) && r.pasted.length) pendingRef.current = { paths: r.pasted };
    if (r.pasted.length && !r.cancelled) {
      if (mode === 'copy') {
        pushUndo(`copy of ${plural(r.pasted.length, 'item')}`, () => api.trash(r.pasted));
      } else if (r.pasted.length === items.length) {
        pushUndo(`move of ${plural(items.length, 'item')}`, async () => {
          for (let i = 0; i < items.length; i++) {
            await api.paste([r.pasted[i]], dirname(items[i]), 'cut', { id: `u${Date.now()}${i}`, policy: 'keep' });
          }
        });
      }
    }
    refresh();
    return r;
  };

  /* ----------------------------- drag & drop ----------------------------- */

  const hasPayload = (e) => {
    const t = e.dataTransfer && e.dataTransfer.types;
    return !!t && (t.includes('application/x-fm-paths') || t.includes('Files'));
  };
  const dndHandlers = {
    start: (entry, e) => {
      const paths = selectionRef.current.has(entry.path) ? [...selectionRef.current] : [entry.path];
      if (!selectionRef.current.has(entry.path)) {
        setSelection(new Set([entry.path]));
        anchorRef.current = entry.path;
      }
      e.dataTransfer.setData('application/x-fm-paths', JSON.stringify(paths));
      e.dataTransfer.effectAllowed = 'copyMove';
    },
    over: (target, e) => {
      if (!hasPayload(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.altKey || e.ctrlKey ? 'copy' : 'move';
      setDropPath((cur) => (cur === target ? cur : target));
    },
    leave: (target, e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      setDropPath((cur) => (cur === target ? null : cur));
    },
    drop: async (target, e) => {
      if (!hasPayload(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropPath(null);
      const dest = target === '' ? path : target;
      let paths;
      let mode;
      const internal = e.dataTransfer.getData('application/x-fm-paths');
      if (internal) {
        paths = JSON.parse(internal);
        const remoteInvolved = isRemotePath(dest) || paths.some(isRemotePath);
        mode = e.altKey || e.ctrlKey || remoteInvolved ? 'copy' : 'cut';
      } else {
        paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
        mode = 'copy';
      }
      paths = paths.filter((p) => p !== dest);
      if (paths.length) await transferItems(paths, dest, mode);
    },
  };

  const dndRef = useRef(dndHandlers);
  dndRef.current = dndHandlers;
  // Same object until the hovered drop target changes, so file rows (memoised) don't re-render on every update.
  const dnd = useMemo(
    () => ({
      dropPath,
      start: (...a) => dndRef.current.start(...a),
      over: (...a) => dndRef.current.over(...a),
      leave: (...a) => dndRef.current.leave(...a),
      drop: (...a) => dndRef.current.drop(...a),
    }),
    [dropPath]
  );

  const doPaste = async (dest = path) => {
    if (!clipboard || !clipboard.paths.length) return;
    await transferItems(clipboard.paths, dest, clipboard.mode);
  };

  const doNewFolder = async () => {
    const r = await api.newFolder(path);
    if (!r.ok) return toast(r.error);
    pendingRef.current = { paths: [r.path], rename: true };
    pushUndo('new folder', () => api.trash([r.path]));
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
      pushUndo(`rename of “${entry.name}”`, async () => {
        const back = await api.rename(r.path, entry.name);
        if (!back.ok) throw new Error(back.error);
      });
      refresh();
    },
    [refresh, toast, pushUndo]
  );
  const cancelRename = useCallback(() => setRenamingPath(null), []);

  const doTrash = async () => {
    if (!selected.length) return;
    const remoteCount = selected.filter((e) => isRemotePath(e.path)).length;
    if (
      remoteCount &&
      !window.confirm(
        `Permanently delete ${remoteCount === 1 ? 'this item' : `these ${remoteCount} items`} from the phone? This can't be undone.`
      )
    )
      return;
    const list = selected;
    dir.removeEntries(list.map((e) => e.path)); // disappear instantly; refresh() below restores anything that failed
    const r = await withProgress(isRemotePath(list[0].path) ? 'Deleting' : isMac ? 'Moving to Trash' : 'Deleting', list.length, (id) => api.trash(list.map((e) => e.path), id), 400, { unit: 'items', total: list.length, current: list[0].name });
    r.errors.forEach((m) => toast(m));
    if (r.cancelled) toast(`Stopped after ${plural(r.deleted, 'item')}.`, 'info');
    clearSelection();
    refresh();
  };

  const localOnly = (list) => list.length > 0 && list.every((e) => !isRemotePath(e.path));

  // Runs a phone/FTP/local task that reports progress through the transfer panel.
  const withProgress = async (label, items, fn, delay = 0, extra = {}) => {
    const id = `z${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const entry = { id, label, mode: 'copy', current: '', done: 0, total: 0, items, elapsed: 0, ...extra };
    // quick jobs (a local delete) finish before the panel would even flash up
    let timer = null;
    let shown = false;
    const show = () => {
      shown = true;
      transferStore.add(entry);
    };
    if (delay) timer = setTimeout(show, delay);
    else show();
    try {
      return await fn(id);
    } finally {
      clearTimeout(timer);
      if (shown) transferStore.remove(id);
    }
  };

  const doCompress = async (list = selected) => {
    if (!list.length) return;
    const onPhone = list.some((e) => isRemotePath(e.path));
    if (onPhone && !list.every((e) => isRemotePath(e.path))) return toast('Select items from one place to compress.');
    if (!onPhone) toast(`Compressing ${plural(list.length, 'item')}…`, 'info');
    const r = await withProgress('Compressing', list.length, (id) => api.compress(list.map((e) => e.path), id));
    if (!r.ok) return toast(r.cancelled ? 'Cancelled.' : r.error, r.cancelled ? 'info' : 'error');
    pendingRef.current = { paths: [r.path] };
    pushUndo('compress', () => api.trash([r.path]));
    toast(`Created “${r.path.split(/[\\/]/).pop()}”.`, 'info');
    refresh();
  };

  const doExtract = async (list = selected) => {
    const archives = list.filter((e) => !e.isDir && isArchiveName(e.name));
    if (!archives.length) return;
    const made = [];
    for (const a of archives) {
      if (!isRemotePath(a.path)) toast(`Extracting “${a.name}”…`, 'info');
      const r = await withProgress('Extracting', 1, (id) => api.extract(a.path, id));
      if (r.ok) made.push(r.path);
      else toast(r.cancelled ? 'Cancelled.' : `${a.name}: ${r.error}`, r.cancelled ? 'info' : 'error');
    }
    if (!made.length) return;
    pendingRef.current = { paths: made };
    pushUndo('extract', () => api.trash(made));
    refresh();
  };

  const doSetHidden = async (list, hidden) => {
    if (!localOnly(list)) return;
    const r = await api.setHidden(list.map((e) => e.path), hidden);
    if (!r.ok) return toast(r.error);
    pushUndo(hidden ? 'hide' : 'unhide', async () => {
      await api.setHidden(r.paths, !hidden);
    });
    if (hidden && !filters.showHidden) toast('Hidden. Use “Show hidden files” to see hidden items.', 'info');
    else pendingRef.current = { paths: r.paths };
    refresh();
  };

  const doNewFile = async () => {
    if (isRemotePath(path)) return toast('Creating files here is not supported on a phone connection.');
    const r = await api.newFile(path);
    if (!r.ok) return toast(r.error);
    pendingRef.current = { paths: [r.path], rename: true };
    pushUndo('new file', () => api.trash([r.path]));
    refresh();
  };

  const doOpenWith = async (list = selected) => {
    const files = list.filter((e) => !isRemotePath(e.path));
    if (!files.length) return toast('Open the file first, then use “Open with” on the downloaded copy.');
    const r = await api.openWith(files.map((e) => e.path));
    if (!r.ok) toast(r.error);
  };

  const doTransferTo = async (mode, list = selected) => {
    if (!list.length) return;
    const dest = await api.chooseFolder(mode === 'cut' ? 'Move to…' : 'Copy to…');
    if (dest) await transferItems(list.map((e) => e.path), dest, mode);
  };

  const doDeletePermanent = async (list = selected) => {
    if (!list.length) return;
    const what = list.length === 1 ? `“${list[0].name}”` : `these ${list.length} items`;
    if (!window.confirm(`Permanently delete ${what}? This can't be undone.`)) return;
    dir.removeEntries(list.map((e) => e.path));
    const r = await withProgress('Deleting', list.length, (id) => api.deletePermanent(list.map((e) => e.path), id), 400, { unit: 'items', total: list.length, current: list[0].name });
    r.errors.forEach((m) => toast(m));
    if (r.cancelled) toast(`Stopped after ${plural(r.deleted, 'item')}.`, 'info');
    clearSelection();
    refresh();
  };

  const showProperties = (list = selected) => {
    if (list.length) setPropsFor(list);
    else if (path) {
      setPropsFor([{ name: path.split(/[\\/]/).filter(Boolean).pop() || path, path, isDir: true, size: 0, mtime: 0, extension: '' }]);
    }
  };

  const startPreview = () => {
    const sel = selected.filter((e) => !e.isDir);
    if (sel.length === 1 || (selected.length === 1 && !selected[0].isDir)) setPreviewPath(sel[0].path);
  };

  const invertSelection = () => {
    const cur = selectionRef.current;
    setSelection(new Set(flatRef.current.filter((e) => !cur.has(e.path)).map((e) => e.path)));
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
    undo: () => (isTextTarget(document.activeElement) ? api.textEdit('undo') : doUndo()),
    deletePermanent: () => doDeletePermanent(),
    preview: startPreview,
    properties: () => showProperties(),
    trash: doTrash,
    clear: clearSelection,
    move: moveFocus,
  };
  const actRef = useRef(act);
  actRef.current = act;

  useEffect(() => api.onTransfer((m) => transferStore.update(m)), []);

  useEffect(() => api.onCommand(({ cmd }) => actRef.current[cmd] && actRef.current[cmd]()), []);

  useEffect(() => {
    const onKey = (e) => {
      if (isTextTarget(e.target) || document.querySelector('.modal-backdrop')) return;
      const a = actRef.current;
      const m = isMac ? e.metaKey : e.ctrlKey;
      const icons = document.querySelector('.fileview.icons');
      const cols = icons ? colsRef.current : 1;
      let handled = true;

      if (e.key === 'Delete' && e.shiftKey && !isMac) a.deletePermanent();
      else if (isMac && e.metaKey && e.altKey && e.key === 'Backspace') a.deletePermanent();
      else if (e.key === 'F5') a.refresh();
      else if (e.altKey && !isMac && e.key === 'Enter') a.properties();
      else if (isMac && e.metaKey && e.key.toLowerCase() === 'i') a.properties();
      else if (e.altKey && isMac && !e.ctrlKey && !e.metaKey && e.key === 'ArrowLeft') a.back();
      else if (e.altKey && isMac && !e.ctrlKey && !e.metaKey && e.key === 'ArrowRight') a.forward();
      else if (e.altKey && isMac && !e.ctrlKey && !e.metaKey && e.key === 'ArrowUp') a.up();
      else if (m || e.altKey) handled = false; // leave menu accelerators alone
      else if (e.key === 'ArrowDown') a.move(icons ? cols : 1, e.shiftKey);
      else if (e.key === 'ArrowUp') a.move(icons ? -cols : -1, e.shiftKey);
      else if (e.key === 'ArrowRight' && icons) a.move(1, e.shiftKey);
      else if (e.key === 'ArrowLeft' && icons) a.move(-1, e.shiftKey);
      else if (e.key === 'Enter') a.open();
      else if (e.key === ' ') a.preview();
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
        single && !single.isDir && { label: 'Preview', shortcut: 'Space', onClick: startPreview },
        dirs.length > 0 && {
          label: dirs.length > 1 ? `Open ${dirs.length} folders in new tabs` : 'Open in new tab',
          onClick: () => dirs.forEach((d) => openTab(d.path, false)),
        },
        single && single.isDir && { label: 'Open in new window', onClick: () => api.newWindow(single.path) },
        single &&
          single.isDir &&
          (Array.isArray(pins) && pins.some((p) => samePath(p.path, single.path))
            ? { label: 'Unpin from sidebar', onClick: () => setPins((ps) => ps.filter((p) => !samePath(p.path, single.path))) }
            : { label: 'Pin to sidebar', onClick: () => setPins((ps) => [...(Array.isArray(ps) ? ps : []), { path: single.path, name: single.name }]) }),
        !sel.some((e) => isRemotePath(e.path)) && { label: 'Open with…', onClick: () => doOpenWith(sel) },
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
        { label: sel.length > 1 ? `Compress ${sel.length} items to ZIP` : 'Compress to ZIP', onClick: () => doCompress(sel) },
        sel.some((e) => !e.isDir && isArchiveName(e.name)) && { label: 'Extract here', onClick: () => doExtract(sel) },
        localOnly(sel) &&
          (sel.every((e) => e.hidden)
            ? { label: 'Unhide', onClick: () => doSetHidden(sel, false) }
            : { label: 'Hide', onClick: () => doSetHidden(sel, true) }),
        { label: 'Copy to…', onClick: () => doTransferTo('copy', sel) },
        { label: 'Move to…', onClick: () => doTransferTo('cut', sel) },
        { label: sel.length > 1 ? 'Copy paths' : 'Copy path', onClick: () => copyPath(sel) },
        single && single.isDir && { label: 'Calculate folder size', onClick: () => folderSize(single) },
        { separator: true },
        {
          label: isMac ? 'Move to Trash' : 'Delete',
          shortcut: isMac ? '⌘⌫' : 'Del',
          onClick: doTrash,
        },
        isMac
          ? { label: 'Delete immediately…', shortcut: '⌥⌘⌫', onClick: () => doDeletePermanent(sel) }
          : { label: 'Delete permanently…', shortcut: 'Shift+Del', onClick: () => doDeletePermanent(sel) },
        { separator: true },
        { label: 'Properties', shortcut: isMac ? '⌘I' : 'Alt+Enter', onClick: () => showProperties(sel) },
      ]);
    }
    return tidy([
      { label: 'New folder', shortcut: mod('⇧N'), onClick: doNewFolder },
      { label: 'New file', onClick: doNewFile },
      { label: 'Paste', shortcut: mod('V'), disabled: !clipboard, onClick: () => doPaste() },
      { separator: true },
      { label: 'Select all', shortcut: mod('A'), onClick: selectAll },
      { label: 'Invert selection', onClick: invertSelection },
      { label: 'Undo', shortcut: mod('Z'), onClick: doUndo },
      { label: filters.showHidden ? 'Hide hidden files' : 'Show hidden files', onClick: toggleHidden },
      { label: 'Refresh', shortcut: 'F5', onClick: refresh },
      { separator: true },
      { label: `Open folder in ${fm}`, onClick: () => api.openFolder(path) },
      { label: 'Copy folder path', onClick: () => api.copyText(path) },
      { separator: true },
      { label: 'Properties', onClick: () => showProperties([]) },
    ]);
  };

  const moreSections = () => {
    const sel = selected;
    const has = sel.length > 0;
    const local = localOnly(sel);
    const canExtract = sel.some((e) => !e.isDir && isArchiveName(e.name));
    return [
      [
        { label: 'Compress to ZIP', disabled: !has, onSelect: () => doCompress() },
        { label: 'Extract here', disabled: !canExtract, onSelect: () => doExtract() },
      ],
      [
        { label: 'Hide', disabled: !local, onSelect: () => doSetHidden(sel, true) },
        { label: 'Unhide', disabled: !local, onSelect: () => doSetHidden(sel, false) },
        { label: filters.showHidden ? 'Hide hidden files' : 'Show hidden files', onSelect: toggleHidden },
        { label: showExt ? 'Hide file name extensions' : 'Show file name extensions', onSelect: () => setShowExt((v) => !v) },
      ],
      [
        { label: 'Copy to…', disabled: !has, onSelect: () => doTransferTo('copy') },
        { label: 'Move to…', disabled: !has, onSelect: () => doTransferTo('cut') },
        { label: 'Open with…', disabled: !local, onSelect: () => doOpenWith() },
      ],
      [
        { label: 'New file', onSelect: doNewFile },
        { label: 'Select all', shortcut: mod('A'), onSelect: selectAll },
        { label: 'Select none', onSelect: clearSelection },
        { label: 'Invert selection', onSelect: invertSelection },
      ],
      [
        { label: 'Undo', shortcut: mod('Z'), onSelect: doUndo },
        { label: isMac ? 'Delete immediately…' : 'Delete permanently…', disabled: !has, onSelect: () => doDeletePermanent() },
        { label: 'Properties', shortcut: isMac ? '⌘I' : 'Alt+Enter', onSelect: () => showProperties() },
      ],
    ];
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
        refreshing={dir.loading}
        onNavigate={navigate}
        query={query}
        onQueryChange={(v) => updateTab(activeId, (t) => ({ ...t, query: v }))}
        recursive={recursive}
        onToggleRecursive={() => updateTab(activeId, (t) => ({ ...t, recursive: !t.recursive }))}
        addressTick={addressTick}
        findTick={findTick}
        dnd={dnd}
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
        moreSections={moreSections()}
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
        <Sidebar reloadTick={reloadTick} dnd={dnd} pins={Array.isArray(pins) ? pins : []} onUnpin={(p) => setPins((ps) => ps.filter((x) => x.path !== p.path))} quick={quick} drives={drives} currentPath={path} onNavigate={navigate} onCleanup={() => setCleanupOpen(true)}
          usbPhone={usbPhone}
          connections={connections}
          onConnect={() => setConnectOpen(true)}
          onDisconnect={async (c) => {
            setConnections(await api.ftpRemove(c.id));
            if (path && path.startsWith(c.path.slice(0, -1))) navigate(home);
          }}
        />
        <FileView
          view={view}
          groups={groups}
          selection={selection}
          focusPath={focusPath}
          cutSet={cutSet}
          renamingPath={renamingPath}
          onSelect={onSelect}
          onOpen={onOpenEntry}
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
          dnd={dnd}
          showExt={showExt}
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
        {space && (
          <span className="disk-space" title={`${formatSize(space.used)} used`}>
            {formatSize(space.free)} free of {formatSize(space.total)} · {formatSize(space.used)} used
          </span>
        )}
      </footer>

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={menuItems()} onClose={() => setCtx(null)} />}

      {previewPath && (
        <PreviewDialog
          entries={flat.filter((e) => !e.isDir)}
          startPath={previewPath}
          onClose={() => setPreviewPath(null)}
          onOpen={(e) => openEntries([e])}
          onSelect={(p) => {
            setSelection(new Set([p]));
            setFocusPath(p);
            anchorRef.current = p;
          }}
        />
      )}
      {propsFor && <PropertiesDialog entries={propsFor} onClose={() => setPropsFor(null)} onChanged={refresh} />}
      <TransferPanel onCancel={(id) => api.cancelTransfer(id)} />
      {conflict && <ConflictDialog names={conflict.names} onChoose={(p) => conflict.resolve(p)} />}
      {connectOpen && (
        <ConnectDialog
          onClose={() => setConnectOpen(false)}
          onConnected={(c) => {
            setConnections((cs) => [...cs, c]);
            setConnectOpen(false);
            navigate(c.path);
          }}
        />
      )}
      {cleanupOpen && path && (
        <CleanupDialog
          scopes={[
            ...(isRemotePath(path) ? [] : [{ label: 'This folder', path }]),
            { label: 'Home folder', path: home },
            ...quick.filter((q) => q.key === 'downloads').map((q) => ({ label: 'Downloads', path: q.path })),
          ]}
          onClose={() => {
            setCleanupOpen(false);
            refresh();
          }}
          onToast={toast}
        />
      )}
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

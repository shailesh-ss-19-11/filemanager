import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FolderOpen, SearchX, AlertTriangle, EyeOff } from 'lucide-react';
import FileIcon from './FileIcon.jsx';
import { formatDate, formatSize, getKind, splitNameExt, typeLabel, dirname } from '../lib/fileUtils.js';

/* ---------------------------- inline rename ---------------------------- */

const shownName = (entry, showExt) =>
  showExt || entry.isDir || !entry.extension || !entry.name.toLowerCase().endsWith('.' + entry.extension)
    ? entry.name
    : entry.name.slice(0, -(entry.extension.length + 1));

function RenameInput({ entry, onCommit, onCancel }) {
  const ref = useRef(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const [stem] = splitNameExt(entry);
    el.setSelectionRange(0, stem.length);
  }, [entry]);

  const finish = (commit) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(entry, ref.current.value);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={entry.name}
      spellCheck={false}
      aria-label="New name"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

/* ------------------------------ thumbnails ----------------------------- */

const thumbCache = new Map(); // key -> dataURL | null
const THUMB_KINDS = new Set(['image', 'video', 'document']);

function Thumb({ entry, kind }) {
  const key = `${entry.path}|${entry.mtime}`;
  const ref = useRef(null);
  const [url, setUrl] = useState(() => thumbCache.get(key) || null);

  useEffect(() => {
    if (!THUMB_KINDS.has(kind)) return undefined;
    if (thumbCache.has(key)) {
      setUrl(thumbCache.get(key));
      return undefined;
    }
    setUrl(null);
    const el = ref.current;
    if (!el) return undefined;
    let cancelled = false;
    const io = new IntersectionObserver(
      (items) => {
        if (!items[0].isIntersecting) return;
        io.disconnect();
        window.fsApi.thumbnail({ path: entry.path, mtime: entry.mtime }).then((u) => {
          thumbCache.set(key, u);
          if (!cancelled) setUrl(u);
        });
      },
      { rootMargin: '200px' }
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [key, kind, entry.path, entry.mtime]);

  return (
    <div className="thumb" ref={ref}>
      {url ? <img src={url} alt="" draggable={false} /> : <FileIcon entry={entry} kind={kind} size={44} />}
    </div>
  );
}

/* --------------------------------- rows -------------------------------- */

const dropProps = (entry, dnd, renaming) => ({
  draggable: !renaming,
  onDragStart: (e) => dnd.start(entry, e),
  onDragOver: entry.isDir ? (e) => dnd.over(entry.path, e) : undefined,
  onDragLeave: entry.isDir ? (e) => dnd.leave(entry.path, e) : undefined,
  onDrop: entry.isDir ? (e) => dnd.drop(entry.path, e) : undefined,
});

const Row = memo(function Row({
  showExt,
  dnd,
  dropTarget,
  entry,
  selected,
  focused,
  cut,
  renaming,
  showFolder,
  dateField,
  onSelect,
  onOpen,
  onContext,
  onRenameCommit,
  onRenameCancel,
}) {
  return (
    <div
      className={`row${selected ? ' selected' : ''}${focused ? ' focused' : ''}${cut ? ' cut' : ''}${
        entry.hidden ? ' hidden-item' : ''
      }${dropTarget ? ' drop-target' : ''}`}
      {...dropProps(entry, dnd, renaming)}
      role="row"
      aria-selected={selected}
      data-path={entry.path}
      onClick={(e) => onSelect(entry, e)}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(e) => onContext(e, entry)}
    >
      <div className="cell name" role="gridcell">
        <FileIcon entry={entry} />
        {renaming ? (
          <RenameInput entry={entry} onCommit={onRenameCommit} onCancel={onRenameCancel} />
        ) : (
          <span className="name-text" title={entry.name}>
            {shownName(entry, showExt)}
          </span>
        )}
      </div>
      {showFolder && (
        <div className="cell folder" role="gridcell" title={dirname(entry.path)}>
          {dirname(entry.path)}
        </div>
      )}
      <div className="cell date" role="gridcell">
        {formatDate(entry[dateField])}
      </div>
      <div className="cell type" role="gridcell">
        {typeLabel(entry)}
      </div>
      <div className="cell size" role="gridcell">
        {entry.isDir ? '' : formatSize(entry.size)}
      </div>
    </div>
  );
});

const Tile = memo(function Tile({ showExt, dnd, dropTarget, entry, selected, focused, cut, renaming, onSelect, onOpen, onContext, onRenameCommit, onRenameCancel }) {
  const kind = getKind(entry);
  return (
    <div
      className={`tile${selected ? ' selected' : ''}${focused ? ' focused' : ''}${cut ? ' cut' : ''}${
        entry.hidden ? ' hidden-item' : ''
      }${dropTarget ? ' drop-target' : ''}`}
      {...dropProps(entry, dnd, renaming)}
      role="option"
      aria-selected={selected}
      data-path={entry.path}
      title={entry.name}
      onClick={(e) => onSelect(entry, e)}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(e) => onContext(e, entry)}
    >
      {kind === 'folder' ? (
        <div className="thumb">
          <FileIcon entry={entry} size={52} />
        </div>
      ) : (
        <Thumb entry={entry} kind={kind} />
      )}
      {renaming ? (
        <RenameInput entry={entry} onCommit={onRenameCommit} onCancel={onRenameCancel} />
      ) : (
        <span className="tile-name">{shownName(entry, showExt)}</span>
      )}
    </div>
  );
});

/* -------------------------------- main --------------------------------- */

function EmptyState({ state }) {
  if (state.kind === 'error') {
    return (
      <div className="empty">
        <AlertTriangle size={40} strokeWidth={1.25} />
        <p className="empty-title">Can’t open this folder</p>
        <p className="empty-sub">{state.message}</p>
      </div>
    );
  }
  if (state.kind === 'empty') {
    return (
      <div className="empty">
        <FolderOpen size={40} strokeWidth={1.25} />
        <p className="empty-title">This folder is empty</p>
      </div>
    );
  }
  if (state.kind === 'hidden') {
    return (
      <div className="empty">
        <EyeOff size={40} strokeWidth={1.25} />
        <p className="empty-title">This folder only contains hidden items</p>
        <button className="btn" onClick={state.onShowHidden}>
          Show hidden files
        </button>
      </div>
    );
  }
  return (
    <div className="empty">
      <SearchX size={40} strokeWidth={1.25} />
      <p className="empty-title">No items match your search and filters</p>
      <button className="btn" onClick={state.onClear}>
        Clear search and filters
      </button>
    </div>
  );
}

export default function FileView({
  view,
  groups,
  selection,
  focusPath,
  cutSet,
  renamingPath,
  onSelect,
  onOpen,
  onContext,
  onBackgroundClick,
  sort,
  onSortColumn,
  showFolder,
  dateField,
  onRenameCommit,
  onRenameCancel,
  onColsChange,
  emptyState,
  dnd,
  showExt = true,
}) {
  const scrollRef = useRef(null);

  // keep the keyboard focus row visible
  useEffect(() => {
    if (!focusPath || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-path="${CSS.escape(focusPath)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [focusPath]);

  // report the number of grid columns (for up/down jumps in Icons view)
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || view !== 'icons') {
      onColsChange(1);
      return undefined;
    }
    const measure = () => {
      const grid = root.querySelector('.icon-grid');
      if (!grid) return;
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
      onColsChange(Math.max(1, cols));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [view, groups, onColsChange]);

  const rowProps = (entry) => ({
    entry,
    selected: selection.has(entry.path),
    focused: focusPath === entry.path,
    cut: cutSet.has(entry.path),
    renaming: renamingPath === entry.path,
    showExt,
    dnd,
    dropTarget: dnd.dropPath === entry.path,
    onSelect,
    onOpen,
    onContext,
    onRenameCommit,
    onRenameCancel,
  });

  const bgClick = (e) => {
    if (e.target === e.currentTarget || e.target.classList.contains('group-body')) onBackgroundClick();
  };

  const sortIcon = (key) =>
    sort.key === key ? (
      sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
    ) : null;

  const columns = [
    { key: 'name', label: 'Name', cls: 'name' },
    ...(showFolder ? [{ key: null, label: 'Folder', cls: 'folder' }] : []),
    { key: dateField, label: dateField === 'mtime' ? 'Date modified' : 'Date created', cls: 'date' },
    { key: 'type', label: 'Type', cls: 'type' },
    { key: 'size', label: 'Size', cls: 'size' },
  ];

  return (
    <div
      className={`fileview ${view}${showFolder ? ' with-folder' : ''}${dnd.dropPath === '' ? ' drop-here' : ''}`}
      ref={scrollRef}
      onDragOver={(e) => dnd.over('', e)}
      onDragLeave={(e) => dnd.leave('', e)}
      onDrop={(e) => dnd.drop('', e)}
      onClick={bgClick}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget || e.target.classList.contains('group-body') || e.target.closest('.empty')) {
          onContext(e, null);
        }
      }}
    >
      {view === 'details' && !emptyState && (
        <div className="row header" role="row">
          {columns.map((c) => (
            <button
              key={c.cls}
              className={`cell ${c.cls} hcell`}
              disabled={!c.key}
              onClick={() => c.key && onSortColumn(c.key)}
              aria-sort={c.key && sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              {c.label}
              {c.key && sortIcon(c.key)}
            </button>
          ))}
        </div>
      )}

      {emptyState ? (
        <EmptyState state={emptyState} />
      ) : (
        groups.map((g) => (
          <section key={g.id} className="group">
            {g.label && (
              <h4 className="group-header">
                {g.label} <span className="group-count">{g.items.length}</span>
              </h4>
            )}
            {view === 'details' ? (
              <div className="group-body rows" role="rowgroup">
                {g.items.map((e) => (
                  <Row key={e.path} {...rowProps(e)} showFolder={showFolder} dateField={dateField} />
                ))}
              </div>
            ) : (
              <div className="group-body icon-grid" role="listbox" aria-multiselectable="true">
                {g.items.map((e) => (
                  <Tile key={e.path} {...rowProps(e)} />
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}

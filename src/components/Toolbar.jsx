import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, ChevronRight, FolderTree, RotateCw, Search, X } from 'lucide-react';
import { splitPath } from '../lib/fileUtils.js';

export default function Toolbar({
  path,
  canBack,
  canForward,
  canUp,
  onBack,
  onForward,
  onUp,
  onRefresh,
  onNavigate,
  query,
  onQueryChange,
  recursive,
  onToggleRecursive,
  addressTick,
  findTick,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const crumbsRef = useRef(null);
  const addrRef = useRef(null);
  const searchRef = useRef(null);

  // "Go to Address" command
  useEffect(() => {
    if (addressTick) {
      setDraft(path);
      setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressTick]);

  // "Find" command
  useEffect(() => {
    if (findTick && searchRef.current) {
      searchRef.current.focus();
      searchRef.current.select();
    }
  }, [findTick]);

  useEffect(() => {
    if (editing && addrRef.current) {
      addrRef.current.focus();
      addrRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    setEditing(false);
  }, [path]);

  // keep the last crumb visible
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path, editing]);

  const parts = splitPath(path);

  const commit = () => {
    const v = draft.trim();
    setEditing(false);
    if (v && v !== path) onNavigate(v);
  };

  return (
    <div className="toolbar">
      <div className="nav-buttons">
        <button className="icon-btn" onClick={onBack} disabled={!canBack} aria-label="Back" title="Back">
          <ArrowLeft size={16} />
        </button>
        <button className="icon-btn" onClick={onForward} disabled={!canForward} aria-label="Forward" title="Forward">
          <ArrowRight size={16} />
        </button>
        <button className="icon-btn" onClick={onUp} disabled={!canUp} aria-label="Up one level" title="Up">
          <ArrowUp size={16} />
        </button>
        <button className="icon-btn" onClick={onRefresh} aria-label="Refresh" title="Refresh">
          <RotateCw size={15} />
        </button>
      </div>

      <div className={`address${editing ? ' editing' : ''}`}>
        {editing ? (
          <input
            ref={addrRef}
            className="address-input"
            value={draft}
            spellCheck={false}
            aria-label="Path"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={() => setEditing(false)}
          />
        ) : (
          <div className="crumbs" ref={crumbsRef} aria-label="Breadcrumbs">
            <FolderTree size={14} className="crumb-icon" />
            {parts.map((p, i) => (
              <span key={p.path} className="crumb-wrap">
                {i > 0 && <ChevronRight size={12} className="crumb-sep" />}
                <button
                  className="crumb"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate(p.path);
                  }}
                >
                  {p.name}
                </button>
              </span>
            ))}
            <div
              className="crumb-fill"
              onClick={() => {
                setDraft(path);
                setEditing(true);
              }}
              title="Click to edit path"
            />
          </div>
        )}
      </div>

      <div className="search">
        <Search size={14} className="search-icon" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onQueryChange('');
              e.target.blur();
            }
          }}
          placeholder={recursive ? 'Search subfolders (*.pdf, IMG_??.jpg)' : 'Search (*.pdf, IMG_??.jpg)'}
          aria-label="Search"
          spellCheck={false}
        />
        {query && (
          <button className="icon-btn small" onClick={() => onQueryChange('')} aria-label="Clear search">
            <X size={12} />
          </button>
        )}
        <button
          className={`icon-btn small${recursive ? ' on' : ''}`}
          onClick={onToggleRecursive}
          aria-pressed={recursive}
          aria-label="Include subfolders"
          title={recursive ? 'Searching subfolders' : 'Include subfolders'}
        >
          <FolderTree size={14} />
        </button>
      </div>
    </div>
  );
}

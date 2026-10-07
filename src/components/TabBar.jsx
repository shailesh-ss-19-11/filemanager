import { Folder, Plus, X } from 'lucide-react';
import { basename, isRootPath } from '../lib/fileUtils.js';

export function tabTitle(path) {
  if (!path) return 'New tab';
  if (isRootPath(path)) return path.replace(/[\\/]+$/, '') || '/';
  return basename(path);
}

export default function TabBar({ tabs, activeId, onSelect, onClose, onNew }) {
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => {
        const path = t.history[t.index];
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className={`tab${active ? ' active' : ''}`}
            title={path}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(t.id);
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault(); // avoid autoscroll cursor
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
          >
            <Folder size={14} className="tab-icon" />
            <span className="tab-title">{tabTitle(path)}</span>
            <button
              className="tab-close"
              aria-label={`Close tab ${tabTitle(path)}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <button className="tab-new" onClick={onNew} aria-label="New tab" title="New tab">
        <Plus size={16} />
      </button>
    </div>
  );
}

import {
  ArrowDownAZ,
  ClipboardPaste,
  Copy,
  FolderPlus,
  Group,
  LayoutGrid,
  List,
  PencilLine,
  Scissors,
  SlidersHorizontal,
  Trash2,
  ExternalLink,
  MoreHorizontal,
} from 'lucide-react';
import Dropdown from './Dropdown.jsx';
import { GROUP_KEYS, SORT_KEYS } from '../lib/fileUtils.js';

export default function CommandBar({
  selectionCount,
  canPaste,
  onNewFolder,
  onCut,
  onCopy,
  onPaste,
  onRename,
  onDelete,
  onOpenMany,
  moreSections,
  sort,
  onSortChange,
  groupBy,
  onGroupChange,
  view,
  onViewChange,
  filtersOpen,
  onToggleFilters,
  activeFilters,
}) {
  const has = selectionCount > 0;
  const sortLabel = SORT_KEYS.find((s) => s.id === sort.key)?.label;
  const groupLabel = GROUP_KEYS.find((g) => g.id === groupBy)?.label;

  return (
    <div className="commandbar" role="toolbar" aria-label="Commands">
      <button className="cmd-btn" onClick={onNewFolder}>
        <FolderPlus size={15} />
        <span>New folder</span>
      </button>
      <span className="cmd-sep" />
      <button className="cmd-btn" onClick={onCut} disabled={!has} title="Cut">
        <Scissors size={15} />
        <span className="cmd-text">Cut</span>
      </button>
      <button className="cmd-btn" onClick={onCopy} disabled={!has} title="Copy">
        <Copy size={15} />
        <span className="cmd-text">Copy</span>
      </button>
      <button className="cmd-btn" onClick={onPaste} disabled={!canPaste} title="Paste">
        <ClipboardPaste size={15} />
        <span className="cmd-text">Paste</span>
      </button>
      <button className="cmd-btn" onClick={onRename} disabled={selectionCount !== 1} title="Rename (F2)">
        <PencilLine size={15} />
        <span className="cmd-text">Rename</span>
      </button>
      <button className="cmd-btn" onClick={onDelete} disabled={!has} title="Move to Trash">
        <Trash2 size={15} />
        <span className="cmd-text">Delete</span>
      </button>
      <Dropdown icon={<MoreHorizontal size={15} />} label="More" title="More actions" sections={moreSections || []} />
      {selectionCount > 1 && (
        <button className="cmd-btn accent" onClick={onOpenMany}>
          <ExternalLink size={15} />
          <span>Open {selectionCount}</span>
        </button>
      )}

      <span className="cmd-spacer" />

      <Dropdown
        icon={<ArrowDownAZ size={15} />}
        label="Sort"
        value={sortLabel}
        title="Sort by"
        sections={[
          SORT_KEYS.map((s) => ({
            label: s.label,
            checked: sort.key === s.id,
            onSelect: () => onSortChange({ ...sort, key: s.id }),
          })),
          [
            { label: 'Ascending', checked: sort.dir === 'asc', onSelect: () => onSortChange({ ...sort, dir: 'asc' }) },
            { label: 'Descending', checked: sort.dir === 'desc', onSelect: () => onSortChange({ ...sort, dir: 'desc' }) },
          ],
          [
            {
              label: 'Folders first',
              checked: sort.foldersFirst,
              keepOpen: true,
              onSelect: () => onSortChange({ ...sort, foldersFirst: !sort.foldersFirst }),
            },
          ],
        ]}
      />
      <Dropdown
        icon={<Group size={15} />}
        label="Group"
        value={groupLabel}
        title="Group by"
        sections={[
          GROUP_KEYS.map((g) => ({ label: g.label, checked: groupBy === g.id, onSelect: () => onGroupChange(g.id) })),
        ]}
      />

      <div className="view-switch" role="group" aria-label="View">
        <button
          className={view === 'details' ? 'on' : ''}
          onClick={() => onViewChange('details')}
          aria-pressed={view === 'details'}
          title="Details"
        >
          <List size={15} />
        </button>
        <button
          className={view === 'icons' ? 'on' : ''}
          onClick={() => onViewChange('icons')}
          aria-pressed={view === 'icons'}
          title="Icons"
        >
          <LayoutGrid size={15} />
        </button>
      </div>

      <button className={`cmd-btn${filtersOpen ? ' pressed' : ''}`} onClick={onToggleFilters} aria-pressed={filtersOpen}>
        <SlidersHorizontal size={15} />
        <span>Filters</span>
        {activeFilters > 0 && <span className="badge">{activeFilters}</span>}
      </button>
    </div>
  );
}

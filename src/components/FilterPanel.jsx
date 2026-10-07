import { useState } from 'react';
import { X } from 'lucide-react';
import { DATE_BUCKETS, KINDS, SIZE_BUCKETS } from '../lib/fileUtils.js';

function Chip({ label, count, active, onClick, kind, hint }) {
  const disabled = !active && !count;
  return (
    <button
      className={`chip${active ? ' active' : ''}${disabled ? ' zero' : ''}`}
      onClick={onClick}
      aria-pressed={active}
      title={hint}
    >
      {kind && <span className={`chip-dot kind-${kind}`} />}
      <span className="chip-label">{label}</span>
      <span className="chip-count">{count || 0}</span>
    </button>
  );
}

function Section({ title, children, right }) {
  return (
    <section className="fp-section">
      <div className="fp-title">
        <h3>{title}</h3>
        {right}
      </div>
      <div className="chips">{children}</div>
    </section>
  );
}

const toggleIn = (set, v) => {
  const n = new Set(set);
  if (n.has(v)) n.delete(v);
  else n.add(v);
  return n;
};

export default function FilterPanel({ filters, onChange, counts, activeCount, onClear, onClose }) {
  const [extQuery, setExtQuery] = useState('');
  const extList = counts.extList.filter((x) => !extQuery || x.ext.includes(extQuery.toLowerCase().replace(/^\./, '')));

  return (
    <aside className="filter-panel" aria-label="Filters">
      <header className="fp-header">
        <h2>Filters</h2>
        <button className="link-btn" onClick={onClear} disabled={activeCount === 0}>
          Clear
        </button>
        <button className="icon-btn small" onClick={onClose} aria-label="Close filters">
          <X size={14} />
        </button>
      </header>

      <div className="fp-body">
        <Section title="Kind">
          {KINDS.map((k) => (
            <Chip
              key={k.id}
              kind={k.id}
              label={k.label}
              count={counts.kinds[k.id]}
              active={filters.kinds.has(k.id)}
              onClick={() => onChange({ ...filters, kinds: toggleIn(filters.kinds, k.id) })}
            />
          ))}
        </Section>

        <Section title="Size">
          {SIZE_BUCKETS.map((b) => (
            <Chip
              key={b.id}
              label={b.label}
              hint={b.hint}
              count={counts.sizes[b.id]}
              active={filters.sizes.has(b.id)}
              onClick={() => onChange({ ...filters, sizes: toggleIn(filters.sizes, b.id) })}
            />
          ))}
          <div className="fp-note">Applies to files only. Ranges follow File Explorer.</div>
        </Section>

        <Section
          title="Date"
          right={
            <div className="seg" role="group" aria-label="Date field">
              <button
                className={filters.dateField === 'mtime' ? 'on' : ''}
                onClick={() => onChange({ ...filters, dateField: 'mtime' })}
              >
                Modified
              </button>
              <button
                className={filters.dateField === 'birthtime' ? 'on' : ''}
                onClick={() => onChange({ ...filters, dateField: 'birthtime' })}
              >
                Created
              </button>
            </div>
          }
        >
          {DATE_BUCKETS.map((b) => (
            <Chip
              key={b.id}
              label={b.label}
              count={counts.dates[b.id]}
              active={filters.dates.has(b.id)}
              onClick={() => onChange({ ...filters, dates: toggleIn(filters.dates, b.id) })}
            />
          ))}
        </Section>

        <Section title="Extension">
          {counts.extList.length > 8 && (
            <input
              className="fp-search"
              placeholder="Find extension…"
              value={extQuery}
              onChange={(e) => setExtQuery(e.target.value)}
              aria-label="Find extension"
            />
          )}
          {counts.extList.length === 0 && <div className="fp-note">No file extensions here.</div>}
          {extList.map((x) => (
            <Chip
              key={x.ext}
              label={`.${x.ext}`}
              count={x.count}
              active={filters.exts.has(x.ext)}
              onClick={() => onChange({ ...filters, exts: toggleIn(filters.exts, x.ext) })}
            />
          ))}
        </Section>

        <section className="fp-section">
          <label className="toggle">
            <input
              type="checkbox"
              checked={filters.showHidden}
              onChange={(e) => onChange({ ...filters, showHidden: e.target.checked })}
            />
            <span>Show hidden files</span>
          </label>
        </section>
      </div>
    </aside>
  );
}

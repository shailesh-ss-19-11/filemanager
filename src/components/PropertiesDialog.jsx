import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import FileIcon from './FileIcon.jsx';
import { formatDate, formatSize, isMac, isRemotePath, isWin, plural, typeLabel } from '../lib/fileUtils.js';

/** Windows-style Properties window for one item (or the current folder) or a multi-selection summary. */
export default function PropertiesDialog({ entries, onClose, onChanged }) {
  const api = window.fsApi;
  const single = entries.length === 1 ? entries[0] : null;
  const remote = entries.some((e) => isRemotePath(e.path));
  const [info, setInfo] = useState(null);
  const [size, setSize] = useState(null); // { size, count, truncated, loading }
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (single && !remote) {
        const r = await api.properties(single.path);
        if (!cancelled) (r.ok ? setInfo(r) : setError(r.error));
      }
      setSize({ loading: true });
      let total = 0;
      let count = 0;
      let truncated = false;
      for (const e of entries) {
        if (e.isDir) {
          const r = await api.folderSize(e.path);
          if (r.ok) {
            total += r.size;
            count += r.count;
            truncated = truncated || r.truncated;
          }
        } else {
          total += e.size || 0;
          count += 1;
        }
      }
      if (!cancelled) setSize({ size: total, count, truncated });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setAttr = async (kind, value) => {
    const fn = kind === 'hidden' ? api.setHidden : api.setReadOnly;
    const r = await fn(entries.map((e) => e.path), value);
    if (!r.ok) return setError(r.error);
    setError('');
    if (single) setInfo((i) => ({ ...i, [kind === 'hidden' ? 'hidden' : 'readOnly']: value }));
    onChanged();
  };

  const title = single ? single.name : `${entries.length} items`;
  const row = (k, v) =>
    v == null || v === '' ? null : (
      <div className="prop-row" key={k}>
        <span className="prop-key">{k}</span>
        <span className="prop-val">{v}</span>
      </div>
    );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal props" role="dialog" aria-label={`Properties of ${title}`}>
        <header className="modal-head">
          {single ? <FileIcon entry={single} size={22} /> : null}
          <h2>{title} Properties</h2>
          <span className="modal-sub" />
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="props-body">
          {single && (
            <>
              {row('Type', typeLabel(single))}
              {row('Location', single.path.replace(/[\\/][^\\/]*$/, '') || '/')}
            </>
          )}
          {row(
            'Size',
            size && !size.loading
              ? `${formatSize(size.size)}${size.size >= 1000 ? ` (${size.size.toLocaleString()} bytes)` : ''}${size.truncated ? ' — partial' : ''}`
              : 'Calculating…'
          )}
          {info && info.sizeOnDisk != null && !info.isDir && row('Size on disk', formatSize(info.sizeOnDisk))}
          {size && !size.loading && (entries.some((e) => e.isDir) || entries.length > 1) &&
            row('Contains', plural(size.count, 'file'))}
          {info && (
            <>
              {info.target && row('Link to', info.target)}
              {row('Created', formatDate(info.created))}
              {row('Modified', formatDate(info.modified))}
              {row('Accessed', formatDate(info.accessed))}
            </>
          )}
          {!info && single && remote && row('Modified', formatDate(single.mtime))}
          {info && !isWin && row('Permissions', `${info.modeText} (${info.mode.toString(8)})`)}
          {!remote && (
            <div className="prop-attrs">
              <span className="prop-key">Attributes</span>
              <label>
                <input type="checkbox" checked={!!(info && info.readOnly)} disabled={!info && !!single} onChange={(e) => setAttr('readOnly', e.target.checked)} />
                Read-only
              </label>
              <label>
                <input type="checkbox" checked={!!(info && info.hidden)} disabled={!info && !!single} onChange={(e) => setAttr('hidden', e.target.checked)} />
                Hidden
              </label>
            </div>
          )}
          {error && <div className="connect-error" role="alert">{error}</div>}
        </div>
        <footer className="modal-foot">
          <span>{isMac ? '' : ''}</span>
          <button className="btn primary" onClick={onClose} autoFocus>OK</button>
        </footer>
      </div>
    </div>
  );
}

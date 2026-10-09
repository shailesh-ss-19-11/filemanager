import { X } from 'lucide-react';
import { useTransfers } from '../lib/transferStore.js';
import { formatSize } from '../lib/fileUtils.js';

function eta(t) {
  if (!t.total || !t.done || !t.elapsed) return '';
  const rate = t.done / (t.elapsed / 1000);
  if (rate <= 0) return '';
  const s = Math.max(0, Math.round((t.total - t.done) / rate));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s left` : `${s} s left`;
}

export default function TransferPanel({ onCancel, onResume, onDiscard }) {
  const transfers = useTransfers();
  if (!transfers.length) return null;
  return (
    <div className="transfers" aria-live="polite">
      {transfers.map((t) => {
        const items = t.unit === 'items';
        // one big item (a folder) can't report a percentage: show a moving bar instead of an empty one
        const pct = t.total && !(items && t.total === 1) ? Math.min(100, (t.done / t.total) * 100) : null;
        const rate = !items && t.elapsed ? t.done / (t.elapsed / 1000) : 0;
        if (t.interrupted) {
          return (
            <div className="transfer interrupted" key={t.id}>
              <div className="transfer-top">
                <span className="transfer-title">Copy interrupted — phone disconnected</span>
              </div>
              <div className="transfer-meta">
                <span>
                  {formatSize(t.done)}
                  {t.total ? ` of ${formatSize(t.total)}` : ''} copied. Reconnect and unlock the phone, then resume.
                </span>
              </div>
              <div className="transfer-actions">
                <button className="btn primary" onClick={() => onResume(t.id)}>
                  Resume
                </button>
                <button className="btn" onClick={() => onDiscard(t.id)}>
                  Discard
                </button>
              </div>
            </div>
          );
        }
        return (
          <div className="transfer" key={t.id}>
            <div className="transfer-top">
              <span className="transfer-title" title={t.current}>
                {t.label || (t.mode === 'cut' ? 'Moving' : 'Copying')} {t.items > 1 ? `${t.items} items` : t.current ? `“${t.current}”` : ''}
              </span>
              <button className="icon-btn small" onClick={() => onCancel(t.id)} aria-label="Cancel" title="Cancel">
                <X size={14} />
              </button>
            </div>
            <div className={`transfer-bar${pct == null ? ' indeterminate' : ''}`}>
              <span style={pct == null ? undefined : { width: `${pct}%` }} />
            </div>
            <div className="transfer-meta">
              {t.items > 1 && t.current && <span>{t.current}</span>}
              {items ? (
                <span>
                  {t.done} of {t.total} {t.total === 1 ? 'item' : 'items'}
                  {t.sub > 0 ? ` · ${t.sub.toLocaleString()} files removed from this folder` : ''}
                </span>
              ) : (
                <span>
                  {formatSize(t.done)}
                  {t.total ? ` of ${formatSize(t.total)}` : ''}
                  {rate > 0 ? ` · ${formatSize(rate)}/s` : ''}
                  {eta(t) ? ` · ${eta(t)}` : ''}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

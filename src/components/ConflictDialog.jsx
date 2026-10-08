import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

/** "These names already exist" — Replace / Keep both / Skip. */
export default function ConflictDialog({ names, onChoose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onChoose(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose]);

  const shown = names.slice(0, 6);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onChoose(null)}>
      <div className="modal confirm" role="alertdialog" aria-label="Name conflict">
        <header className="modal-head">
          <AlertTriangle size={18} />
          <h2>{names.length === 1 ? 'An item with this name already exists' : `${names.length} items already exist here`}</h2>
        </header>
        <div className="connect-body">
          <ul className="conflict-list">
            {shown.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {names.length > shown.length && <li>…and {names.length - shown.length} more</li>}
          </ul>
        </div>
        <footer className="modal-foot conflict-actions">
          <button className="btn" onClick={() => onChoose(null)}>Cancel</button>
          <span />
          <button className="btn" onClick={() => onChoose('skip')}>Skip</button>
          <button className="btn" onClick={() => onChoose('keep')} autoFocus>Keep both</button>
          <button className="btn danger" onClick={() => onChoose('replace')}>Replace</button>
        </footer>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import FileIcon from './FileIcon.jsx';
import { formatDate, formatSize, isRemotePath, typeLabel } from '../lib/fileUtils.js';

function SheetView({ sheets }) {
  const [i, setI] = useState(0);
  const sh = sheets[i] || sheets[0];
  if (!sh) return <div className="preview-msg">This workbook has no sheets.</div>;
  return (
    <div className="preview-sheet">
      {sheets.length > 1 && (
        <div className="sheet-tabs" role="tablist">
          {sheets.map((s, n) => (
            <button key={s.name} role="tab" aria-selected={n === i} className={n === i ? 'active' : ''} onClick={() => setI(n)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-scroll">
        <table>
          <tbody>
            {sh.rows.map((r, ri) => (
              <tr key={ri}>
                <th>{ri + 1}</th>
                {r.map((c, ci) => (
                  <td key={ci}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {(sh.totalRows > sh.rows.length || sh.totalCols > (sh.rows[0] || []).length) && (
          <div className="sheet-more">
            Showing {sh.rows.length} of {sh.totalRows} rows and {(sh.rows[0] || []).length} of {sh.totalCols} columns.
          </div>
        )}
      </div>
    </div>
  );
}

/** Space-bar preview (images, video, audio, PDF, text). ←/→ move through the folder; Space/Esc close. */
export default function PreviewDialog({ entries, startPath, onClose, onOpen, onSelect }) {
  const api = window.fsApi;
  const [index, setIndex] = useState(Math.max(0, entries.findIndex((e) => e.path === startPath)));
  const [src, setSrc] = useState({ loading: true });
  const entry = entries[index];

  useEffect(() => {
    let cancelled = false;
    setSrc({ loading: true });
    api.previewSource(entry.path, { size: entry.size, mtime: entry.mtime }).then((r) => {
      if (!cancelled) setSrc(r.ok ? r : { error: r.error });
    });
    onSelect(entry.path);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path]);

  useEffect(() => {
    const go = (d) => setIndex((i) => Math.max(0, Math.min(entries.length - 1, i + d)));
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        go(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onOpen(entry);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entries.length, entry, onClose, onOpen]);

  let body;
  if (src.loading) {
    body = (
      <div className="preview-msg">
        {isRemotePath(entry.path) ? `Loading “${entry.name}” from the phone…` : 'Loading…'}
      </div>
    );
  } else if (src.error) {
    body = <div className="preview-msg">{src.error}</div>;
  } else if (src.kind === 'image') {
    body = <img className="preview-media" src={src.url} alt={entry.name} />;
  } else if (src.kind === 'video') {
    body = <video className="preview-media" src={src.url} controls autoPlay />;
  } else if (src.kind === 'audio') {
    body = (
      <div className="preview-msg">
        <FileIcon entry={entry} size={64} />
        <audio src={src.url} controls autoPlay />
      </div>
    );
  } else if (src.kind === 'pdf') {
    body = <iframe className="preview-media preview-pdf" src={src.url} title={entry.name} />;
  } else if (src.kind === 'docx') {
    body = <div className="preview-doc" dangerouslySetInnerHTML={{ __html: src.html || '<p>(empty document)</p>' }} />;
  } else if (src.kind === 'sheet') {
    body = <SheetView sheets={src.sheets} />;
  } else if (src.kind === 'thumb') {
    body = <img className="preview-media" src={src.image} alt={entry.name} />;
  } else if (src.kind === 'slides') {
    body = (
      <div className="preview-slides">
        {src.image && <img className="preview-slide-img" src={src.image} alt="First slide" />}
        {src.slides.map((paras, i) => (
          <div className="preview-slide" key={i}>
            <div className="preview-slide-n">Slide {i + 1}</div>
            {paras.length ? paras.map((p, j) => <p key={j}>{p}</p>) : <p className="muted">(no text)</p>}
          </div>
        ))}
      </div>
    );
  } else if (src.kind === 'text') {
    body = (
      <pre className="preview-text">
        {src.text}
        {src.truncated ? '\n\n… (showing the first 1 MB)' : ''}
      </pre>
    );
  } else {
    body = (
      <div className="preview-msg">
        <FileIcon entry={entry} size={64} />
        <div>{src.note || 'No preview for this file type.'}</div>
        <button className="btn primary" onClick={() => onOpen(entry)}>Open</button>
      </div>
    );
  }

  return (
    <div className="modal-backdrop preview" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal preview-modal" role="dialog" aria-label={`Preview of ${entry.name}`}>
        <header className="modal-head">
          <FileIcon entry={entry} size={20} />
          <h2 title={entry.name}>{entry.name}</h2>
          <span className="modal-sub">
            {typeLabel(entry)} · {formatSize(entry.size)} · {formatDate(entry.mtime)}
          </span>
          <button className="icon-btn" onClick={() => onOpen(entry)} aria-label="Open" title="Open (Enter)"><ExternalLink size={16} /></button>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Space)"><X size={16} /></button>
        </header>
        <div className="preview-body" data-kind={src.kind || ''}>{body}</div>
        <footer className="modal-foot">
          <button className="icon-btn" disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label="Previous"><ChevronLeft size={16} /></button>
          <span>{index + 1} of {entries.length}</span>
          <button className="icon-btn" disabled={index === entries.length - 1} onClick={() => setIndex(index + 1)} aria-label="Next"><ChevronRight size={16} /></button>
        </footer>
      </div>
    </div>
  );
}

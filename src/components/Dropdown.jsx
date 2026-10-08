import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/**
 * Button + popover. `sections` is an array of arrays of
 * { label, checked, onSelect, keepOpen }; sections are separated by dividers.
 */
export default function Dropdown({ icon, label, value, sections, title }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    const onBlur = () => setOpen(false);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        className="cmd-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
      >
        {icon}
        <span>
          {label}
          {value ? <span className="dd-value">: {value}</span> : null}
        </span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="dd-menu" role="menu">
          {sections.map((items, si) => (
            <div key={si} className="dd-section">
              {items.map((it) => (
                <button
                  key={it.label}
                  role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={it.checked === undefined ? undefined : !!it.checked}
                  className="dd-item"
                  disabled={it.disabled}
                  onClick={() => {
                    it.onSelect();
                    if (!it.keepOpen) setOpen(false);
                  }}
                >
                  <span className="dd-check">{it.checked ? <Check size={14} /> : null}</span>
                  {it.label}
                  {it.shortcut && <span className="dd-shortcut">{it.shortcut}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

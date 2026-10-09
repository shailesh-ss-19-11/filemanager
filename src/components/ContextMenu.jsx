import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** items: [{ label, shortcut, onClick, disabled, submenu: [items] }] or { separator: true } */
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [openSub, setOpenSub] = useState(-1);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 6;
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - height - pad)),
    });
  }, [x, y, items]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close);
    };
  }, [onClose]);

  return (
    <div
      className="context-menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="cm-sep" role="separator" />
        ) : it.submenu ? (
          <div key={i} className="cm-sub-wrap" onMouseEnter={() => setOpenSub(i)} onMouseLeave={() => setOpenSub(-1)}>
            <button role="menuitem" aria-haspopup="menu" className="cm-item" onClick={() => setOpenSub(i)}>
              <span className="cm-label">{it.label}</span>
              <span className="cm-shortcut">▸</span>
            </button>
            {openSub === i && (
              <div className="context-menu cm-submenu" role="menu">
                {it.submenu.map((sub, j) =>
                  sub.separator ? (
                    <div key={j} className="cm-sep" role="separator" />
                  ) : (
                    <button
                      key={j}
                      role="menuitem"
                      className="cm-item"
                      disabled={sub.disabled}
                      onClick={() => {
                        onClose();
                        sub.onClick();
                      }}
                    >
                      <span className="cm-label">{sub.label}</span>
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className="cm-item"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span className="cm-label">{it.label}</span>
            {it.shortcut && <span className="cm-shortcut">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  );
}

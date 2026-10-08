import { useEffect, useState } from 'react';
import { Smartphone, X } from 'lucide-react';

export default function ConnectDialog({ onClose, onConnected }) {
  const [form, setForm] = useState({ name: '', host: '', port: '2121', user: '', password: '', secure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await window.fsApi.ftpAdd(form);
    setBusy(false);
    if (r.ok) onConnected(r.connection);
    else setError(r.error);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal connect" role="dialog" aria-label="Connect to phone" onSubmit={submit}>
        <header className="modal-head">
          <Smartphone size={18} />
          <h2>Connect to phone (FTP)</h2>
          <span className="modal-sub" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="connect-body">
          <ol className="connect-steps">
            <li>Connect the phone and this computer to the <b>same Wi-Fi</b>.</li>
            <li>
              On the phone, install a free FTP server app (for example “WiFi FTP Server” or “FTP Server” on Google
              Play) and tap <b>Start</b>.
            </li>
            <li>
              The app shows an address like <code>ftp://192.168.1.20:2221</code>. The numbers before the colon are
              the <b>IP address</b> (192.168.1.20) and the number after it is the <b>port</b> (2221).
            </li>
            <li>Type those two values below. If the app shows a username and password, enter them too; otherwise leave them empty.</li>
          </ol>
          <p className="connect-hint">Prefer no Wi-Fi? Plug the phone in by USB (File transfer mode) and it appears in the sidebar automatically.</p>
          <label>Name <input value={form.name} onChange={set('name')} placeholder="My phone" /></label>
          <div className="connect-row">
            <label>IP address <input value={form.host} onChange={set('host')} placeholder="192.168.1.20" autoFocus required /></label>
            <label className="port">Port <input value={form.port} onChange={set('port')} inputMode="numeric" /></label>
          </div>
          <label>Username <input value={form.user} onChange={set('user')} placeholder="leave empty for anonymous" autoComplete="off" /></label>
          <label>Password <input type="password" value={form.password} onChange={set('password')} autoComplete="off" /></label>
          <label className="check"><input type="checkbox" checked={form.secure} onChange={set('secure')} /> Use FTPS (secure)</label>
          {error && <div className="connect-error" role="alert">{error}</div>}
        </div>
        <footer className="modal-foot">
          <span />
          <button className="btn primary" disabled={busy || !form.host.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
        </footer>
      </form>
    </div>
  );
}

import { Download, FileText, HardDrive, Home, Image, Monitor, Music, Video, Folder, Pin, Smartphone, Sparkles, X } from 'lucide-react';
import logo from '../assets/logo.png';
import { formatSize, isMac, pathIsInside, samePath } from '../lib/fileUtils.js';
import { useDiskSpace } from '../lib/useDiskSpace.js';

const ICONS = {
  home: Home,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  music: Music,
  videos: Video,
};

const dropAttrs = (dnd, p) =>
  dnd && {
    onDragOver: (e) => dnd.over(p, e),
    onDragLeave: (e) => dnd.leave(p, e),
    onDrop: (e) => dnd.drop(p, e),
  };

function DriveItem({ dnd, drive, active, onNavigate, reloadTick, icon: Icon = HardDrive }) {
  const space = useDiskSpace(drive.path, reloadTick);
  const pct = space && space.total ? Math.min(100, (space.used / space.total) * 100) : 0;
  return (
    <button
      {...dropAttrs(dnd, drive.path)}
      className={`side-item drive${active ? ' active' : ''}${dnd && dnd.dropPath === drive.path ? ' drop-target' : ''}`}
      onClick={() => onNavigate(drive.path)}
      title={space ? `${formatSize(space.free)} free of ${formatSize(space.total)}` : drive.path}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={16} />
      <span className="drive-info">
        <span className="drive-name">{drive.name}</span>
        {space && (
          <>
            <span className="drive-bar" aria-hidden="true">
              <span className={`drive-fill${pct >= 90 ? ' full' : ''}`} style={{ width: `${pct}%` }} />
            </span>
            <span className="drive-text">
              {formatSize(space.free)} free of {formatSize(space.total)}
            </span>
          </>
        )}
      </span>
    </button>
  );
}

export default function Sidebar({ reloadTick, dnd, pins = [], onUnpin, quick, drives, currentPath, onNavigate, onCleanup, usbPhone, connections = [], onConnect, onDisconnect }) {
  const Item = ({ icon: Icon, label, path, title }) => {
    const active = currentPath && samePath(currentPath, path);
    return (
      <button
        {...dropAttrs(dnd, path)}
        className={`side-item${active ? ' active' : ''}${dnd && dnd.dropPath === path ? ' drop-target' : ''}`}
        onClick={() => onNavigate(path)}
        title={title || path}
        aria-current={active ? 'page' : undefined}
      >
        <Icon size={16} />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <nav className="sidebar" aria-label="Locations">
      <div className="brand">
        <img src={logo} alt="" width="26" height="26" draggable="false" />
        <span>File Manager</span>
      </div>
      <div className="side-heading">{isMac ? 'Favorites' : 'Quick access'}</div>
      {quick.map((q) => (
        <Item key={q.key} icon={ICONS[q.key] || Folder} label={q.label} path={q.path} />
      ))}
      {pins.length > 0 && <div className="side-heading">Pinned</div>}
      {pins.map((p) => (
        <div key={p.path} className="side-row">
          <Item icon={Pin} label={p.name} path={p.path} />
          <button className="icon-btn small side-x" onClick={() => onUnpin(p)} aria-label={`Unpin ${p.name}`} title="Unpin">
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="side-heading">{isMac ? 'Locations' : 'This PC'}</div>
      {drives.length === 0 && <div className="side-empty">No drives found</div>}
      {drives.map((d) => (
        <DriveItem
          reloadTick={reloadTick}
          dnd={dnd}
          key={d.path}
          drive={d}
          active={currentPath && samePath(currentPath, d.path)}
          onNavigate={onNavigate}
        />
      ))}
      <div className="side-heading">Phone</div>
      {usbPhone && (
        <DriveItem
          reloadTick={reloadTick}
          dnd={dnd}
          drive={{ name: `${usbPhone.name} (USB)`, path: usbPhone.path }}
          icon={Smartphone}
          active={currentPath && pathIsInside(currentPath, usbPhone.path)}
          onNavigate={onNavigate}
        />
      )}
      {connections.map((c) => (
        <div key={c.id} className="side-row">
          <button
            className={`side-item${currentPath && pathIsInside(currentPath, c.path) ? ' active' : ''}`}
            onClick={() => onNavigate(c.path)}
            title={`ftp://${c.host}:${c.port}`}
          >
            <Smartphone size={16} />
            <span>{c.name}</span>
          </button>
          <button className="icon-btn small side-x" onClick={() => onDisconnect(c)} aria-label={`Remove ${c.name}`} title="Remove connection">
            <X size={13} />
          </button>
        </div>
      ))}
      <button className="side-item" onClick={onConnect} title="Browse a phone running an FTP server over Wi-Fi">
        <Smartphone size={16} />
        <span>Connect to phone…</span>
      </button>
      <div className="side-heading">Storage</div>
      <button className="side-item" onClick={onCleanup} title="Find large files, duplicates and installers in this folder">
        <Sparkles size={16} />
        <span>Clean up this folder</span>
      </button>
    </nav>
  );
}

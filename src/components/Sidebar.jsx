import { Download, FileText, HardDrive, Home, Image, Monitor, Music, Video, Folder } from 'lucide-react';
import { isMac, samePath } from '../lib/fileUtils.js';

const ICONS = {
  home: Home,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  music: Music,
  videos: Video,
};

export default function Sidebar({ quick, drives, currentPath, onNavigate }) {
  const Item = ({ icon: Icon, label, path, title }) => {
    const active = currentPath && samePath(currentPath, path);
    return (
      <button
        className={`side-item${active ? ' active' : ''}`}
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
      <div className="side-heading">{isMac ? 'Favorites' : 'Quick access'}</div>
      {quick.map((q) => (
        <Item key={q.key} icon={ICONS[q.key] || Folder} label={q.label} path={q.path} />
      ))}
      <div className="side-heading">{isMac ? 'Locations' : 'This PC'}</div>
      {drives.length === 0 && <div className="side-empty">No drives found</div>}
      {drives.map((d) => (
        <Item key={d.path} icon={HardDrive} label={d.name} path={d.path} />
      ))}
    </nav>
  );
}

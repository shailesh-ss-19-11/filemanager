import {
  Folder,
  Image as ImageIcon,
  Film,
  Music,
  FileText,
  Archive,
  FileCode,
  AppWindow,
  File as FileGeneric,
} from 'lucide-react';
import { getKind } from '../lib/fileUtils.js';

const ICONS = {
  folder: Folder,
  image: ImageIcon,
  video: Film,
  audio: Music,
  document: FileText,
  archive: Archive,
  code: FileCode,
  app: AppWindow,
  other: FileGeneric,
};

export default function FileIcon({ entry, size = 16, kind }) {
  const k = kind || getKind(entry);
  const Icon = ICONS[k] || FileGeneric;
  return (
    <span className={`kind-icon kind-${k}`} aria-hidden="true">
      <Icon size={size} strokeWidth={k === 'folder' ? 1.75 : 1.5} fill={k === 'folder' ? 'currentColor' : 'none'} fillOpacity={0.2} />
    </span>
  );
}

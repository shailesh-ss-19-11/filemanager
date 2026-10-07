/* Filters, sorting, grouping, path helpers and formatting. Pure functions only. */

export const platform = (typeof window !== 'undefined' && window.fsApi && window.fsApi.platform) || 'win32';
export const isMac = platform === 'darwin';
export const isWin = platform === 'win32';

/* ------------------------------------------------------------------ */
/* Kinds                                                               */
/* ------------------------------------------------------------------ */

const ext = (s) => new Set(s.split(/\s+/).filter(Boolean));

const KIND_EXTS = {
  image: ext('jpg jpeg png gif bmp webp svg ico tif tiff heic heif avif raw cr2 nef arw dng psd ai eps'),
  video: ext('mp4 mkv mov avi wmv flv webm m4v mpg mpeg 3gp ts m2ts vob'),
  audio: ext('mp3 wav flac aac ogg oga m4a wma aiff aif opus mid midi'),
  document: ext(
    'pdf doc docx odt rtf txt md pages xls xlsx ods csv numbers ppt pptx odp key epub mobi tex log pub vsd vsdx'
  ),
  archive: ext('zip rar 7z tar gz tgz bz2 xz zst cab iso lz lzma z'),
  code: ext(
    'js jsx mjs cjs ts tsx json html htm css scss sass less py rb go rs java kt swift c h cpp hpp cc cs php sh bash zsh ps1 bat cmd sql yml yaml toml xml vue svelte lua pl r dart gradle ini conf'
  ),
  app: ext('exe msi app dmg pkg apk deb rpm appimage bat com scr'),
};
// "bat" belongs to both code and app lists; installers win only for the clear cases
KIND_EXTS.app.delete('bat');

export const KINDS = [
  { id: 'folder', label: 'Folders' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Music & audio' },
  { id: 'document', label: 'Documents' },
  { id: 'archive', label: 'Archives' },
  { id: 'code', label: 'Code' },
  { id: 'app', label: 'Apps & installers' },
  { id: 'other', label: 'Other' },
];

export const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]));

export function getKind(entry) {
  if (entry.isDir) return 'folder';
  const e = entry.extension;
  if (!e) return 'other';
  for (const id of ['image', 'video', 'audio', 'document', 'archive', 'code', 'app']) {
    if (KIND_EXTS[id].has(e)) return id;
  }
  return 'other';
}

export function typeLabel(entry) {
  if (entry.isDir) return isWin ? 'File folder' : 'Folder';
  if (entry.extension === 'app') return 'Application';
  if (!entry.extension) return 'File';
  return `${entry.extension.toUpperCase()} File`;
}

/* ------------------------------------------------------------------ */
/* Size & date buckets                                                 */
/* ------------------------------------------------------------------ */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export const SIZE_BUCKETS = [
  { id: 'empty', label: 'Empty', hint: '0 bytes', test: (s) => s === 0 },
  { id: 'tiny', label: 'Tiny', hint: '≤ 16 KB', test: (s) => s > 0 && s <= 16 * KB },
  { id: 'small', label: 'Small', hint: '16 KB – 1 MB', test: (s) => s > 16 * KB && s <= MB },
  { id: 'medium', label: 'Medium', hint: '1 – 128 MB', test: (s) => s > MB && s <= 128 * MB },
  { id: 'large', label: 'Large', hint: '128 MB – 1 GB', test: (s) => s > 128 * MB && s <= GB },
  { id: 'huge', label: 'Huge', hint: '1 – 4 GB', test: (s) => s > GB && s <= 4 * GB },
  { id: 'gigantic', label: 'Gigantic', hint: '> 4 GB', test: (s) => s > 4 * GB },
];

export function sizeBucketOf(size) {
  return SIZE_BUCKETS.find((b) => b.test(size)) || SIZE_BUCKETS[0];
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

const DAY = 86400000;

export const DATE_BUCKETS = [
  { id: 'today', label: 'Today', test: (t, now) => t >= startOfDay(now) },
  {
    id: 'yesterday',
    label: 'Yesterday',
    test: (t, now) => t >= startOfDay(now) - DAY && t < startOfDay(now),
  },
  { id: 'week', label: 'Last 7 days', test: (t, now) => t >= startOfDay(now) - 6 * DAY },
  { id: 'month', label: 'Last 30 days', test: (t, now) => t >= startOfDay(now) - 29 * DAY },
  {
    id: 'year',
    label: 'This year',
    test: (t, now) => t >= new Date(new Date(now).getFullYear(), 0, 1).getTime(),
  },
  {
    id: 'older',
    label: 'Before this year',
    test: (t, now) => t < new Date(new Date(now).getFullYear(), 0, 1).getTime(),
  },
];

// Buckets used by "Group by date": mutually exclusive, ordered newest first.
const DATE_GROUPS = [
  { id: 'today', label: 'Today', test: (t, n) => t >= startOfDay(n) },
  { id: 'yesterday', label: 'Yesterday', test: (t, n) => t >= startOfDay(n) - DAY },
  { id: 'week', label: 'Earlier this week', test: (t, n) => t >= startOfDay(n) - 6 * DAY },
  { id: 'month', label: 'Earlier this month', test: (t, n) => t >= startOfDay(n) - 29 * DAY },
  {
    id: 'year',
    label: 'Earlier this year',
    test: (t, n) => t >= new Date(new Date(n).getFullYear(), 0, 1).getTime(),
  },
  { id: 'older', label: 'A long time ago', test: () => true },
];

/* ------------------------------------------------------------------ */
/* Name matching (wildcards)                                           */
/* ------------------------------------------------------------------ */

/** Plain text = case-insensitive substring. With * or ? it becomes a glob over the whole name. */
export function makeNameMatcher(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return null;
  if (!/[*?]/.test(q)) return (name) => name.toLowerCase().includes(q);
  const re = new RegExp(
    '^' +
      q
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i'
  );
  return (name) => re.test(name);
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

export const emptyFilters = () => ({
  kinds: new Set(),
  sizes: new Set(),
  dates: new Set(),
  exts: new Set(),
  dateField: 'mtime', // 'mtime' | 'birthtime'
  showHidden: false,
});

export function countActiveFilters(f) {
  return f.kinds.size + f.sizes.size + f.dates.size + f.exts.size;
}

function passes(entry, f, matcher, now, skip) {
  if (!f.showHidden && entry.hidden) return false;
  if (matcher && !matcher(entry.name)) return false;
  if (skip !== 'kinds' && f.kinds.size && !f.kinds.has(getKind(entry))) return false;
  if (skip !== 'sizes' && f.sizes.size) {
    if (entry.isDir) return false; // size ranges apply to files only
    let ok = false;
    for (const id of f.sizes) {
      const b = SIZE_BUCKETS.find((x) => x.id === id);
      if (b && b.test(entry.size)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  if (skip !== 'dates' && f.dates.size) {
    const t = entry[f.dateField] || 0;
    let ok = false;
    for (const id of f.dates) {
      const b = DATE_BUCKETS.find((x) => x.id === id);
      if (b && b.test(t, now)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  if (skip !== 'exts' && f.exts.size && !(entry.extension && f.exts.has(entry.extension))) return false;
  return true;
}

export function applyFilters(entries, filters, search) {
  const matcher = makeNameMatcher(search);
  const now = Date.now();
  return entries.filter((e) => passes(e, filters, matcher, now, null));
}

/**
 * Live chip counts. Each group's counts are computed with the *other* groups' filters
 * applied (faceted), so a chip's number is what you'd get by adding it.
 */
export function computeCounts(entries, filters, search) {
  const matcher = makeNameMatcher(search);
  const now = Date.now();
  const kinds = {};
  const sizes = {};
  const dates = {};
  const exts = {};

  for (const e of entries) {
    if (passes(e, filters, matcher, now, 'kinds')) {
      const k = getKind(e);
      kinds[k] = (kinds[k] || 0) + 1;
    }
    if (!e.isDir && passes(e, filters, matcher, now, 'sizes')) {
      for (const b of SIZE_BUCKETS) {
        if (b.test(e.size)) {
          sizes[b.id] = (sizes[b.id] || 0) + 1;
          break;
        }
      }
    }
    if (passes(e, filters, matcher, now, 'dates')) {
      const t = e[filters.dateField] || 0;
      for (const b of DATE_BUCKETS) {
        if (b.test(t, now)) dates[b.id] = (dates[b.id] || 0) + 1;
      }
    }
    if (e.extension && passes(e, filters, matcher, now, 'exts')) {
      exts[e.extension] = (exts[e.extension] || 0) + 1;
    }
  }

  // Extension list: every extension in the folder (so selected ones with 0 matches stay visible).
  const allExts = {};
  for (const e of entries) {
    if (!e.extension) continue;
    if (!filters.showHidden && e.hidden) continue;
    allExts[e.extension] = true;
  }
  const extList = Object.keys(allExts)
    .map((x) => ({ ext: x, count: exts[x] || 0 }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));

  return { kinds, sizes, dates, extList };
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const SORT_KEYS = [
  { id: 'name', label: 'Name' },
  { id: 'size', label: 'Size' },
  { id: 'type', label: 'Type' },
  { id: 'mtime', label: 'Date modified' },
  { id: 'birthtime', label: 'Date created' },
  { id: 'extension', label: 'Extension' },
];

function compareBy(key, a, b) {
  switch (key) {
    case 'size':
      return a.size - b.size;
    case 'type':
      return collator.compare(typeLabel(a), typeLabel(b));
    case 'mtime':
      return a.mtime - b.mtime;
    case 'birthtime':
      return a.birthtime - b.birthtime;
    case 'extension':
      return collator.compare(a.extension, b.extension);
    case 'name':
    default:
      return collator.compare(a.name, b.name);
  }
}

export function sortEntries(entries, { key, dir, foldersFirst }) {
  const mul = dir === 'desc' ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let c = compareBy(key, a, b);
    if (c === 0 && key !== 'name') c = collator.compare(a.name, b.name) * (mul === -1 ? -1 : 1);
    return c * mul;
  });
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

export const GROUP_KEYS = [
  { id: 'none', label: 'None' },
  { id: 'type', label: 'Type' },
  { id: 'size', label: 'Size' },
  { id: 'date', label: 'Date' },
];

/** `entries` must already be sorted; group order follows first appearance, except size/date follow natural order. */
export function groupEntries(entries, groupBy, dateField = 'mtime', sortDir = 'asc') {
  if (groupBy === 'none') return [{ id: 'all', label: null, items: entries }];
  const now = Date.now();
  const map = new Map();
  const order = [];
  const add = (id, label, rank, e) => {
    if (!map.has(id)) {
      map.set(id, { id, label, rank, items: [] });
      order.push(id);
    }
    map.get(id).items.push(e);
  };

  for (const e of entries) {
    if (groupBy === 'type') {
      const k = getKind(e);
      add(k, KIND_LABEL[k], KINDS.findIndex((x) => x.id === k), e);
    } else if (groupBy === 'size') {
      if (e.isDir) add('folders', 'Folders', -1, e);
      else {
        const b = sizeBucketOf(e.size);
        add(b.id, `${b.label} (${b.hint})`, SIZE_BUCKETS.indexOf(b), e);
      }
    } else if (groupBy === 'date') {
      const t = e[dateField] || 0;
      const idx = DATE_GROUPS.findIndex((g) => g.test(t, now));
      add(DATE_GROUPS[idx].id, DATE_GROUPS[idx].label, idx, e);
    }
  }

  const groups = order.map((id) => map.get(id));
  if (groupBy === 'type' || groupBy === 'date') groups.sort((a, b) => a.rank - b.rank);
  else if (groupBy === 'size') {
    groups.sort((a, b) => (sortDir === 'desc' ? b.rank - a.rank : a.rank - b.rank));
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export const isWindowsPath = (p) => /^[A-Za-z]:[\\/]?/.test(p) || p.startsWith('\\\\');
export const sepFor = (p) => (isWindowsPath(p) ? '\\' : '/');

export function joinPath(dir, name) {
  const sep = sepFor(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export function dirname(p) {
  const sep = sepFor(p);
  const trimmed = p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf(sep);
  if (i < 0) return p;
  if (i === 0) return sep;
  const parent = trimmed.slice(0, i);
  if (sep === '\\' && /^[A-Za-z]:$/.test(parent)) return parent + '\\';
  return parent;
}

export function basename(p) {
  const sep = sepFor(p);
  const trimmed = p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf(sep);
  return i < 0 ? trimmed : trimmed.slice(i + 1) || trimmed;
}

export function parentPath(p) {
  return dirname(p);
}

export function isRootPath(p) {
  return dirname(p) === p;
}

export function samePath(a, b) {
  if (isWindowsPath(a) || isWindowsPath(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function pathIsInside(child, parent) {
  const sep = sepFor(parent);
  const c = isWindowsPath(child) ? child.toLowerCase() : child;
  const p0 = isWindowsPath(parent) ? parent.toLowerCase() : parent;
  const p = p0.endsWith(sep) ? p0 : p0 + sep;
  return c === p0 || c.startsWith(p);
}

/** Breadcrumb parts: [{ name, path }] from the root down. */
export function splitPath(p) {
  if (!p) return [];
  if (isWindowsPath(p)) {
    if (p.startsWith('\\\\')) {
      const segs = p.split('\\').filter(Boolean);
      const out = [];
      let acc = '\\\\' + segs[0];
      out.push({ name: segs[0], path: acc + '\\' });
      for (const s of segs.slice(1)) {
        acc += '\\' + s;
        out.push({ name: s, path: acc });
      }
      return out;
    }
    const segs = p.split(/[\\/]/).filter(Boolean);
    const out = [{ name: segs[0], path: segs[0] + '\\' }];
    let acc = segs[0];
    for (const s of segs.slice(1)) {
      acc += '\\' + s;
      out.push({ name: s, path: acc });
    }
    return out;
  }
  const segs = p.split('/').filter(Boolean);
  const out = [{ name: '/', path: '/' }];
  let acc = '';
  for (const s of segs) {
    acc += '/' + s;
    out.push({ name: s, path: acc });
  }
  return out;
}

/** Split into [stem, extension-with-dot] for rename preselection. */
export function splitNameExt(entry) {
  if (entry.isDir) return [entry.name, ''];
  const i = entry.name.lastIndexOf('.');
  if (i <= 0) return [entry.name, ''];
  return [entry.name.slice(0, i), entry.name.slice(i)];
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < KB) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / KB;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatDate(ts) {
  if (!ts) return '';
  return dateFmt.format(new Date(ts));
}

export function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

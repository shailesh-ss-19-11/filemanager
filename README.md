# File Manager

A cross-platform desktop file manager for macOS and Windows built with **Electron**, **React 18** and **Vite**. It aims to feel like Windows File Explorer / macOS Finder, with strong filtering and sorting. Plain CSS, `lucide-react` icons, no UI framework.

## Setup

```bash
npm install
npm run dev        # starts Vite and Electron together (concurrently + wait-on)
```

Requires Node 18+.

## Build

| Command | Output |
| --- | --- |
| `npm run build` | Production renderer bundle in `dist/` |
| `npm start` | Build, then run the packaged-style app locally |
| `npm run dist:mac` | macOS `dmg` and `zip` in `release/` (run on a Mac) |
| `npm run dist:win` | Windows `nsis` installer and `portable` exe in `release/` |

## Security model

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. All filesystem and shell work happens in the main process behind `ipcMain.handle`. The preload script exposes a small API as `window.fsApi`; the renderer never touches Node directly.

## Features

**Navigation** — tabs with per-tab history (middle-click closes), back/forward/up/refresh, clickable breadcrumbs that turn into an editable path field (Enter to go, Esc to cancel), sidebar with Quick access / This PC (Windows) or Favorites / Locations (macOS), drives polled every 5 s so USB drives appear, multiple windows, live folder watching.

**Search** — filters by name with wildcards (`*.pdf`, `IMG_??.jpg`). The subfolder toggle runs a breadth-first recursive search (3,000-result cap, cancellable, 300 ms debounce) and adds a *Folder* column.

**Sorting, grouping, filtering**
- Sort: name (natural), size, type, date modified, date created, extension; ascending/descending; folders-first toggle.
- Group: none, type, size bucket, date bucket — each with header and count.
- Filter panel with live counts: Kind, Size (Explorer's ranges, files only), Date (Modified/Created), Extension (searchable), Show hidden. OR within a group, AND across groups.

**Views** — Details (sortable column headers) and Icons (responsive grid, lazy OS thumbnails via `IntersectionObserver`, 2-line names).

**File operations** — new folder, inline rename (F2, extension not preselected), cut/copy/paste (duplicates become `name - Copy.ext` on Windows, `name copy.ext` on macOS; cross-drive moves fall back to copy-then-delete; pasting a folder into itself is blocked), move to Trash / Recycle Bin, folder size on demand, copy path, show in Finder/Explorer, open in default app (several at once).

**Selection & keyboard** — click, Ctrl/⌘-click, Shift-click ranges, arrow keys (Icons: up/down jump a row), Shift extends, Ctrl/⌘+A, Esc, Enter, F2, Delete / ⌘⌫, Backspace (Windows) / Alt+←/→/↑, F5. Handlers ignore events from text inputs. Cut items appear faded.

**Native menu** — platform-correct accelerators for New Window/Tab/Folder, Open, Close Tab, Cut/Copy/Paste/Select All, Find, Details/Icons, Filters, Show Hidden, Refresh, Back/Forward/Up/Home, Go to Address, Next/Previous Tab. Menu items are sent to the focused window; if a text input has focus, Cut/Copy/Paste/Select All act on the text instead of files.

**Design** — system font stacks, 13 px base, light/dark via `prefers-color-scheme`, teal-blue accent (`#0B6E99` / `#4FB3D9`), colour-coded file kinds, `content-visibility: auto` for large folders, visible focus rings, reduced-motion support.

## Folder structure

```
electron/
  main.js          IPC handlers, menu, windows, watchers, drive polling
  preload.js       contextBridge → window.fsApi
src/
  App.jsx          state, tabs, selection, commands, keyboard
  main.jsx         React entry
  styles.css       theme tokens and all styling
  lib/
    fileUtils.js   filters, sorting, grouping, path helpers, formatting
    useDirectory.js  directory / recursive-search loading hook
  components/
    TabBar.jsx  Toolbar.jsx  CommandBar.jsx  Sidebar.jsx  FilterPanel.jsx
    FileView.jsx  ContextMenu.jsx  Dropdown.jsx  FileIcon.jsx
```

## Notes

- Hidden files are dot-files on both platforms, plus well-known system entries (`$Recycle.Bin`, `desktop.ini`, …) on Windows. Windows' hidden file attribute is not read.
- OS thumbnails (`nativeImage.createThumbnailFromPath`) are only available on macOS and Windows; other file kinds fall back to icons.
- Installers are unsigned. Add code-signing configuration to the `build` section of `package.json` for distribution.

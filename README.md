# File Manager

[![Latest release](https://img.shields.io/github/v/release/shailesh-ss-19-11/filemanager?label=download&color=2f78d0)](https://github.com/shailesh-ss-19-11/filemanager/releases/latest)

A desktop file manager (Electron + React) with strong filtering and sorting, Windows-Explorer-style
file operations, free/used space, a clean-up tool, previews, and Android phone support over USB or Wi-Fi.

## Download

| Platform | Download |
|---|---|
| **macOS** (Apple silicon) | [**File-Manager-arm64.dmg**](https://github.com/shailesh-ss-19-11/filemanager/releases/latest/download/File-Manager-arm64.dmg) · [zip](https://github.com/shailesh-ss-19-11/filemanager/releases/latest/download/File-Manager-arm64.zip) |
| **Windows** (64-bit) | [**File-Manager-Setup-x64.exe**](https://github.com/shailesh-ss-19-11/filemanager/releases/latest/download/File-Manager-Setup-x64.exe) (installer) · [portable .exe](https://github.com/shailesh-ss-19-11/filemanager/releases/latest/download/File-Manager-Portable-x64.exe) |
| **Linux** (64-bit) | [**File-Manager-x86_64.AppImage**](https://github.com/shailesh-ss-19-11/filemanager/releases/latest/download/File-Manager-x86_64.AppImage) · [.deb](https://github.com/shailesh-ss-19-11/filemanager/releases/latest/download/File-Manager-amd64.deb) |
| All versions | [Releases page](https://github.com/shailesh-ss-19-11/filemanager/releases) |

**Install (macOS):** open the DMG and drag *File Manager* into *Applications*.
The app is not signed yet, so the first time: right-click it → **Open** → **Open**
(or run `xattr -dr com.apple.quarantine "/Applications/File Manager.app"`).

**Install (Windows):** run the installer. SmartScreen may warn because the app is not signed yet: *More info* → *Run anyway*.
**Install (Linux):** `chmod +x File-Manager-x86_64.AppImage && ./File-Manager-x86_64.AppImage`, or `sudo apt install ./File-Manager-amd64.deb`.

**Phone over USB** (macOS and Linux): install libmtp once (`brew install libmtp` / `sudo apt install libmtp9`), plug the phone in, unlock it and choose *File transfer*.
On Windows, use *Connect to phone…* (FTP over Wi-Fi) — Windows Explorer already shows USB phones itself.

---

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

## Phone, cleanup and file operations

- **Phone over USB (macOS/Linux):** `brew install libmtp`, then `npm run build:mtp`. Plug the phone in, unlock it and choose *File transfer*; it appears under **Phone** in the sidebar.
- **Phone over Wi-Fi (FTP):** start an FTP server app on the phone, then *Connect to phone…* and enter the IP and port it shows.
- **Explorer-style actions:** compress / extract, hide / unhide, properties, open with, copy to / move to, new file, undo (⌘Z), drag & drop, Space preview, pinned folders.

## Tests

```
npm test            # unit + engine tests (FTP server is started locally; phone tests skip without a phone)
npm run test:e2e    # drives the real app with Playwright (phone UI test skips without a phone)
```

## Publishing a release (maintainers)

Downloads are served from GitHub Releases. To build the app and publish it:

```bash
brew install libmtp      # once, so the phone helper can be built
gh auth login            # once
npm run release          # builds the .dmg/.zip on this Mac and uploads them to release v<version>
```

Windows and Linux builds come from GitHub Actions (`.github/workflows/release.yml`): push a tag
(`git tag v1.0.1 && git push --tags`) — or run the *Release* workflow by hand — and it builds the macOS, Windows
and Linux files and attaches them to that release. The *CI* workflow runs the tests on all three systems for every push.

Bump `version` in `package.json` first for a new release; running it again for the same version replaces the files.
The files are named `File-Manager-arm64.dmg` / `.zip`, so the "latest" links above always work.

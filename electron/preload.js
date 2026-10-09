const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('fsApi', {
  platform: process.platform,
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  // Reading
  listDir: (dir, fresh) => ipcRenderer.invoke('fs:list', dir, fresh),
  quickAccess: () => ipcRenderer.invoke('fs:quickAccess'),
  drives: (fresh) => ipcRenderer.invoke('fs:drives', fresh),
  onDrivesChanged: (cb) => subscribe('drives:changed', cb),
  search: (opts) => ipcRenderer.invoke('fs:search', opts),
  cancelSearch: (id) => ipcRenderer.send('fs:cancelSearch', id),
  diskSpace: (p) => ipcRenderer.invoke('fs:diskSpace', p),
  cacheScan: () => ipcRenderer.invoke('fs:cacheScan'),
  cleanScan: (root) => ipcRenderer.invoke('fs:cleanScan', root),
  folderSize: (dir) => ipcRenderer.invoke('fs:folderSize', dir),
  thumbnail: (opts) => ipcRenderer.invoke('fs:thumbnail', opts),

  // Watching
  watch: (dir) => ipcRenderer.send('fs:watch', dir),
  unwatch: () => ipcRenderer.send('fs:unwatch'),
  onChanged: (cb) => subscribe('fs:changed', cb),

  // Shell
  open: (paths, meta) => ipcRenderer.invoke('shell:open', paths, meta),
  editors: () => ipcRenderer.invoke('shell:editors'),
  openInEditor: (id, paths) => ipcRenderer.invoke('shell:openInEditor', id, paths),
  showInFolder: (p) => ipcRenderer.send('shell:showInFolder', p),
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  newWindow: (p) => ipcRenderer.send('window:new', p),
  copyText: (text) => ipcRenderer.send('clipboard:writeText', text),
  textEdit: (action) => ipcRenderer.send('edit:text', action),

  // Mutations
  newFolder: (dir) => ipcRenderer.invoke('fs:newFolder', dir),
  rename: (p, newName) => ipcRenderer.invoke('fs:rename', { path: p, newName }),
  trash: (paths, id) => ipcRenderer.invoke('fs:trash', paths, id),
  paste: (items, dest, mode, opts = {}) => ipcRenderer.invoke('fs:paste', { items, dest, mode, ...opts }),
  pasteConflicts: (items, dest) => ipcRenderer.invoke('fs:pasteConflicts', { items, dest }),
  discardTransfer: (targets) => ipcRenderer.invoke('transfer:discard', targets),
  cancelTransfer: (id) => ipcRenderer.send('transfer:cancel', id),
  onTransfer: (cb) => subscribe('transfer:progress', cb),

  // Explorer-style operations
  compress: (paths, id) => ipcRenderer.invoke('fs:compress', paths, id),
  extract: (p, id) => ipcRenderer.invoke('fs:extract', p, id),
  setHidden: (paths, hidden) => ipcRenderer.invoke('fs:setHidden', paths, hidden),
  setReadOnly: (paths, ro) => ipcRenderer.invoke('fs:setReadOnly', paths, ro),
  properties: (p) => ipcRenderer.invoke('fs:properties', p),
  newFile: (dir) => ipcRenderer.invoke('fs:newFile', dir),
  deletePermanent: (paths, id) => ipcRenderer.invoke('fs:deletePermanent', paths, id),
  chooseFolder: (title) => ipcRenderer.invoke('dialog:chooseFolder', title),
  openWith: (paths) => ipcRenderer.invoke('shell:openWith', paths),

  previewSource: (p, meta) => ipcRenderer.invoke('preview:source', p, meta),

  // Phone over USB (MTP)
  mtpDevice: () => ipcRenderer.invoke('mtp:device'),
  onMtpChanged: (cb) => subscribe('mtp:changed', cb),

  // FTP (phone over Wi-Fi)
  ftpList: () => ipcRenderer.invoke('ftp:list'),
  ftpAdd: (cfg) => ipcRenderer.invoke('ftp:add', cfg),
  ftpRemove: (id) => ipcRenderer.invoke('ftp:remove', id),

  // Native menu
  onCommand: (cb) => subscribe('menu:command', cb),
});

const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('fsApi', {
  platform: process.platform,

  // Reading
  listDir: (dir) => ipcRenderer.invoke('fs:list', dir),
  quickAccess: () => ipcRenderer.invoke('fs:quickAccess'),
  drives: () => ipcRenderer.invoke('fs:drives'),
  onDrivesChanged: (cb) => subscribe('drives:changed', cb),
  search: (opts) => ipcRenderer.invoke('fs:search', opts),
  cancelSearch: (id) => ipcRenderer.send('fs:cancelSearch', id),
  folderSize: (dir) => ipcRenderer.invoke('fs:folderSize', dir),
  thumbnail: (opts) => ipcRenderer.invoke('fs:thumbnail', opts),

  // Watching
  watch: (dir) => ipcRenderer.send('fs:watch', dir),
  unwatch: () => ipcRenderer.send('fs:unwatch'),
  onChanged: (cb) => subscribe('fs:changed', cb),

  // Shell
  open: (paths) => ipcRenderer.invoke('shell:open', paths),
  showInFolder: (p) => ipcRenderer.send('shell:showInFolder', p),
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  newWindow: (p) => ipcRenderer.send('window:new', p),
  copyText: (text) => ipcRenderer.send('clipboard:writeText', text),
  textEdit: (action) => ipcRenderer.send('edit:text', action),

  // Mutations
  newFolder: (dir) => ipcRenderer.invoke('fs:newFolder', dir),
  rename: (p, newName) => ipcRenderer.invoke('fs:rename', { path: p, newName }),
  trash: (paths) => ipcRenderer.invoke('fs:trash', paths),
  paste: (items, dest, mode) => ipcRenderer.invoke('fs:paste', { items, dest, mode }),

  // Native menu
  onCommand: (cb) => subscribe('menu:command', cb),
});

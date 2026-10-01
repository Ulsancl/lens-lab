const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lensDesktop', {
  isDesktop: true,
  openProject: () => ipcRenderer.invoke('lens:open-project'),
  saveProject: payload => ipcRenderer.invoke('lens:save-project', payload),
  setBusy: busy => ipcRenderer.send('lens:busy', busy === true),
  onCommand: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('lens:command', listener);
    return () => ipcRenderer.removeListener('lens:command', listener);
  },
});

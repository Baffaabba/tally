'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tally', {
  close: () => ipcRenderer.invoke('bar:close'),
  reveal: (filePath) => ipcRenderer.invoke('bar:reveal', filePath),
  probeFfmpeg: () => ipcRenderer.invoke('ffmpeg:probe'),

  recording: {
    open: (mime) => ipcRenderer.invoke('recording:open', { mime }),
    chunk: (buffer) => ipcRenderer.invoke('recording:chunk', buffer),
    close: () => ipcRenderer.invoke('recording:close'),
    abort: () => ipcRenderer.invoke('recording:abort')
  },

  onProgress: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('recording:progress', handler);
    return () => ipcRenderer.removeListener('recording:progress', handler);
  }
});

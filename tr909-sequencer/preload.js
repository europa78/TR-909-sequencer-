const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadSamplesDir: () => ipcRenderer.invoke('load-samples-dir'),
  loadSampleFile: () => ipcRenderer.invoke('load-sample-file'),
  savePattern: (data) => ipcRenderer.invoke('save-pattern', data),
  loadPattern: () => ipcRenderer.invoke('load-pattern')
});

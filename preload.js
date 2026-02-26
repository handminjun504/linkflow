const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

let baseDir = __dirname;
if (baseDir.includes('app.asar')) {
  baseDir = baseDir.replace('app.asar', 'app.asar.unpacked');
}
const webviewPreloadPath = `file://${path.join(baseDir, 'preload-webview.js').replace(/\\/g, '/')}`;

contextBridge.exposeInMainWorld('electronAPI', {
  webviewPreloadPath,
  setPasswordUser: (userId) => ipcRenderer.invoke('pw-set-user', userId),
  clearPasswordUser: () => ipcRenderer.invoke('pw-clear-user'),
  savePassword: (data) => ipcRenderer.invoke('pw-save', data),
  getPasswords: (domain) => ipcRenderer.invoke('pw-get', domain),
  deletePassword: (data) => ipcRenderer.invoke('pw-delete', data),
  getAllPasswords: () => ipcRenderer.invoke('pw-list'),
  deleteAllPasswords: () => ipcRenderer.invoke('pw-clear'),
  flushCookies: () => ipcRenderer.invoke('flush-cookies'),
  loadExtension: () => ipcRenderer.invoke('ext-load'),
  removeExtension: (id) => ipcRenderer.invoke('ext-remove', id),
  listExtensions: () => ipcRenderer.invoke('ext-list'),
  openExtensionPopup: (id) => ipcRenderer.invoke('ext-open-popup', id),
});

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

let baseDir = __dirname;
if (baseDir.includes('app.asar')) {
  baseDir = baseDir.replace('app.asar', 'app.asar.unpacked');
}
const webviewPreloadPath = `file://${path.join(baseDir, 'preload-webview.js').replace(/\\/g, '/')}`;

let appVersion = '';
try {
  const pkgPath = path.join(baseDir.replace('app.asar.unpacked', 'app.asar'), 'package.json');
  appVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || '';
} catch {
  try {
    appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version || '';
  } catch {}
}

contextBridge.exposeInMainWorld('electronAPI', {
  webviewPreloadPath,
  getAppVersion: () => appVersion,
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

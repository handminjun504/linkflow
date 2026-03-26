const { contextBridge, ipcRenderer } = require('electron');

function getArg(prefix) {
  const value = (process.argv || []).find((entry) => typeof entry === 'string' && entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : '';
}

function toFileUrl(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized}`;
  }
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

const unpackedBaseDir = String(__dirname).includes('app.asar')
  ? String(__dirname).replace('app.asar', 'app.asar.unpacked')
  : String(__dirname);
const webviewPreloadPath = toFileUrl(`${unpackedBaseDir.replace(/[\\/]+$/, '')}/preload-webview.js`);

const DEFAULT_API_BASE = 'https://gyeongliteam.duckdns.org:8443/linkflow-web/api';
const runtimeApiBase = (getArg('--lf-api-base=') || process.env.LINKFLOW_API_BASE || DEFAULT_API_BASE).trim();
const appVersion = getArg('--lf-app-version=');

contextBridge.exposeInMainWorld('__LF_API_BASE__', runtimeApiBase);

contextBridge.exposeInMainWorld('electronAPI', {
  webviewPreloadPath,
  getAppVersion: () => appVersion,
  getApiBase: () => runtimeApiBase,
  setPasswordUser: (userId) => ipcRenderer.invoke('pw-set-user', userId),
  clearPasswordUser: () => ipcRenderer.invoke('pw-clear-user'),
  savePassword: (data) => ipcRenderer.invoke('pw-save', data),
  getPasswords: (domain) => ipcRenderer.invoke('pw-get', domain),
  deletePassword: (data) => ipcRenderer.invoke('pw-delete', data),
  getAllPasswords: () => ipcRenderer.invoke('pw-list'),
  deleteAllPasswords: () => ipcRenderer.invoke('pw-clear'),
  flushCookies: () => ipcRenderer.invoke('flush-cookies'),
  loadExtension: () => ipcRenderer.invoke('ext-load'),
  installExtensionCrx: (idOrUrl) => ipcRenderer.invoke('ext-install-crx', idOrUrl),
  removeExtension: (id) => ipcRenderer.invoke('ext-remove', id),
  listExtensions: () => ipcRenderer.invoke('ext-list'),
  getClientSheetServiceAccountJson: () => ipcRenderer.invoke('client-sheet-service-account-read'),
  openExtensionPopup: (id) => ipcRenderer.invoke('ext-open-popup', id),
  getExtensionBadge: (id) => ipcRenderer.invoke('ext-get-badge', id),
  registerTab: (info) => ipcRenderer.send('ext-tabs-register', info),
  unregisterTab: (tabId) => ipcRenderer.send('ext-tabs-unregister', tabId),
  updateTabInfo: (info) => ipcRenderer.send('ext-tabs-update-info', info),
  downloadOpen: (p) => ipcRenderer.invoke('download-open', p),
  downloadShow: (p) => ipcRenderer.invoke('download-show', p),
  containerList: () => ipcRenderer.invoke('container-list'),
  containerCreate: (d) => ipcRenderer.invoke('container-create', d),
  containerUpdate: (d) => ipcRenderer.invoke('container-update', d),
  containerDelete: (id) => ipcRenderer.invoke('container-delete', id),
  pipCreate: (d) => ipcRenderer.invoke('pip-create', d),
  capturePage: (r) => ipcRenderer.invoke('capture-page', r),
  captureWebview: () => ipcRenderer.invoke('capture-webview'),
  notify: (payload) => ipcRenderer.invoke('notify', payload),
  checkForUpdates: () => ipcRenderer.invoke('updater-check'),
  installUpdateNow: () => ipcRenderer.invoke('updater-install'),
});

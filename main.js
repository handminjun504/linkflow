const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, safeStorage, session, dialog, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

const APP_URL = process.env.LINKFLOW_APP_URL || 'https://raw.githack.com/handminjun504/linkflow/web/public/index.html';
let mainWindow = null;
let tray = null;

// ═══════ Global Crash Protection ═══════

process.on('uncaughtException', (err) => {
  console.error('[LinkFlow] Uncaught Exception:', err);
  try {
    const logPath = path.join(app.getPath('appData'), 'unified-access', 'crash.log');
    const entry = `[${new Date().toISOString()}] UncaughtException: ${err.stack || err.message}\n`;
    fs.appendFileSync(logPath, entry, 'utf-8');
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  console.error('[LinkFlow] Unhandled Rejection:', reason);
  try {
    const logPath = path.join(app.getPath('appData'), 'unified-access', 'crash.log');
    const entry = `[${new Date().toISOString()}] UnhandledRejection: ${reason}\n`;
    fs.appendFileSync(logPath, entry, 'utf-8');
  } catch {}
});

const userDataPath = path.join(app.getPath('appData'), 'unified-access');
try { fs.mkdirSync(userDataPath, { recursive: true }); } catch {}
app.setPath('userData', userDataPath);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ═══════ Password Store (per-user, safeStorage encrypted) ═══════

let currentPwUserId = null;

function getPwStorePath() {
  if (!currentPwUserId) return null;
  const safeId = currentPwUserId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(userDataPath, `passwords_${safeId}.enc.json`);
}

function loadPwStore() {
  const p = getPwStorePath();
  if (!p) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return {}; }
}

function savePwStore(store) {
  const p = getPwStorePath();
  if (!p) return;
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8');
}

function encrypt(text) {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(text).toString('base64');
  }
  return Buffer.from(text).toString('base64');
}

function decrypt(enc) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    }
    return Buffer.from(enc, 'base64').toString('utf-8');
  } catch { return ''; }
}

ipcMain.handle('pw-set-user', (_e, userId) => {
  currentPwUserId = userId || null;
  return true;
});

ipcMain.handle('pw-clear-user', () => {
  currentPwUserId = null;
  return true;
});

ipcMain.handle('pw-save', (_e, { domain, username, password }) => {
  if (!currentPwUserId) return false;
  const store = loadPwStore();
  if (!store[domain]) store[domain] = [];
  const existing = store[domain].find(c => c.username === username);
  const enc = encrypt(password);
  if (existing) existing.password = enc;
  else store[domain].push({ username, password: enc });
  savePwStore(store);
  return true;
});

ipcMain.handle('pw-get', (_e, domain) => {
  if (!currentPwUserId) return [];
  const store = loadPwStore();
  return (store[domain] || []).map(c => ({
    username: c.username,
    password: decrypt(c.password),
  }));
});

ipcMain.handle('pw-delete', (_e, { domain, username }) => {
  if (!currentPwUserId) return false;
  const store = loadPwStore();
  if (store[domain]) {
    store[domain] = store[domain].filter(c => c.username !== username);
    if (!store[domain].length) delete store[domain];
    savePwStore(store);
  }
  return true;
});

ipcMain.handle('pw-list', () => {
  if (!currentPwUserId) return {};
  const store = loadPwStore();
  const result = {};
  for (const [domain, creds] of Object.entries(store)) {
    result[domain] = creds.map(c => ({
      username: c.username,
      password: decrypt(c.password),
    }));
  }
  return result;
});

ipcMain.handle('pw-clear', () => {
  if (!currentPwUserId) return false;
  savePwStore({});
  return true;
});

ipcMain.handle('flush-cookies', async () => {
  try {
    await session.defaultSession.cookies.flushStore();
    await session.fromPartition('persist:main').cookies.flushStore();
    return true;
  } catch { return false; }
});

// ═══════ Chrome Extensions ═══════

const extensionsFile = path.join(userDataPath, 'extensions.json');
const extensionsDir = path.join(userDataPath, 'extensions');
try { fs.mkdirSync(extensionsDir, { recursive: true }); } catch {}

function loadExtensionPaths() {
  try { return JSON.parse(fs.readFileSync(extensionsFile, 'utf-8')); }
  catch { return []; }
}

function saveExtensionPaths(paths) {
  fs.writeFileSync(extensionsFile, JSON.stringify(paths, null, 2), 'utf-8');
}

async function loadSavedExtensions() {
  const ses = session.fromPartition('persist:main');
  const paths = loadExtensionPaths();
  const valid = [];
  for (const extPath of paths) {
    try {
      if (fs.existsSync(extPath)) {
        await ses.loadExtension(extPath, { allowFileAccess: true });
        valid.push(extPath);
      }
    } catch (err) {
      console.log('Extension load failed:', extPath, err.message);
    }
  }
  if (valid.length !== paths.length) saveExtensionPaths(valid);
}

function getExtensionInfo(ext) {
  const badge = extBadges.get(ext.id) || {};
  return {
    id: ext.id,
    name: ext.name,
    version: ext.manifest?.version || '',
    description: ext.manifest?.description || '',
    path: ext.path,
    icon: ext.manifest?.icons
      ? `file://${path.join(ext.path, ext.manifest.icons[Object.keys(ext.manifest.icons).pop()]).replace(/\\/g, '/')}`
      : '',
    badgeText: badge.text || '',
    badgeColor: badge.color || '#4DA8DA',
    hasPopup: !!(ext.manifest?.action?.default_popup || ext.manifest?.browser_action?.default_popup),
  };
}

async function installExtensionFromPath(extPath) {
  const manifestPath = path.join(extPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: 'manifest.json이 없습니다.' };
  }
  try {
    const ses = session.fromPartition('persist:main');
    const ext = await ses.loadExtension(extPath, { allowFileAccess: true });
    const paths = loadExtensionPaths();
    if (!paths.includes(extPath)) {
      paths.push(extPath);
      saveExtensionPaths(paths);
    }
    return { ok: true, extension: getExtensionInfo(ext) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── CRX Download & Install ──

function extractCrx(crxBuffer, destDir) {
  const AdmZip = require('adm-zip');
  let zipStart = 0;
  if (crxBuffer[0] === 0x43 && crxBuffer[1] === 0x72 && crxBuffer[2] === 0x32 && crxBuffer[3] === 0x34) {
    const version = crxBuffer.readUInt32LE(4);
    if (version === 3) {
      const headerSize = crxBuffer.readUInt32LE(8);
      zipStart = 12 + headerSize;
    } else {
      const pubKeyLen = crxBuffer.readUInt32LE(8);
      const sigLen = crxBuffer.readUInt32LE(12);
      zipStart = 16 + pubKeyLen + sigLen;
    }
  }
  const zipBuffer = crxBuffer.slice(zipStart);
  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(destDir, true);
}

ipcMain.handle('ext-install-crx', async (_e, extIdOrUrl) => {
  try {
    let extId = extIdOrUrl.trim();
    const cwsMatch = extId.match(/chrome\.google\.com\/webstore\/detail\/[^/]*\/([a-z]{32})/i)
      || extId.match(/chromewebstore\.google\.com\/detail\/[^/]*\/([a-z]{32})/i)
      || extId.match(/^([a-z]{32})$/i);
    if (!cwsMatch) {
      return { ok: false, error: '유효한 확장 프로그램 ID 또는 Chrome Web Store URL을 입력하세요.' };
    }
    extId = cwsMatch[1].toLowerCase();

    const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=120.0&x=id%3D${extId}%26installsource%3Dondemand%26uc`;

    const https = require('https');
    const http = require('http');

    const downloadCrx = (url, maxRedirects = 5) => new Promise((resolve, reject) => {
      if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(downloadCrx(res.headers.location, maxRedirects - 1));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });

    const crxBuffer = await downloadCrx(crxUrl);
    if (crxBuffer.length < 100) {
      return { ok: false, error: '확장 프로그램을 다운로드할 수 없습니다. ID를 확인하세요.' };
    }

    const destDir = path.join(extensionsDir, extId);
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.mkdirSync(destDir, { recursive: true });

    extractCrx(crxBuffer, destDir);

    if (!fs.existsSync(path.join(destDir, 'manifest.json'))) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return { ok: false, error: 'CRX에서 manifest.json을 찾을 수 없습니다.' };
    }

    return await installExtensionFromPath(destDir);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext-load', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '확장 프로그램 폴더 또는 CRX 파일 선택',
    properties: ['openDirectory'],
    message: '압축 해제된 Chrome 확장 프로그램 폴더를 선택하세요',
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  return await installExtensionFromPath(result.filePaths[0]);
});

ipcMain.handle('ext-remove', async (_e, extId) => {
  try {
    const ses = session.fromPartition('persist:main');
    const exts = ses.getAllExtensions();
    const ext = exts.find(e => e.id === extId);
    if (ext) {
      const extPath = ext.path;
      await ses.removeExtension(extId);
      const paths = loadExtensionPaths().filter(p => p !== extPath);
      saveExtensionPaths(paths);
      if (extPath.startsWith(extensionsDir)) {
        try { fs.rmSync(extPath, { recursive: true, force: true }); } catch {}
      }
    }
    extBadges.delete(extId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext-list', () => {
  try {
    const ses = session.fromPartition('persist:main');
    const exts = ses.getAllExtensions();
    return exts.map(getExtensionInfo);
  } catch {
    return [];
  }
});

ipcMain.handle('ext-open-popup', async (_e, extId) => {
  try {
    const ses = session.fromPartition('persist:main');
    const exts = ses.getAllExtensions();
    const ext = exts.find(e => e.id === extId);
    const popup_page = ext?.manifest?.action?.default_popup || ext?.manifest?.browser_action?.default_popup;
    if (!ext || !popup_page) return { ok: false };

    const popupPath = path.join(ext.path, popup_page);
    const popupUrl = `file://${popupPath.replace(/\\/g, '/')}`;

    const popup = new BrowserWindow({
      width: 400,
      height: 550,
      frame: true,
      resizable: true,
      title: ext.name,
      icon: path.join(__dirname, 'icon.png'),
      parent: mainWindow,
      webPreferences: {
        partition: 'persist:main',
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    popup.setMenuBarVisibility(false);
    popup.loadURL(popupUrl);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Extension Badge API ──

const extBadges = new Map();

ipcMain.handle('ext-get-badge', (_e, extId) => {
  return extBadges.get(extId) || { text: '', color: '#4DA8DA' };
});

// ── Chrome Tabs API Bridge ──

const webviewTabs = new Map();

ipcMain.on('ext-tabs-register', (_e, { tabId, url, title, active }) => {
  webviewTabs.set(tabId, { id: tabId, url: url || '', title: title || '', active: !!active });
});

ipcMain.on('ext-tabs-unregister', (_e, tabId) => {
  webviewTabs.delete(tabId);
});

ipcMain.on('ext-tabs-update-info', (_e, { tabId, url, title, active }) => {
  const tab = webviewTabs.get(tabId);
  if (tab) {
    if (url !== undefined) tab.url = url;
    if (title !== undefined) tab.title = title;
    if (active !== undefined) tab.active = active;
  }
});

function setupChromeApiBridge(ses) {
  ses.on('extension-loaded', (_event, ext) => {
    console.log('[Extension] Loaded:', ext.name, ext.id);
  });

  ses.on('extension-unloaded', (_event, ext) => {
    console.log('[Extension] Unloaded:', ext.name, ext.id);
    extBadges.delete(ext.id);
  });
}

// ═══════ Downloads ═══════

const downloads = new Map();
let downloadIdCounter = 0;

function setupDownloads() {
  const ses = session.fromPartition('persist:main');
  [session.defaultSession, ses].forEach(s => {
    s.on('will-download', (_event, item) => {
      const id = ++downloadIdCounter;
      const filename = item.getFilename();
      const totalBytes = item.getTotalBytes();

      downloads.set(id, { item, filename, state: 'progressing' });
      sendToRenderer('download-started', { id, filename, totalBytes });

      item.on('updated', (_e, state) => {
        if (state === 'progressing') {
          sendToRenderer('download-progress', {
            id, received: item.getReceivedBytes(), total: item.getTotalBytes(),
          });
        }
      });
      item.once('done', (_e, state) => {
        const dl = downloads.get(id);
        if (dl) dl.state = state;
        sendToRenderer('download-done', { id, state, path: item.getSavePath() });
      });
    });
  });
}

function sendToRenderer(channel, data) {
  const wins = BrowserWindow.getAllWindows();
  wins.forEach(w => w.webContents.executeJavaScript(
    `window.__onDownload&&window.__onDownload(${JSON.stringify(channel)},${JSON.stringify(data)})`
  ).catch(() => {}));
}

ipcMain.handle('download-open', (_e, filePath) => {
  const { shell } = require('electron');
  shell.openPath(filePath);
});
ipcMain.handle('download-show', (_e, filePath) => {
  const { shell } = require('electron');
  shell.showItemInFolder(filePath);
});

// ═══════ Container Tabs ═══════

const containersFile = path.join(userDataPath, 'containers.json');

function loadContainers() {
  try { return JSON.parse(fs.readFileSync(containersFile, 'utf-8')); }
  catch { return []; }
}
function saveContainers(list) {
  fs.writeFileSync(containersFile, JSON.stringify(list, null, 2), 'utf-8');
}

const containerSessionSetup = new Set();
function ensureContainerSession(containerId) {
  const partName = `persist:container_${containerId}`;
  if (!containerSessionSetup.has(partName)) {
    const ses = session.fromPartition(partName);
    makeCookiesPersistent(ses);
    stripRestrictiveHeaders(ses);
    containerSessionSetup.add(partName);
  }
  return partName;
}

ipcMain.handle('container-list', () => loadContainers());
ipcMain.handle('container-create', (_e, data) => {
  const list = loadContainers();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const item = { id, name: data.name, color: data.color || '#4A90D9', icon: data.icon || '🔵' };
  list.push(item);
  saveContainers(list);
  ensureContainerSession(id);
  return item;
});
ipcMain.handle('container-update', (_e, { id, ...updates }) => {
  const list = loadContainers();
  const item = list.find(c => c.id === id);
  if (item) { Object.assign(item, updates); saveContainers(list); }
  return item;
});
ipcMain.handle('container-delete', (_e, id) => {
  let list = loadContainers();
  list = list.filter(c => c.id !== id);
  saveContainers(list);
  return true;
});

// ═══════ Picture-in-Picture ═══════

ipcMain.handle('pip-create', (_e, { url, partition }) => {
  const pipWin = new BrowserWindow({
    width: 400, height: 300, minWidth: 200, minHeight: 150,
    alwaysOnTop: true, frame: true, title: 'PiP', icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      partition: partition || 'persist:main',
      contextIsolation: true, nodeIntegration: false,
    },
  });
  pipWin.loadURL(url);
  return { ok: true };
});

// ═══════ Screenshot ═══════

ipcMain.handle('capture-page', async (_e, rect) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return null;
  const img = rect
    ? await win.webContents.capturePage(rect)
    : await win.webContents.capturePage();
  return img.toDataURL();
});

ipcMain.handle('capture-webview', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return null;
  const result = await win.webContents.executeJavaScript(`
    (async function() {
      var wv = document.querySelector('#dynamic-tab-frames webview.active');
      if (!wv) return null;
      var img = await wv.capturePage();
      return img.toDataURL();
    })()
  `).catch(() => null);
  return result;
});

// ═══════ Window helpers ═══════

function setupWindowEvents(win) {
  const reloadActive = () => {
    win.webContents.executeJavaScript(`
      (function() {
        var wv = document.querySelector('#dynamic-tab-frames webview.active');
        if (wv) { wv.reload(); return true; }
        var ifr = document.querySelector('#dynamic-tab-frames iframe.active');
        if (ifr) { ifr.contentWindow.location.reload(); return true; }
        return false;
      })()
    `).then(handled => {
      if (!handled) win.webContents.reload();
    });
  };

  const exec = (js) => win.webContents.executeJavaScript(js).catch(() => {});

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control && !input.alt;
    const ctrlShift = input.control && input.shift && !input.alt;

    if (input.key === 'ArrowLeft' && input.alt && !input.control && !input.shift) {
      exec(`(function(){ var wv=document.querySelector('#dynamic-tab-frames webview.active');
        if(wv&&wv.canGoBack()){wv.goBack();}})()
      `);
      event.preventDefault();
    } else if (input.key === 'ArrowRight' && input.alt && !input.control && !input.shift) {
      exec(`(function(){ var wv=document.querySelector('#dynamic-tab-frames webview.active');
        if(wv&&wv.canGoForward()){wv.goForward();}})()
      `);
      event.preventDefault();
    } else if (input.key === 'F12') {
      win.webContents.toggleDevTools(); event.preventDefault();
    } else if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen()); event.preventDefault();
    } else if (input.key === 'F5') {
      reloadActive(); event.preventDefault();
    } else if (input.key === 'F3' || (input.key === 'g' && ctrl && !input.shift)) {
      exec('window.__findInPage&&window.__findInPage()'); event.preventDefault();
    } else if (input.key === 'r' && ctrl && !input.shift) {
      reloadActive(); event.preventDefault();
    } else if (input.key === 'I' && ctrlShift) {
      win.webContents.toggleDevTools(); event.preventDefault();
    } else if (input.key === 'l' && input.alt && !input.control && !input.shift) {
      exec('Auth.showLockScreen()'); event.preventDefault();
    } else if (input.key === 'p' && ctrl && !input.shift) {
      exec(`(function(){var wv=document.querySelector('#dynamic-tab-frames webview.active');if(wv){wv.print();return}window.print();})()`);
      event.preventDefault();
    } else if (input.key === 'd' && ctrl && !input.shift) {
      exec('window.__quickBookmark&&window.__quickBookmark()'); event.preventDefault();
    } else if (input.key === 't' && ctrl && !input.shift) {
      exec('window.__newTab&&window.__newTab()'); event.preventDefault();
    } else if (input.key === 'w' && ctrl && !input.shift) {
      exec('window.__closeActiveTab&&window.__closeActiveTab()'); event.preventDefault();
    } else if (input.key === 'T' && ctrlShift) {
      exec('window.__reopenClosedTab&&window.__reopenClosedTab()'); event.preventDefault();
    } else if (input.key === 'Tab' && ctrl && !input.shift) {
      exec('window.__nextTab&&window.__nextTab()'); event.preventDefault();
    } else if (input.key === 'Tab' && ctrlShift) {
      exec('window.__prevTab&&window.__prevTab()'); event.preventDefault();
    } else if (input.key === 'l' && ctrl && !input.shift) {
      exec('window.__focusUrlBar&&window.__focusUrlBar()'); event.preventDefault();
    } else if (input.key === 'f' && ctrl && !input.shift) {
      exec('window.__findInPage&&window.__findInPage()'); event.preventDefault();
    } else if (input.key === 'k' && ctrl && !input.shift) {
      exec('window.__commandPalette&&window.__commandPalette()'); event.preventDefault();
    } else if (input.key === 'A' && ctrlShift) {
      exec('window.__commandPalette&&window.__commandPalette("tabs")'); event.preventDefault();
    } else if (input.key === '\\' && ctrl && !input.shift) {
      exec('window.__toggleSplit&&window.__toggleSplit()'); event.preventDefault();
    } else if (input.key === 'S' && ctrlShift) {
      exec('window.__screenshot&&window.__screenshot()'); event.preventDefault();
    } else if (input.key === 'Escape') {
      exec('window.__closeFindBar&&window.__closeFindBar();window.__closeCommandPalette&&window.__closeCommandPalette()');
    } else if (/^[1-9]$/.test(input.key) && ctrl && !input.shift) {
      exec(`window.__switchToTabIndex&&window.__switchToTabIndex(${parseInt(input.key)-1})`); event.preventDefault();
    }
  });

  win.webContents.on('page-title-updated', (_e, title) => {
    win.setTitle(title || 'LinkFlow');
  });

  const goBack = () => {
    win.webContents.executeJavaScript(`
      (function(){ var wv=document.querySelector('#dynamic-tab-frames webview.active');
      if(wv&&wv.canGoBack()){wv.goBack();return true;} return false; })()
    `).then(ok => { if (!ok && win.webContents.navigationHistory) win.webContents.navigationHistory.goBack(); }).catch(() => {});
  };
  const goForward = () => {
    win.webContents.executeJavaScript(`
      (function(){ var wv=document.querySelector('#dynamic-tab-frames webview.active');
      if(wv&&wv.canGoForward()){wv.goForward();return true;} return false; })()
    `).then(ok => { if (!ok && win.webContents.navigationHistory) win.webContents.navigationHistory.goForward(); }).catch(() => {});
  };

  if (process.platform === 'win32') {
    try {
      const WM_APPCOMMAND = 0x0319;
      win.hookWindowMessage(WM_APPCOMMAND, (_wParam, lParam) => {
        const cmd = (lParam.readUInt32LE(0) >>> 16) & 0xFFF;
        if (cmd === 1) setImmediate(goBack);
        else if (cmd === 2) setImmediate(goForward);
      });
    } catch (e) {
      console.error('[LinkFlow] hookWindowMessage failed:', e);
    }
  }

  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') goBack();
    else if (cmd === 'browser-forward') goForward();
  });
}

// ═══════ Main Window ═══════

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'LinkFlow',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f0f4f8',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadURL(APP_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const versionFile = path.join(userDataPath, 'lastVersion.txt');
    const currentVersion = app.getVersion();
    let lastVersion = '';
    try { lastVersion = fs.readFileSync(versionFile, 'utf-8').trim(); } catch {}
    if (lastVersion && lastVersion !== currentVersion) {
      setTimeout(() => {
        mainWindow.webContents.executeJavaScript(
          'window.__showUpdateHistory && window.__showUpdateHistory()'
        ).catch(() => {});
      }, 2000);
    }
    try { fs.writeFileSync(versionFile, currentVersion, 'utf-8'); } catch {}
  });

  setupWindowEvents(mainWindow);

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[LinkFlow] Renderer crashed:', details.reason, details.exitCode);
    try {
      const logPath = path.join(userDataPath, 'crash.log');
      const entry = `[${new Date().toISOString()}] RendererCrash: ${details.reason} (exit: ${details.exitCode})\n`;
      fs.appendFileSync(logPath, entry, 'utf-8');
    } catch {}

    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'LinkFlow 오류',
        message: '페이지에 문제가 발생했습니다. 다시 로드합니다.',
        buttons: ['확인'],
      }).then(() => {
        mainWindow.loadURL(APP_URL);
      }).catch(() => {
        mainWindow.loadURL(APP_URL);
      });
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[LinkFlow] Window unresponsive');
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'LinkFlow',
      message: '응답하지 않는 페이지가 있습니다. 기다리시겠습니까?',
      buttons: ['기다리기', '새로고침'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 1 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    }).catch(() => {});
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ═══════ Detached Window ═══════

function createDetachedWindow(url, authData) {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'LinkFlow',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f0f4f8',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);
  let hash = `__open_tab=${encodeURIComponent(url)}`;
  if (authData) hash += `&__auth=${authData}`;
  win.loadURL(`${APP_URL}#${hash}`);
  setupWindowEvents(win);
}

// ═══════ Intercept window.open ═══════

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (url && url.includes('#__detach')) {
      const hashPart = url.split('#')[1] || '';
      const authMatch = hashPart.match(/__auth=(.+)$/);
      const authData = authMatch ? authMatch[1] : '';
      const cleanUrl = url.replace(/#__detach.*$/, '');
      createDetachedWindow(cleanUrl, authData);
      return { action: 'deny' };
    }

    const isWebview = contents.getType() === 'webview';

    if (isWebview) {
      if (!url || url === 'about:blank' || disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { autoHideMenuBar: true },
        };
      }
      const hostContents = contents.hostWebContents;
      const win = hostContents ? BrowserWindow.fromWebContents(hostContents) : null;
      const targetWin = win || mainWindow;
      if (targetWin) {
        targetWin.webContents.executeJavaScript(
          `window.__electronOpenTab && window.__electronOpenTab(${JSON.stringify(url)})`
        ).catch(() => {});
      }
      return { action: 'deny' };
    }

    if (!url || url === 'about:blank') return { action: 'deny' };
    const targetWin = BrowserWindow.fromWebContents(contents) || mainWindow;
    if (targetWin) {
      targetWin.webContents.executeJavaScript(
        `window.__electronOpenTab && window.__electronOpenTab(${JSON.stringify(url)})`
      ).catch(() => {});
    }
    return { action: 'deny' };
  });

  if (contents.getType() === 'webview') {
    contents.on('zoom-changed', (_event, zoomDirection) => {
      const current = contents.getZoomLevel();
      const step = 0.5;
      const newLevel = zoomDirection === 'in'
        ? Math.min(5, current + step)
        : Math.max(-5, current - step);
      contents.setZoomLevel(newLevel);
      const pct = Math.round(contents.getZoomFactor() * 100);
      try {
        const hostContents = contents.hostWebContents;
        const win = hostContents ? BrowserWindow.fromWebContents(hostContents) : mainWindow;
        if (win && !win.isDestroyed()) {
          win.webContents.executeJavaScript(
            `(function(){var l=document.getElementById('dtf-zoom-label');if(l)l.textContent='${pct}%';})()`
          ).catch(() => {});
        }
      } catch {}
    });

    contents.on('context-menu', (_event, params) => {
      const win = BrowserWindow.fromWebContents(contents.hostWebContents) || mainWindow;
      const menuItems = [];
      if (params.linkURL) {
        menuItems.push({ label: '새 탭에서 링크 열기', click: () => {
          if (win) win.webContents.executeJavaScript(`window.__electronOpenTab&&window.__electronOpenTab(${JSON.stringify(params.linkURL)})`).catch(()=>{});
        }});
        menuItems.push({ label: '링크 주소 복사', click: () => { require('electron').clipboard.writeText(params.linkURL); }});
        menuItems.push({ type: 'separator' });
      }
      if (params.mediaType === 'image' && params.srcURL) {
        menuItems.push({ label: '이미지 주소 복사', click: () => { require('electron').clipboard.writeText(params.srcURL); }});
        menuItems.push({ label: '이미지를 새 탭에서 열기', click: () => {
          if (win) win.webContents.executeJavaScript(`window.__electronOpenTab&&window.__electronOpenTab(${JSON.stringify(params.srcURL)})`).catch(()=>{});
        }});
        menuItems.push({ type: 'separator' });
      }
      if (params.selectionText) {
        menuItems.push({ label: '복사', role: 'copy' });
      }
      if (params.isEditable) {
        menuItems.push({ label: '붙여넣기', role: 'paste' });
        menuItems.push({ label: '잘라내기', role: 'cut' });
      }
      menuItems.push({ label: '전체 선택', role: 'selectAll' });
      if (params.selectionText) {
        menuItems.push({ type: 'separator' });
        menuItems.push({ label: `"${params.selectionText.slice(0, 30)}${params.selectionText.length > 30 ? '...' : ''}" Google 검색`, click: () => {
          const q = encodeURIComponent(params.selectionText);
          if (win) win.webContents.executeJavaScript(`window.__electronOpenTab&&window.__electronOpenTab('https://www.google.com/search?q=${q}')`).catch(()=>{});
        }});
      }
      menuItems.push({ type: 'separator' });
      menuItems.push({ label: '뒤로', enabled: contents.canGoBack(), click: () => contents.goBack() });
      menuItems.push({ label: '앞으로', enabled: contents.canGoForward(), click: () => contents.goForward() });
      menuItems.push({ label: '새로고침', click: () => contents.reload() });
      menuItems.push({ type: 'separator' });
      menuItems.push({ label: '검사 (DevTools)', click: () => contents.inspectElement(params.x, params.y) });
      Menu.buildFromTemplate(menuItems).popup({ window: win });
    });

    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const win = BrowserWindow.fromWebContents(contents.hostWebContents) || mainWindow;
      if (!win) return;
      const exec = (js) => win.webContents.executeJavaScript(js).catch(() => {});
      const ctrl = input.control && !input.alt;
      const ctrlShift = input.control && input.shift && !input.alt;

      if (input.key === 'ArrowLeft' && input.alt && !input.control && !input.shift) {
        if (contents.canGoBack()) contents.goBack();
        event.preventDefault();
      } else if (input.key === 'ArrowRight' && input.alt && !input.control && !input.shift) {
        if (contents.canGoForward()) contents.goForward();
        event.preventDefault();
      } else if (input.key === 'l' && input.alt && !input.control && !input.shift) {
        exec('Auth.showLockScreen()'); event.preventDefault();
      } else if (input.key === 'F11') {
        win.setFullScreen(!win.isFullScreen()); event.preventDefault();
      } else if (input.key === 'F5') {
        contents.reload(); event.preventDefault();
      } else if (input.key === 'r' && ctrl && !input.shift) {
        contents.reload(); event.preventDefault();
      } else if (input.key === 'p' && ctrl && !input.shift) {
        contents.print(); event.preventDefault();
      } else if (input.key === 'd' && ctrl && !input.shift) {
        exec('window.__quickBookmark&&window.__quickBookmark()'); event.preventDefault();
      } else if (input.key === 't' && ctrl && !input.shift) {
        exec('window.__newTab&&window.__newTab()'); event.preventDefault();
      } else if (input.key === 'w' && ctrl && !input.shift) {
        exec('window.__closeActiveTab&&window.__closeActiveTab()'); event.preventDefault();
      } else if (input.key === 'T' && ctrlShift) {
        exec('window.__reopenClosedTab&&window.__reopenClosedTab()'); event.preventDefault();
      } else if (input.key === 'Tab' && ctrl && !input.shift) {
        exec('window.__nextTab&&window.__nextTab()'); event.preventDefault();
      } else if (input.key === 'Tab' && ctrlShift) {
        exec('window.__prevTab&&window.__prevTab()'); event.preventDefault();
      } else if (input.key === 'l' && ctrl && !input.shift) {
        exec('window.__focusUrlBar&&window.__focusUrlBar()'); event.preventDefault();
      } else if (input.key === 'f' && ctrl && !input.shift) {
        exec('window.__findInPage&&window.__findInPage()'); event.preventDefault();
      } else if (input.key === 'F3') {
        exec('window.__findInPage&&window.__findInPage()'); event.preventDefault();
      } else if (input.key === 'F12') {
        contents.toggleDevTools(); event.preventDefault();
      } else if (input.key === 'I' && ctrlShift) {
        contents.toggleDevTools(); event.preventDefault();
      } else if (input.key === 'k' && ctrl && !input.shift) {
        exec('window.__commandPalette&&window.__commandPalette()'); event.preventDefault();
      } else if (input.key === 'A' && ctrlShift) {
        exec('window.__commandPalette&&window.__commandPalette("tabs")'); event.preventDefault();
      } else if (input.key === '\\' && ctrl && !input.shift) {
        exec('window.__toggleSplit&&window.__toggleSplit()'); event.preventDefault();
      } else if (input.key === 'S' && ctrlShift) {
        exec('window.__screenshot&&window.__screenshot()'); event.preventDefault();
      } else if (/^[1-9]$/.test(input.key) && ctrl && !input.shift) {
        exec(`window.__switchToTabIndex&&window.__switchToTabIndex(${parseInt(input.key)-1})`); event.preventDefault();
      } else if (input.key === 'Escape') {
        exec('window.__closeFindBar&&window.__closeFindBar();window.__closeCommandPalette&&window.__closeCommandPalette()');
      } else if (ctrl && !input.shift) {
        let newLevel = null;
        if (input.key === '=' || input.key === '+') newLevel = Math.min(5, contents.getZoomLevel() + 0.5);
        else if (input.key === '-') newLevel = Math.max(-5, contents.getZoomLevel() - 0.5);
        else if (input.key === '0') newLevel = 0;
        if (newLevel !== null) {
          contents.setZoomLevel(newLevel);
          const pct = Math.round(contents.getZoomFactor() * 100);
          exec(`(function(){var l=document.getElementById('dtf-zoom-label');if(l)l.textContent='${pct}%';})()`);
          event.preventDefault();
        }
      }
    });
  }
});

// ═══════ System Tray ═══════

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let trayIcon;
  try { trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }); }
  catch { trayIcon = nativeImage.createEmpty(); }

  tray = new Tray(trayIcon);
  tray.setToolTip('LinkFlow');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// ═══════ Session Cookie Persistence ═══════

function makeCookiesPersistent(ses) {
  let cookieQueue = [];
  let processingCookies = false;

  async function processCookieQueue() {
    if (processingCookies) return;
    processingCookies = true;
    while (cookieQueue.length > 0) {
      const batch = cookieQueue.splice(0, 20);
      for (const cookie of batch) {
        try {
          const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
          const url = `http${cookie.secure ? 's' : ''}://${domain}${cookie.path}`;
          await ses.cookies.set({
            url,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite || 'unspecified',
            expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          });
        } catch {}
      }
    }
    processingCookies = false;
  }

  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (removed || !cookie.session) return;
    cookieQueue.push(cookie);
    processCookieQueue();
  });
}

function stripRestrictiveHeaders(ses) {
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    const lower = Object.keys(headers).reduce((m, k) => { m[k.toLowerCase()] = k; return m; }, {});

    const remove = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'];
    for (const h of remove) {
      if (lower[h]) delete headers[lower[h]];
    }
    callback({ responseHeaders: headers });
  });
}

function setupSessionPersistence() {
  makeCookiesPersistent(session.defaultSession);
  makeCookiesPersistent(session.fromPartition('persist:main'));

  stripRestrictiveHeaders(session.defaultSession);
  stripRestrictiveHeaders(session.fromPartition('persist:main'));

  setupChromeApiBridge(session.fromPartition('persist:main'));

  app.on('before-quit', () => {
    session.defaultSession.cookies.flushStore().catch(() => {});
    session.fromPartition('persist:main').cookies.flushStore().catch(() => {});
  });
}

ipcMain.handle('notify', (_e, payload = {}) => {
  try {
    const title = String(payload.title || 'LinkFlow');
    const body = String(payload.body || '');
    const iconPath = path.join(__dirname, 'icon.png');
    if (Notification.isSupported()) {
      const n = new Notification({
        title,
        body,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
      });
      n.show();
      return true;
    }
  } catch (err) {
    console.log('[LinkFlow] notify failed:', err?.message || err);
  }
  return false;
});

ipcMain.handle('updater-check', async () => {
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('updater-install', () => {
  try {
    app.isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
// ═══════ Auto Updater ═══════

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;

autoUpdater.on('update-available', (info) => {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(
    `window.__showUpdateBanner && window.__showUpdateBanner('downloading', '${info.version}')`
  ).catch(() => {});
});

autoUpdater.on('download-progress', (progress) => {
  if (!mainWindow) return;
  const pct = Math.round(progress.percent);
  mainWindow.webContents.executeJavaScript(
    `window.__showUpdateBanner && window.__showUpdateBanner('progress', '', ${pct})`
  ).catch(() => {});
});

autoUpdater.on('update-downloaded', (info) => {
  if (!mainWindow) return;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '업데이트 준비 완료',
    message: `새 버전 (v${info.version})이 다운로드되었습니다.\n지금 재시작하여 업데이트하시겠습니까?`,
    buttons: ['재시작', '나중에'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      app.isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });
});

autoUpdater.on('error', (err) => {
  console.log('Auto-update error:', err?.message);
});

function checkForUpdates() {
  autoUpdater.checkForUpdates().catch(() => {});
}

// ═══════ App Lifecycle ═══════

app.whenReady().then(async () => {
  setupSessionPersistence();
  setupDownloads();
  loadContainers().forEach(c => ensureContainerSession(c.id));
  await loadSavedExtensions();
  createWindow();
  createTray();
  setTimeout(checkForUpdates, 5000);
  setInterval(checkForUpdates, 60 * 60 * 1000);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });

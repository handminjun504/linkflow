const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, safeStorage, session, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

const APP_URL = 'https://bookmark-one-lemon.vercel.app';
let mainWindow = null;
let tray = null;

const userDataPath = path.join(app.getPath('appData'), 'unified-access');
try { fs.mkdirSync(userDataPath, { recursive: true }); } catch {}
app.setPath('userData', userDataPath);

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

// ═══════ Chrome Extensions ═══════

const extensionsFile = path.join(userDataPath, 'extensions.json');

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
  return {
    id: ext.id,
    name: ext.name,
    version: ext.manifest?.version || '',
    description: ext.manifest?.description || '',
    path: ext.path,
    icon: ext.manifest?.icons
      ? `file://${path.join(ext.path, ext.manifest.icons[Object.keys(ext.manifest.icons).pop()]).replace(/\\/g, '/')}`
      : '',
  };
}

ipcMain.handle('ext-load', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '확장 프로그램 폴더 선택',
    properties: ['openDirectory'],
    message: '압축 해제된 Chrome 확장 프로그램 폴더를 선택하세요',
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const extPath = result.filePaths[0];
  const manifestPath = path.join(extPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: 'manifest.json이 없습니다. Chrome 확장 프로그램 폴더를 선택하세요.' };
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
});

ipcMain.handle('ext-remove', async (_e, extId) => {
  try {
    const ses = session.fromPartition('persist:main');
    const exts = ses.getAllExtensions();
    const ext = exts.find(e => e.id === extId);
    if (ext) {
      await ses.removeExtension(extId);
      const paths = loadExtensionPaths().filter(p => p !== ext.path);
      saveExtensionPaths(paths);
    }
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
    if (!ext || !ext.manifest?.action?.default_popup) return { ok: false };

    const popupPath = path.join(ext.path, ext.manifest.action.default_popup);
    const popupUrl = `file://${popupPath.replace(/\\/g, '/')}`;

    const popup = new BrowserWindow({
      width: 400,
      height: 500,
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

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.key === 'F5') {
      reloadActive();
      event.preventDefault();
    } else if (input.key === 'r' && input.control && !input.alt && !input.shift) {
      reloadActive();
      event.preventDefault();
    } else if (input.key === 'I' && input.control && input.shift && !input.alt) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.key === 'l' && input.alt && !input.control && !input.shift) {
      win.webContents.executeJavaScript('Auth.showLockScreen()').catch(() => {});
      event.preventDefault();
    }
  });

  win.webContents.on('page-title-updated', (_e, title) => {
    win.setTitle(title || 'LinkFlow');
  });

  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') {
      win.webContents.executeJavaScript(`
        (function(){ var wv=document.querySelector('#dynamic-tab-frames webview.active');
        if(wv&&wv.canGoBack()){wv.goBack();return true;} return false; })()
      `).then(ok => { if (!ok) win.webContents.navigationHistory.goBack(); }).catch(() => {});
    } else if (cmd === 'browser-forward') {
      win.webContents.executeJavaScript(`
        (function(){ var wv=document.querySelector('#dynamic-tab-frames webview.active');
        if(wv&&wv.canGoForward()){wv.goForward();return true;} return false; })()
      `).then(ok => { if (!ok) win.webContents.navigationHistory.goForward(); }).catch(() => {});
    }
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

  setupWindowEvents(mainWindow);

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
  contents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') return { action: 'deny' };

    if (url.includes('#__detach')) {
      const hashPart = url.split('#')[1] || '';
      const authMatch = hashPart.match(/__auth=(.+)$/);
      const authData = authMatch ? authMatch[1] : '';
      const cleanUrl = url.replace(/#__detach.*$/, '');
      createDetachedWindow(cleanUrl, authData);
      return { action: 'deny' };
    }

    const targetWin = BrowserWindow.fromWebContents(contents) || mainWindow;
    if (targetWin) {
      targetWin.webContents.executeJavaScript(
        `window.__electronOpenTab && window.__electronOpenTab(${JSON.stringify(url)})`
      );
    }
    return { action: 'deny' };
  });

  if (contents.getType() === 'webview') {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.control && !input.alt && !input.shift) {
        if (input.key === '=' || input.key === '+') {
          contents.setZoomLevel(Math.min(5, contents.getZoomLevel() + 0.5));
          event.preventDefault();
        } else if (input.key === '-') {
          contents.setZoomLevel(Math.max(-5, contents.getZoomLevel() - 0.5));
          event.preventDefault();
        } else if (input.key === '0') {
          contents.setZoomLevel(0);
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
  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (removed || !cookie.session) return;
    const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
    const url = `http${cookie.secure ? 's' : ''}://${domain}${cookie.path}`;
    ses.cookies.set({
      url,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite || 'unspecified',
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    }).catch(() => {});
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

  app.on('before-quit', () => {
    session.defaultSession.cookies.flushStore().catch(() => {});
    session.fromPartition('persist:main').cookies.flushStore().catch(() => {});
  });
}

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
  await loadSavedExtensions();
  createWindow();
  createTray();
  setTimeout(checkForUpdates, 5000);
  setInterval(checkForUpdates, 60 * 60 * 1000);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });

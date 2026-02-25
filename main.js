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
    }
  });

  win.webContents.on('page-title-updated', (_e, title) => {
    win.setTitle(title || 'LinkFlow');
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

function createDetachedWindow(url) {
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
  const openUrl = `${APP_URL}#__open_tab=${encodeURIComponent(url)}`;
  win.loadURL(openUrl);
  setupWindowEvents(win);
}

// ═══════ Intercept window.open ═══════

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') return { action: 'deny' };

    if (url.includes('#__detach')) {
      createDetachedWindow(url.replace('#__detach', ''));
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

function setupSessionPersistence() {
  const ses = session.defaultSession;

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

  // Flush cookies to disk before app quits
  app.on('before-quit', () => {
    ses.cookies.flushStore().catch(() => {});
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

app.whenReady().then(() => {
  setupSessionPersistence();
  createWindow();
  createTray();
  setTimeout(checkForUpdates, 5000);
  setInterval(checkForUpdates, 60 * 60 * 1000);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });

const { ipcRenderer, webFrame } = require('electron');

let lastKey = '';

// ═══════ Zoom (Ctrl+Wheel, Ctrl+Plus/Minus/0) ═══════

const ZOOM_STEP = 0.5;
const ZOOM_MIN = -5;
const ZOOM_MAX = 5;

function clampZoom(level) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(level * 10) / 10));
}

document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const current = webFrame.getZoomLevel();
  const next = clampZoom(current + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  webFrame.setZoomLevel(next);
  ipcRenderer.sendToHost('zoom-changed', Math.round(webFrame.getZoomFactor() * 100));
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey) return;
  const current = webFrame.getZoomLevel();
  if (e.key === '+' || e.key === '=' || (e.key === ';' && e.shiftKey)) {
    e.preventDefault();
    webFrame.setZoomLevel(clampZoom(current + ZOOM_STEP));
    ipcRenderer.sendToHost('zoom-changed', Math.round(webFrame.getZoomFactor() * 100));
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    webFrame.setZoomLevel(clampZoom(current - ZOOM_STEP));
    ipcRenderer.sendToHost('zoom-changed', Math.round(webFrame.getZoomFactor() * 100));
  } else if (e.key === '0') {
    e.preventDefault();
    webFrame.setZoomLevel(0);
    ipcRenderer.sendToHost('zoom-changed', 100);
  }
});

// ═══════ Mouse Back/Forward ═══════

function handleNavButton(e) {
  if (e.button === 3) { e.preventDefault(); e.stopImmediatePropagation(); ipcRenderer.sendToHost('nav-back'); }
  else if (e.button === 4) { e.preventDefault(); e.stopImmediatePropagation(); ipcRenderer.sendToHost('nav-forward'); }
}
document.addEventListener('mousedown', handleNavButton, true);
document.addEventListener('pointerdown', (e) => {
  if (e.button === 3) { e.preventDefault(); ipcRenderer.sendToHost('nav-back'); }
  else if (e.button === 4) { e.preventDefault(); ipcRenderer.sendToHost('nav-forward'); }
}, true);
document.addEventListener('mouseup', (e) => {
  if (e.button === 3 || e.button === 4) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
document.addEventListener('auxclick', (e) => {
  if (e.button === 3) { e.preventDefault(); ipcRenderer.sendToHost('nav-back'); }
  else if (e.button === 4) { e.preventDefault(); ipcRenderer.sendToHost('nav-forward'); }
}, true);

// ═══════ Mouse Gestures (Right-click drag) ═══════

let gestureActive = false;
let gestureStartX = 0, gestureStartY = 0;
let gestureOverlay = null;

document.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    gestureActive = true;
    gestureStartX = e.screenX;
    gestureStartY = e.screenY;
  }
}, true);

document.addEventListener('mousemove', (e) => {
  if (!gestureActive) return;
  const dx = e.screenX - gestureStartX;
  const dy = e.screenY - gestureStartY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 30 && !gestureOverlay) {
    gestureOverlay = document.createElement('div');
    Object.assign(gestureOverlay.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      background: 'rgba(0,0,0,0.7)', color: '#fff', padding: '12px 24px',
      borderRadius: '8px', fontSize: '24px', zIndex: '2147483647', pointerEvents: 'none',
    });
    document.body.appendChild(gestureOverlay);
  }
  if (gestureOverlay && dist > 30) {
    const absDx = Math.abs(dx), absDy = Math.abs(dy);
    let dir = '';
    if (absDx > absDy) dir = dx > 0 ? '→ 앞으로' : '← 뒤로';
    else dir = dy > 0 ? '↓ 새 탭' : '↑ 탭 닫기';
    gestureOverlay.textContent = dir;
  }
}, true);

document.addEventListener('mouseup', (e) => {
  if (e.button !== 2 || !gestureActive) { gestureActive = false; return; }
  gestureActive = false;
  const dx = e.screenX - gestureStartX;
  const dy = e.screenY - gestureStartY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (gestureOverlay) {
    gestureOverlay.remove();
    gestureOverlay = null;
  }

  if (dist > 50) {
    e.preventDefault();
    e.stopPropagation();
    const absDx = Math.abs(dx), absDy = Math.abs(dy);
    let gesture;
    if (absDx > absDy) gesture = dx > 0 ? 'right' : 'left';
    else gesture = dy > 0 ? 'down' : 'up';
    ipcRenderer.sendToHost('gesture', gesture);
  }
}, true);

document.addEventListener('contextmenu', (e) => {
  const dx = Math.abs(e.screenX - gestureStartX);
  const dy = Math.abs(e.screenY - gestureStartY);
  if (Math.sqrt(dx*dx + dy*dy) > 50) e.preventDefault();
}, true);

// ═══════ Password Detection & Auto-fill ═══════

function getAllPwFields() {
  return [...document.querySelectorAll('input[type="password"]')];
}

function getVisiblePwFields() {
  return getAllPwFields().filter(el => {
    if (el.offsetParent !== null) return true;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function findUsername(pwField) {
  const scopes = [
    pwField.closest('form'),
    pwField.closest('[role="dialog"]'),
    pwField.closest('.login, .sign-in, .signin, .auth, [class*="login"], [class*="auth"]'),
    pwField.parentElement?.parentElement?.parentElement,
    document,
  ].filter(Boolean);

  const selectors = [
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="text"][name*="user" i]',
    'input[type="text"][name*="login" i]',
    'input[type="text"][name*="id" i]',
    'input[type="text"][name*="mail" i]',
    'input[type="text"][name*="account" i]',
    'input[type="text"][id*="user" i]',
    'input[type="text"][id*="login" i]',
    'input[type="text"][id*="id" i]',
    'input[type="text"][id*="mail" i]',
    'input[type="text"][id*="email" i]',
    'input[type="text"]',
    'input:not([type])',
  ];

  for (const scope of scopes) {
    for (const s of selectors) {
      for (const el of scope.querySelectorAll(s)) {
        if (el !== pwField && el.type !== 'hidden' && el.value) return el;
      }
    }
  }
  return null;
}

function setVal(el, val) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, val);
  else el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

ipcRenderer.on('pw-fill', (_e, creds) => {
  if (!creds?.length) return;
  const tryFill = () => {
    const pws = getVisiblePwFields();
    if (!pws.length) return false;
    const c = creds[0];
    const userField = findUsername(pws[0]);
    if (userField && c.username) setVal(userField, c.username);
    if (c.password) setVal(pws[0], c.password);
    return true;
  };
  if (!tryFill()) {
    setTimeout(tryFill, 500);
    setTimeout(tryFill, 1500);
  }
});

function capture(pwField) {
  const pw = pwField.value;
  if (!pw || pw.length < 1) return;
  const userEl = findUsername(pwField);
  const username = userEl ? userEl.value : '';
  const key = `${location.hostname}|${username}|${pw}`;
  if (key === lastKey) return;
  lastKey = key;
  ipcRenderer.sendToHost('pw-submit', {
    domain: location.hostname,
    url: location.href,
    username,
    password: pw,
  });
}

function captureAll() {
  const pws = getAllPwFields().filter(el => el.value);
  pws.forEach(pw => capture(pw));
}

function hookForms() {
  getAllPwFields().forEach(pw => {
    if (pw.__pwHooked) return;
    pw.__pwHooked = true;

    const form = pw.closest('form');
    if (form && !form.__pwFormHooked) {
      form.__pwFormHooked = true;
      form.addEventListener('submit', () => capture(pw), true);
    }

    pw.addEventListener('change', () => {
      if (pw.value) setTimeout(() => capture(pw), 200);
    });
  });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest(
    'button, input[type="submit"], [role="button"], [type="button"], a[href], ' +
    '[class*="submit" i], [class*="login" i], [class*="sign" i], [id*="submit" i], [id*="login" i]'
  );
  if (!btn) return;
  setTimeout(captureAll, 300);
  setTimeout(captureAll, 800);
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  setTimeout(captureAll, 300);
  setTimeout(captureAll, 800);
}, true);

window.addEventListener('beforeunload', () => {
  captureAll();
});

function scanAndNotify() {
  hookForms();
  const pws = getVisiblePwFields();
  if (pws.length) {
    ipcRenderer.sendToHost('pw-detected', { domain: location.hostname });
  }
}

function init() {
  ipcRenderer.sendToHost('preload-ready', { domain: location.hostname });
  setTimeout(scanAndNotify, 500);
  setTimeout(scanAndNotify, 1500);
  setTimeout(scanAndNotify, 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

new MutationObserver(() => {
  hookForms();
  const pws = getVisiblePwFields();
  if (pws.length) {
    ipcRenderer.sendToHost('pw-detected', { domain: location.hostname });
  }
}).observe(document.documentElement, { childList: true, subtree: true });

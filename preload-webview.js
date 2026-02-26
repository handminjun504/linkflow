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

function visiblePwFields() {
  return [...document.querySelectorAll('input[type="password"]')].filter(
    el => el.offsetParent !== null
  );
}

function findUsername(pwField) {
  const scope = pwField.closest('form') || pwField.closest('div')?.parentElement || document;
  const selectors = [
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[type="text"][name*="user" i]',
    'input[type="text"][name*="login" i]',
    'input[type="text"][name*="id" i]',
    'input[type="text"][name*="mail" i]',
    'input[type="text"][name*="account" i]',
    'input[type="text"][id*="user" i]',
    'input[type="text"][id*="login" i]',
    'input[type="text"][id*="id" i]',
    'input[type="text"][id*="mail" i]',
    'input[type="text"]',
    'input:not([type])',
  ];
  for (const s of selectors) {
    for (const el of scope.querySelectorAll(s)) {
      if (el.offsetParent !== null && el !== pwField && el.type !== 'hidden') return el;
    }
  }
  return null;
}

function setVal(el, val) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

ipcRenderer.on('pw-fill', (_e, creds) => {
  if (!creds?.length) return;
  const pws = visiblePwFields();
  if (!pws.length) return;
  const c = creds[0];
  const user = findUsername(pws[0]);
  if (user && c.username) setVal(user, c.username);
  if (c.password) setVal(pws[0], c.password);
});

function capture(pwField) {
  const pw = pwField.value;
  if (!pw) return;
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

function hookForms() {
  const pws = visiblePwFields();
  pws.forEach(pw => {
    const form = pw.closest('form');
    if (form && !form.__pwHooked) {
      form.__pwHooked = true;
      form.addEventListener('submit', () => capture(pw), true);
    }
  });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button, input[type="submit"], [role="button"], [type="button"]');
  if (!btn) return;
  const scope = btn.closest('form') || document;
  const pw = scope.querySelector('input[type="password"]');
  if (pw?.value) setTimeout(() => capture(pw), 300);
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = document.activeElement;
  if (!el) return;
  const scope = el.closest('form') || document;
  const pw = scope.querySelector('input[type="password"]');
  if (pw?.value) setTimeout(() => capture(pw), 300);
}, true);

function init() {
  setTimeout(() => {
    hookForms();
    const pws = visiblePwFields();
    if (pws.length) {
      ipcRenderer.sendToHost('pw-detected', { domain: location.hostname });
    }
  }, 800);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

new MutationObserver(hookForms).observe(document.documentElement, { childList: true, subtree: true });

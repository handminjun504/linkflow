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

let savedCreds = [];
let activeDropdown = null;
let activeField = null;

ipcRenderer.on('pw-fill', (_e, creds) => {
  if (!creds?.length) return;
  savedCreds = creds;
  const tryFill = () => {
    const pws = getVisiblePwFields();
    if (!pws.length) return false;
    if (creds.length === 1) {
      const c = creds[0];
      const userField = findUsername(pws[0]);
      if (userField && c.username) setVal(userField, c.username);
      if (c.password) setVal(pws[0], c.password);
    }
    return true;
  };
  if (!tryFill()) {
    setTimeout(tryFill, 500);
    setTimeout(tryFill, 1500);
  }
});

ipcRenderer.on('pw-dropdown-data', (_e, creds) => {
  savedCreds = creds || [];
  if (savedCreds.length && activeField) showCredDropdown(activeField);
});

function createDropdownStyle() {
  if (document.getElementById('lf-pw-dropdown-style')) return;
  const style = document.createElement('style');
  style.id = 'lf-pw-dropdown-style';
  style.textContent = `
    .lf-pw-dropdown {
      position: absolute; z-index: 2147483647;
      background: #2b2b2b; border: 1px solid #444; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4); min-width: 240px; max-width: 340px;
      overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .lf-pw-dropdown-header {
      padding: 8px 12px; font-size: 11px; color: #999; border-bottom: 1px solid #3a3a3a;
      display: flex; align-items: center; gap: 6px;
    }
    .lf-pw-dropdown-header svg { width: 14px; height: 14px; fill: #999; }
    .lf-pw-item {
      padding: 10px 12px; cursor: pointer; display: flex; align-items: center; gap: 10px;
      transition: background 0.1s;
    }
    .lf-pw-item:hover, .lf-pw-item.lf-active { background: #3a3a3a; }
    .lf-pw-item-icon {
      width: 32px; height: 32px; border-radius: 50%; background: #444;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .lf-pw-item-icon svg { width: 16px; height: 16px; fill: #aaa; }
    .lf-pw-item-info { flex: 1; min-width: 0; }
    .lf-pw-item-user {
      font-size: 13px; color: #e8e8e8; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .lf-pw-item-pw { font-size: 12px; color: #888; }
    .lf-pw-item-edit {
      width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
      border-radius: 4px; cursor: pointer; opacity: 0; transition: opacity 0.15s;
    }
    .lf-pw-item:hover .lf-pw-item-edit { opacity: 1; }
    .lf-pw-item-edit svg { width: 14px; height: 14px; fill: #888; }
  `;
  document.head.appendChild(style);
}

function showCredDropdown(field) {
  hideCredDropdown();
  if (!savedCreds.length) return;
  createDropdownStyle();

  const rect = field.getBoundingClientRect();
  const dropdown = document.createElement('div');
  dropdown.className = 'lf-pw-dropdown';
  dropdown.style.left = rect.left + window.scrollX + 'px';
  dropdown.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  dropdown.style.minWidth = Math.max(240, rect.width) + 'px';

  dropdown.innerHTML = `<div class="lf-pw-dropdown-header">
    <svg viewBox="0 0 24 24"><path d="M12 2C9.24 2 7 4.24 7 7v3H6c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-8c0-1.1-.9-2-2-2h-1V7c0-2.76-2.24-5-5-5zm3 10H9v-3c0-1.66 1.34-3 3-3s3 1.34 3 3v3z"/></svg>
    LinkFlow 저장된 비밀번호
  </div>`;

  savedCreds.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = 'lf-pw-item';
    if (i === 0) item.classList.add('lf-active');
    item.innerHTML = `
      <div class="lf-pw-item-icon"><svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>
      <div class="lf-pw-item-info">
        <div class="lf-pw-item-user">${c.username || '(사용자 없음)'}</div>
        <div class="lf-pw-item-pw">••••••••</div>
      </div>`;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fillCredential(c, field);
      hideCredDropdown();
    });
    dropdown.appendChild(item);
  });

  document.body.appendChild(dropdown);
  activeDropdown = dropdown;

  const viewH = window.innerHeight;
  const dropRect = dropdown.getBoundingClientRect();
  if (dropRect.bottom > viewH) {
    dropdown.style.top = (rect.top + window.scrollY - dropRect.height - 4) + 'px';
  }
}

function hideCredDropdown() {
  if (activeDropdown) {
    activeDropdown.remove();
    activeDropdown = null;
  }
}

function fillCredential(cred, field) {
  const pws = getVisiblePwFields();
  const pwField = pws[0];

  if (field.type === 'password') {
    const userField = findUsername(field);
    if (userField && cred.username) setVal(userField, cred.username);
    if (cred.password) setVal(field, cred.password);
  } else {
    if (cred.username) setVal(field, cred.username);
    if (pwField && cred.password) setVal(pwField, cred.password);
  }
}

function setupFieldDropdowns() {
  const allInputs = [
    ...getVisiblePwFields(),
    ...document.querySelectorAll(
      'input[autocomplete="username"], input[autocomplete="email"], input[type="email"], ' +
      'input[type="text"][name*="user" i], input[type="text"][name*="login" i], ' +
      'input[type="text"][name*="id" i], input[type="text"][name*="mail" i], ' +
      'input[type="text"][id*="user" i], input[type="text"][id*="login" i], ' +
      'input[type="text"][id*="email" i]'
    ),
  ];

  allInputs.forEach(input => {
    if (input.__lfDropdownHooked) return;
    input.__lfDropdownHooked = true;

    input.addEventListener('focus', () => {
      activeField = input;
      if (savedCreds.length) {
        showCredDropdown(input);
      } else {
        ipcRenderer.sendToHost('pw-request-creds', { domain: location.hostname });
      }
    });
    input.addEventListener('blur', () => {
      setTimeout(hideCredDropdown, 200);
    });
    input.addEventListener('keydown', (e) => {
      if (!activeDropdown) return;
      const items = activeDropdown.querySelectorAll('.lf-pw-item');
      const current = activeDropdown.querySelector('.lf-pw-item.lf-active');
      let idx = [...items].indexOf(current);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        idx = Math.min(idx + 1, items.length - 1);
        items.forEach((it, i) => it.classList.toggle('lf-active', i === idx));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = Math.max(idx - 1, 0);
        items.forEach((it, i) => it.classList.toggle('lf-active', i === idx));
      } else if (e.key === 'Enter' && current) {
        e.preventDefault();
        fillCredential(savedCreds[idx], input);
        hideCredDropdown();
      } else if (e.key === 'Escape') {
        hideCredDropdown();
      }
    });
  });
}

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
  setupFieldDropdowns();
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
  setupFieldDropdowns();
  const pws = getVisiblePwFields();
  if (pws.length) {
    ipcRenderer.sendToHost('pw-detected', { domain: location.hostname });
  }
}).observe(document.documentElement, { childList: true, subtree: true });

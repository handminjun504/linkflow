(() => {
  let tabs = [];
  let activeId = null;
  let counter = 0;
  let APP_URL = '';

  const $tabs = document.getElementById('tab-list');
  const $views = document.getElementById('webview-container');
  const $url = document.getElementById('url-input');
  const $splash = document.getElementById('splash');

  async function init() {
    APP_URL = await window.electronAPI.getAppUrl();
    createTab(APP_URL, '통합접속', true);
    bind();
  }

  function bind() {
    document.getElementById('btn-back').addEventListener('click', goBack);
    document.getElementById('btn-forward').addEventListener('click', goForward);
    document.getElementById('btn-reload').addEventListener('click', reload);
    document.getElementById('btn-home').addEventListener('click', () => navTo(APP_URL));
    document.getElementById('btn-devtools').addEventListener('click', devtools);

    $url.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        let v = $url.value.trim();
        if (!v) return;
        if (!v.match(/^https?:\/\//)) v = 'https://' + v;
        navTo(v);
      }
    });
    $url.addEventListener('focus', () => $url.select());

    window.electronAPI.onOpenInTab(url => createTab(url));

    window.electronAPI.onShortcut(action => {
      const map = {
        'toggle-devtools': devtools,
        'new-tab': () => createTab(APP_URL),
        'close-tab': closeActive,
        'next-tab': () => cycle(1),
        'prev-tab': () => cycle(-1),
        'focus-url': () => $url.focus(),
        'reload-tab': reload,
      };
      if (map[action]) map[action]();
    });
  }

  // ── Tab CRUD ──

  function createTab(url, title, isHome = false) {
    const id = ++counter;
    const wv = document.createElement('webview');
    wv.src = url;
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('partition', 'persist:main');
    $views.appendChild(wv);

    const t = { id, url, title: title || '새 탭', wv, isHome, loading: true };
    tabs.push(t);

    wv.addEventListener('page-title-updated', e => {
      if (!isHome) t.title = e.title || t.title;
      updateTabEl(t);
    });
    wv.addEventListener('page-favicon-updated', e => {
      if (e.favicons?.[0]) { t.favicon = e.favicons[0]; updateTabEl(t); }
    });
    wv.addEventListener('did-navigate', e => { t.url = e.url; if (t.id === activeId) $url.value = e.url; });
    wv.addEventListener('did-navigate-in-page', e => { if (e.isMainFrame) { t.url = e.url; if (t.id === activeId) $url.value = e.url; } });
    wv.addEventListener('did-start-loading', () => { t.loading = true; });
    wv.addEventListener('did-stop-loading', () => {
      t.loading = false;
      if (t.isHome && $splash && !$splash.classList.contains('hidden')) {
        $splash.classList.add('hidden');
        setTimeout(() => $splash.remove(), 300);
      }
    });
    wv.addEventListener('dom-ready', () => {
      if (t.isHome && $splash && !$splash.classList.contains('hidden')) {
        $splash.classList.add('hidden');
        setTimeout(() => $splash.remove(), 300);
      }
    });
    renderTabs();
    activate(id);
    return t;
  }

  function closeTab(id) {
    const i = tabs.findIndex(t => t.id === id);
    if (i < 0 || tabs[i].isHome) return;
    tabs[i].wv.remove();
    tabs.splice(i, 1);
    if (activeId === id) activate(tabs[Math.min(i, tabs.length - 1)].id);
    renderTabs();
  }

  function closeActive() {
    const t = tabs.find(t => t.id === activeId);
    if (t && !t.isHome) closeTab(activeId);
  }

  function activate(id) {
    activeId = id;
    tabs.forEach(t => t.wv.classList.toggle('active', t.id === id));
    const t = tabs.find(t => t.id === id);
    if (t) $url.value = t.url || '';
    renderTabs();
  }

  function cycle(dir) {
    if (tabs.length < 2) return;
    const i = tabs.findIndex(t => t.id === activeId);
    activate(tabs[(i + dir + tabs.length) % tabs.length].id);
  }

  // ── Navigation ──

  function navTo(url) {
    const t = tabs.find(t => t.id === activeId);
    if (t) { t.wv.loadURL(url); t.url = url; $url.value = url; }
  }
  function goBack() { const t = active(); if (t?.wv.canGoBack()) t.wv.goBack(); }
  function goForward() { const t = active(); if (t?.wv.canGoForward()) t.wv.goForward(); }
  function reload() { const t = active(); if (t) t.wv.reload(); }
  function devtools() {
    const t = active();
    if (t) window.electronAPI.toggleDevTools(t.wv.getWebContentsId());
  }
  function active() { return tabs.find(t => t.id === activeId); }

  // ── Render ──

  function renderTabs() {
    $tabs.innerHTML = '';
    tabs.forEach(t => {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.isHome ? ' home' : '');
      el.dataset.id = t.id;

      if (t.favicon || t.isHome) {
        const img = document.createElement('img');
        img.className = 'tab-fav';
        img.src = t.favicon || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="%234DA8DA"/></svg>');
        img.onerror = () => { img.style.display = 'none'; };
        el.appendChild(img);
      }

      const sp = document.createElement('span');
      sp.className = 'tab-title';
      sp.textContent = t.title;
      el.appendChild(sp);

      if (!t.isHome) {
        const x = document.createElement('button');
        x.className = 'tab-x';
        x.textContent = '×';
        x.addEventListener('click', e => { e.stopPropagation(); closeTab(t.id); });
        el.appendChild(x);
      }

      el.addEventListener('click', () => activate(t.id));
      el.addEventListener('auxclick', e => { if (e.button === 1 && !t.isHome) closeTab(t.id); });
      $tabs.appendChild(el);
    });
  }

  function updateTabEl(t) {
    const el = $tabs.querySelector(`[data-id="${t.id}"]`);
    if (!el) return;
    const sp = el.querySelector('.tab-title');
    if (sp) sp.textContent = t.title;
    const img = el.querySelector('.tab-fav');
    if (img && t.favicon) img.src = t.favicon;
  }

  init();
})();

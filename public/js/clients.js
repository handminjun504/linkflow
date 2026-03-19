const Clients = (() => {
  const FILTERS = [
    { id: 'all', label: '전체' },
    { id: 'active', label: '진행중' },
    { id: 'pending', label: '대기' },
    { id: 'paused', label: '중단' },
    { id: 'closed', label: '종료' },
    { id: 'due_today', label: '오늘 처리' },
    { id: 'overdue', label: '후속조치 지연' },
  ];

  const CLIENTS_TTL = 60 * 1000;
  const STATUS_LABELS = {
    active: '진행중',
    pending: '대기',
    paused: '중단',
    closed: '종료',
  };
  const INTERNAL_ASSIGNEES = new Set([
    '조희경',
    '김나리',
    '금종석',
    '김윤주',
    '김동건',
    '조은',
    '김재우',
    '김유경',
  ]);
  const TIMELINE_ICONS = {
    bookmark: 'ri-bookmark-3-line',
    memo: 'ri-sticky-note-line',
    event: 'ri-calendar-event-line',
  };

  let initialized = false;
  let clients = [];
  let searchQuery = '';
  let filterId = 'all';
  let selectedClientId = null;
  let selectedClient = null;
  let timelineItems = [];
  let bookmarkItems = [];
  let dragClientId = null;
  let customView = null;
  let clientsLoadedAt = 0;
  let clientsLoadPromise = null;
  let persistStateTimer = null;

  function init() {
    if (initialized) return;
    initialized = true;

    restoreState();
    customView = Preferences?.getClientCustomView?.() || null;
    renderFilterPills();
    renderCustomView();

    document.getElementById('btn-add-client')?.addEventListener('click', openCreateModal);
    document.getElementById('client-form')?.addEventListener('submit', createClient);
    document.getElementById('client-detail-form')?.addEventListener('submit', saveSelectedClient);
    document.getElementById('btn-delete-client')?.addEventListener('click', deleteSelectedClient);
    document.getElementById('btn-client-create-event')?.addEventListener('click', () => {
      if (selectedClientId) openActionEvent(selectedClientId);
    });
    document.getElementById('btn-save-client-view')?.addEventListener('click', saveCurrentView);
    document.getElementById('btn-reset-client-filters')?.addEventListener('click', resetFilters);
    document.getElementById('btn-export-clients-csv')?.addEventListener('click', exportCsv);
    document.getElementById('btn-load-client-custom-view')?.addEventListener('click', applyCustomView);
    document.getElementById('btn-clear-client-custom-view')?.addEventListener('click', clearCustomView);
    document.getElementById('btn-link-client-shortcut')?.addEventListener('click', linkSelectedShortcut);
    document.getElementById('clients-search-input')?.addEventListener('input', event => {
      searchQuery = event.target.value.trim();
      persistState();
      render();
    });
    document.getElementById('client-next-actions-list')?.addEventListener('click', handleInboxClick);
    document.getElementById('client-shortcuts-list')?.addEventListener('click', handleShortcutAction);

    document.addEventListener('lf:clients-changed-request', () => load());
    window.addEventListener('lf:bookmarks-changed', event => {
      bookmarkItems = Array.isArray(event.detail?.bookmarks)
        ? event.detail.bookmarks.map(normalizeBookmark)
        : [];
      renderShortcuts();
    });

    if (window.LinkFlowBookmarks?.getAll) {
      bookmarkItems = window.LinkFlowBookmarks.getAll().map(normalizeBookmark);
    }
  }

  async function load(options = {}) {
    if (!Auth.isLoggedIn()) {
      clients = [];
      selectedClient = null;
      timelineItems = [];
      render();
      notifyClientsChanged();
      return [];
    }

    const force = !!options.force;
    const isFresh = clients.length > 0 && (Date.now() - clientsLoadedAt) < CLIENTS_TTL;
    if (!force && isFresh) {
      ensureSelection(options.selectedClientId);
      render();
      notifyClientsChanged();
      if (selectedClientId && !selectedClient) {
        void selectClient(selectedClientId, { silentList: true });
      }
      return clients;
    }

    if (clientsLoadPromise) return clientsLoadPromise;

    clientsLoadPromise = (async () => {
      try {
        const result = await Auth.request('/clients');
        clients = Array.isArray(result) ? result.map(normalizeClient) : [];
        clientsLoadedAt = Date.now();
        ensureSelection(options.selectedClientId);
        render();
        notifyClientsChanged();
        if (selectedClientId) {
          await selectClient(selectedClientId, { silentList: true });
        }
        return clients;
      } catch (err) {
        clients = [];
        selectedClient = null;
        timelineItems = [];
        render();
        notifyClientsChanged();
        if (!options.silent) UI.showToast(err.message, 'error');
        return [];
      } finally {
        clientsLoadPromise = null;
      }
    })();

    return clientsLoadPromise;
  }

  async function selectClient(clientId, options = {}) {
    if (!clientId) {
      selectedClientId = null;
      selectedClient = null;
      timelineItems = [];
      renderDetail();
      renderShortcuts();
      if (!options.silentList) renderList();
      return;
    }

    selectedClientId = clientId;
    if (!options.silentList) renderList();

    try {
      const [client, timeline] = await Promise.all([
        Auth.request(`/clients/${clientId}`),
        Auth.request(`/clients/${clientId}/timeline`).catch(() => []),
      ]);
      selectedClient = normalizeClient(client);
      timelineItems = Array.isArray(timeline) ? timeline : [];
      syncClientIntoList(selectedClient);
      render();
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  function ensureSelection(forcedId = null) {
    const nextId = forcedId || selectedClientId;
    if (!clients.length) {
      selectedClientId = null;
      selectedClient = null;
      timelineItems = [];
      return;
    }
    if (nextId && clients.some(client => client.id === nextId)) {
      selectedClientId = nextId;
      return;
    }
    selectedClientId = clients[0].id;
  }

  function render() {
    renderFilterPills();
    renderCustomView();
    renderInbox();
    renderList();
    renderDetail();
    renderShortcuts();
  }

  function renderFilterPills() {
    const container = document.getElementById('client-filter-pills');
    if (!container) return;
    container.innerHTML = FILTERS.map(filter => `
      <button class="client-filter-pill ${filterId === filter.id ? 'active' : ''}" data-filter="${filter.id}">
        ${escapeHtml(filter.label)}
      </button>
    `).join('');
    container.querySelectorAll('.client-filter-pill').forEach(button => {
      button.addEventListener('click', () => {
        filterId = button.dataset.filter;
        persistState();
        render();
      });
    });
  }

  function renderCustomView() {
    const wrap = document.getElementById('client-custom-view-wrap');
    const button = document.getElementById('btn-load-client-custom-view');
    if (!wrap || !button) return;
    if (!customView) {
      wrap.classList.add('hidden');
      return;
    }
    button.textContent = customView.label || '저장 뷰 적용';
    wrap.classList.remove('hidden');
  }

  function renderInbox() {
    const list = document.getElementById('client-next-actions-list');
    const count = document.getElementById('client-inbox-count');
    if (!list || !count) return;

    const items = getInboxClients();
    count.textContent = String(items.length);

    if (!items.length) {
      list.innerHTML = '<div class="client-inbox-empty"><i class="ri-checkbox-circle-line"></i><p>오늘 처리할 다음 액션이 없습니다</p></div>';
      return;
    }

    list.innerHTML = items.map(client => {
      const overdue = isOverdue(client.next_action_at);
      return `
        <div class="client-inbox-item" data-id="${escapeAttr(client.id)}">
          <div class="client-inbox-body">
            <span class="client-inbox-status ${overdue ? 'overdue' : 'today'}">${overdue ? '지연' : '오늘'}</span>
            <strong>${escapeHtml(getClientDisplayName(client))}</strong>
            <p>${escapeHtml(client.next_action_title || '다음 액션 없음')}</p>
            <span>${formatDate(client.next_action_at)}</span>
          </div>
          <div class="client-inbox-actions">
            <button class="btn btn-outline btn-sm" data-action="event" data-id="${escapeAttr(client.id)}"><i class="ri-calendar-event-line"></i> 일정</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderList() {
    const list = document.getElementById('clients-list');
    const count = document.getElementById('client-list-count');
    if (!list || !count) return;

    const filtered = getFilteredClients();
    count.textContent = String(filtered.length);

    if (!filtered.length) {
      list.innerHTML = '<div class="clients-list-empty"><i class="ri-building-2-line"></i><p>조건에 맞는 거래처가 없습니다</p></div>';
      return;
    }

    const canReorder = filterId === 'all' && !searchQuery;
    list.innerHTML = filtered.map(client => `
      <div
        class="client-list-row ${selectedClientId === client.id ? 'active' : ''}"
        data-id="${escapeAttr(client.id)}"
        draggable="${canReorder ? 'true' : 'false'}"
      >
        <span class="client-cell client-cell-name">
          <span class="client-name-text" title="${escapeAttr(getClientDisplayName(client))}">${escapeHtml(getClientDisplayName(client))}</span>
          ${buildListMeta(client) ? `<small>${escapeHtml(buildListMeta(client))}</small>` : ''}
        </span>
        <span class="client-cell">
          <span class="client-status-pill ${escapeAttr(client.status || 'active')}">${escapeHtml(getStatusLabel(client.status))}</span>
        </span>
        <span class="client-cell">${escapeHtml(client.owner_name || '-')}</span>
        <span class="client-cell">${escapeHtml(formatDate(client.last_contact_at) || '-')}</span>
        <span class="client-cell client-cell-action">${escapeHtml(formatDate(client.next_action_at) || '-')}</span>
      </div>
    `).join('');

    list.querySelectorAll('.client-list-row').forEach(row => {
      row.addEventListener('click', () => selectClient(row.dataset.id));
      if (!canReorder) return;
      row.addEventListener('dragstart', () => {
        dragClientId = row.dataset.id;
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => {
        dragClientId = null;
        row.classList.remove('dragging');
        list.querySelectorAll('.drag-over').forEach(item => item.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', event => {
        event.preventDefault();
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', async event => {
        event.preventDefault();
        row.classList.remove('drag-over');
        if (!dragClientId || dragClientId === row.dataset.id) return;
        await reorderClients(dragClientId, row.dataset.id);
      });
    });
  }

  function renderDetail() {
    const empty = document.getElementById('clients-detail-empty');
    const body = document.getElementById('clients-detail-body');
    if (!empty || !body) return;

    if (!selectedClientId) {
      empty.classList.remove('hidden');
      body.classList.add('hidden');
      return;
    }

    const fallback = clients.find(client => client.id === selectedClientId) || null;
    const client = selectedClient || fallback;
    if (!client) {
      empty.classList.remove('hidden');
      body.classList.add('hidden');
      return;
    }

    empty.classList.add('hidden');
    body.classList.remove('hidden');

    document.getElementById('client-detail-name').textContent = getClientDisplayName(client);
    document.getElementById('client-detail-status-badge').textContent = getStatusLabel(client.status);
    document.getElementById('client-detail-status-badge').className = `clients-detail-status-badge ${client.status || 'active'}`;
    document.getElementById('client-detail-subtitle').textContent = buildSubtitle(client);

    document.getElementById('client-detail-name-input').value = client.name || '';
    document.getElementById('client-detail-status').value = client.status || 'active';
    document.getElementById('client-detail-owner').value = client.owner_name || '';
    document.getElementById('client-detail-company-contact').value = client.company_contact_name || '';
    document.getElementById('client-detail-phone').value = client.phone || '';
    document.getElementById('client-detail-email').value = client.email || '';
    document.getElementById('client-detail-last-contact').value = client.last_contact_at || '';
    document.getElementById('client-detail-next-action-title').value = client.next_action_title || '';
    document.getElementById('client-detail-next-action-at').value = client.next_action_at || '';
    document.getElementById('client-detail-memo').value = client.memo || '';

    document.getElementById('client-detail-next-action-summary').textContent =
      client.next_action_title
        ? `${client.next_action_title}${client.next_action_at ? ` · ${formatDate(client.next_action_at)}` : ''}`
        : '미정';
    document.getElementById('client-detail-last-contact-summary').textContent =
      formatDate(client.last_contact_at) || '기록 없음';

    renderTimeline();
  }

  function renderShortcuts() {
    const list = document.getElementById('client-shortcuts-list');
    const count = document.getElementById('client-shortcuts-count');
    if (!list || !count) return;

    const client = selectedClient || clients.find(item => item.id === selectedClientId) || null;
    if (!client) {
      count.textContent = '0';
      list.innerHTML = '';
      populateShortcutSelect('');
      return;
    }

    const linked = getLinkedBookmarks(client.id);
    const suggested = getSuggestedBookmarks(client.id);
    const items = [
      ...linked.map(bookmark => ({ bookmark, mode: 'linked' })),
      ...suggested.map(bookmark => ({ bookmark, mode: 'suggested' })),
    ];

    count.textContent = String(items.length);
    populateShortcutSelect(client.id);

    if (!items.length) {
      list.innerHTML = '<div class="client-shortcut-empty"><i class="ri-links-line"></i><p>연결된 바로가기나 공용 거래처 바로가기가 없습니다</p></div>';
      return;
    }

    list.innerHTML = items.map(({ bookmark, mode }) => {
      const editable = isBookmarkEditable(bookmark);
      const badgeClass = mode === 'linked'
        ? (bookmark.is_shared ? 'shared' : 'linked')
        : 'suggested';
      const badgeLabel = mode === 'linked'
        ? (bookmark.is_shared ? '공용 연결' : '연결됨')
        : '공용 바로가기';

      return `
        <div class="client-shortcut-item">
          <div class="client-shortcut-main">
            <strong>${escapeHtml(bookmark.title || '북마크')}</strong>
            <small>${escapeHtml(getBookmarkHost(bookmark.url) || bookmark.url || '')}</small>
          </div>
          <div class="client-shortcut-actions">
            <span class="client-shortcut-badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
            <button class="btn btn-outline btn-sm" data-action="open-shortcut" data-id="${escapeAttr(bookmark.id)}"><i class="ri-external-link-line"></i> 열기</button>
            ${mode === 'suggested' && editable ? `<button class="btn btn-ghost btn-sm" data-action="attach-shortcut" data-id="${escapeAttr(bookmark.id)}"><i class="ri-link"></i> 연결</button>` : ''}
            ${mode === 'linked' && editable ? `<button class="btn btn-ghost btn-sm" data-action="detach-shortcut" data-id="${escapeAttr(bookmark.id)}"><i class="ri-link-unlink"></i> 해제</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderTimeline() {
    const list = document.getElementById('client-timeline-list');
    const count = document.getElementById('client-timeline-count');
    if (!list || !count) return;
    count.textContent = String(timelineItems.length);

    if (!timelineItems.length) {
      list.innerHTML = '<div class="client-timeline-empty"><i class="ri-time-line"></i><p>연결된 활동이 아직 없습니다</p></div>';
      return;
    }

    list.innerHTML = timelineItems.map(item => `
      <div class="client-timeline-item">
        <div class="client-timeline-icon">
          <i class="${TIMELINE_ICONS[item.entity_type] || 'ri-time-line'}"></i>
        </div>
        <div class="client-timeline-content">
          <div class="client-timeline-head">
            <strong>${escapeHtml(item.label || '활동')}</strong>
            <span>${escapeHtml(formatDateTime(item.occurred_at) || '-')}</span>
          </div>
          <p>${escapeHtml(item.title || '')}</p>
          ${item.description ? `<small>${escapeHtml(trimText(item.description, 140))}</small>` : ''}
        </div>
      </div>
    `).join('');
  }

  async function createClient(event) {
    event.preventDefault();
    const payload = readClientForm({
      name: 'client-name',
      status: 'client-status',
      owner: 'client-owner',
      companyContact: 'client-company-contact',
      phone: 'client-phone',
      email: 'client-email',
      lastContact: 'client-last-contact',
      nextActionTitle: 'client-next-action-title',
      nextActionAt: 'client-next-action-at',
      memo: 'client-memo',
    });
    try {
      const created = await Auth.request('/clients', {
        method: 'POST',
        body: JSON.stringify(toClientApiPayload(payload)),
      });
      clientsLoadedAt = Date.now();
      UI.closeModal('client-modal');
      UI.showToast('거래처가 추가되었습니다', 'success');
      await load({ selectedClientId: created.id, force: true });
      await selectClient(created.id);
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  async function saveSelectedClient(event) {
    event.preventDefault();
    if (!selectedClientId) return;
    const payload = readClientForm({
      name: 'client-detail-name-input',
      status: 'client-detail-status',
      owner: 'client-detail-owner',
      companyContact: 'client-detail-company-contact',
      phone: 'client-detail-phone',
      email: 'client-detail-email',
      lastContact: 'client-detail-last-contact',
      nextActionTitle: 'client-detail-next-action-title',
      nextActionAt: 'client-detail-next-action-at',
      memo: 'client-detail-memo',
    });
    try {
      const updated = await Auth.request(`/clients/${selectedClientId}`, {
        method: 'PUT',
        body: JSON.stringify(toClientApiPayload(payload)),
      });
      selectedClient = normalizeClient(updated);
      clientsLoadedAt = Date.now();
      syncClientIntoList(updated);
      UI.showToast('거래처가 저장되었습니다', 'success');
      render();
      notifyClientsChanged();
      await selectClient(selectedClientId, { silentList: true });
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  async function deleteSelectedClient() {
    if (!selectedClientId) return;
    const ok = await UI.confirm('거래처 삭제', '연결 정보는 해제되고 거래처만 삭제됩니다. 계속하시겠습니까?');
    if (!ok) return;
    try {
      await Auth.request(`/clients/${selectedClientId}`, { method: 'DELETE' });
      UI.showToast('거래처가 삭제되었습니다', 'success');
      const removedId = selectedClientId;
      selectedClientId = null;
      selectedClient = null;
      timelineItems = [];
      clients = clients.filter(client => client.id !== removedId);
      clientsLoadedAt = Date.now();
      ensureSelection();
      render();
      notifyClientsChanged();
      if (selectedClientId) {
        await selectClient(selectedClientId, { silentList: true });
      }
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  async function reorderClients(fromId, toId) {
    const fromIndex = clients.findIndex(client => client.id === fromId);
    const toIndex = clients.findIndex(client => client.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;

    const [moved] = clients.splice(fromIndex, 1);
    clients.splice(toIndex, 0, moved);
    clients = clients.map((client, index) => ({ ...client, sort_order: index }));
    renderList();

    try {
      await Auth.request('/clients/reorder', {
        method: 'PATCH',
        body: JSON.stringify({
          items: clients.map((client, index) => ({ id: client.id, sort_order: index })),
        }),
      });
    } catch (err) {
      UI.showToast(err.message || '순서 저장 실패', 'error');
      await load({ selectedClientId, force: true });
    }
  }

  function handleInboxClick(event) {
    const eventButton = event.target.closest('[data-action="event"]');
    if (eventButton) {
      event.stopPropagation();
      openActionEvent(eventButton.dataset.id);
      return;
    }

    const row = event.target.closest('.client-inbox-item');
    if (!row) return;
    selectClient(row.dataset.id);
  }

  async function handleShortcutAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const bookmarkId = button.dataset.id;
    const bookmark = bookmarkItems.find(item => item.id === bookmarkId);
    if (!bookmark) return;

    if (button.dataset.action === 'open-shortcut') {
      if (window.LinkFlowBookmarks?.openById) window.LinkFlowBookmarks.openById(bookmarkId);
      else if (bookmark.url) window.open(bookmark.url, '_blank', 'noopener');
      return;
    }

    if (button.dataset.action === 'attach-shortcut' && selectedClientId) {
      await updateBookmarkClientLink(bookmarkId, selectedClientId, '바로가기를 거래처에 연결했습니다');
      return;
    }

    if (button.dataset.action === 'detach-shortcut') {
      await updateBookmarkClientLink(bookmarkId, null, '바로가기를 거래처에서 해제했습니다');
    }
  }

  function openCreateModal() {
    document.getElementById('client-form').reset();
    document.getElementById('client-status').value = 'active';
    UI.openModal('client-modal');
    document.getElementById('client-name')?.focus();
  }

  function openActionEvent(clientId) {
    const client = clients.find(item => item.id === clientId) || selectedClient;
    if (!client) return;

    document.querySelector('.main-tab[data-tab="calendar"]')?.click();
    setTimeout(() => {
      Calendar?.openPrefilledEvent?.({
        date: client.next_action_at || todayString(),
        title: client.next_action_title || `${getClientDisplayName(client)} 후속 조치`,
        clientId: client.id,
        isTask: true,
        description: client.memo || '',
      });
    }, 50);
  }

  function readClientForm(ids) {
    const field = key => document.getElementById(ids[key]);
    return {
      name: field('name').value.trim(),
      status: field('status').value,
      owner_name: field('owner').value.trim() || null,
      company_contact_name: field('companyContact').value.trim() || null,
      phone: field('phone').value.trim() || null,
      email: field('email').value.trim() || null,
      last_contact_at: field('lastContact').value || null,
      next_action_title: field('nextActionTitle').value.trim() || null,
      next_action_at: field('nextActionAt').value || null,
      memo: field('memo').value.trim() || null,
    };
  }

  function getFilteredClients() {
    return clients.filter(client => {
      if (!matchesFilter(client, filterId)) return false;
      if (!searchQuery) return true;
      const haystack = [
        client.name,
        client.owner_name,
        client.company_contact_name,
        client.memo,
        client.__rawMemo,
        client.email,
        client.phone,
        client.__legacy?.code,
        client.next_action_title,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(searchQuery.toLowerCase());
    });
  }

  function getInboxClients() {
    return clients
      .filter(client => !!client.next_action_at && (isToday(client.next_action_at) || isOverdue(client.next_action_at)))
      .sort((left, right) => (left.next_action_at || '').localeCompare(right.next_action_at || ''));
  }

  function matchesFilter(client, activeFilter) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'due_today') return isToday(client.next_action_at);
    if (activeFilter === 'overdue') return isOverdue(client.next_action_at);
    return (client.status || 'active') === activeFilter;
  }

  function getClientName(clientId) {
    if (!clientId) return '';
    const client = clients.find(item => item.id === clientId);
    return client ? getClientDisplayName(client) : '';
  }

  function populateSelect(target, selectedValue = '') {
    const select = typeof target === 'string' ? document.getElementById(target) : target;
    if (!select) return;
    const currentValue = selectedValue || select.value || '';
    select.innerHTML =
      '<option value="">없음</option>' +
      clients
        .map(client => `<option value="${escapeAttr(client.id)}">${escapeHtml(getClientDisplayName(client))}</option>`)
        .join('');
    select.value = currentValue;
  }

  function populateShortcutSelect(clientId) {
    const select = document.getElementById('client-shortcut-select');
    const button = document.getElementById('btn-link-client-shortcut');
    if (!select || !button) return;

    if (!clientId) {
      select.innerHTML = '<option value="">연결할 북마크 없음</option>';
      select.disabled = true;
      button.disabled = true;
      return;
    }

    const linkedIds = new Set(getLinkedBookmarks(clientId).map(bookmark => bookmark.id));
    const candidates = bookmarkItems.filter(bookmark =>
      !linkedIds.has(bookmark.id) &&
      !bookmark.client_id &&
      isBookmarkEditable(bookmark)
    );
    if (!candidates.length) {
      select.innerHTML = '<option value="">연결할 북마크 없음</option>';
      select.disabled = true;
      button.disabled = true;
      return;
    }

    select.disabled = false;
    button.disabled = false;
    select.innerHTML = '<option value="">북마크 선택</option>' + candidates
      .map(bookmark => `<option value="${escapeAttr(bookmark.id)}">${escapeHtml(bookmark.title || '북마크')}</option>`)
      .join('');
  }

  async function linkSelectedShortcut() {
    const select = document.getElementById('client-shortcut-select');
    if (!select || !selectedClientId || !select.value) return;
    await updateBookmarkClientLink(select.value, selectedClientId, '바로가기를 거래처에 연결했습니다');
  }

  async function updateBookmarkClientLink(bookmarkId, clientId, successMessage) {
    try {
      await Auth.request(`/bookmarks/${bookmarkId}`, {
        method: 'PUT',
        body: JSON.stringify({ client_id: clientId }),
      });
      UI.showToast(successMessage, 'success');
      if (window.LinkFlowBookmarks?.refresh) {
        await window.LinkFlowBookmarks.refresh();
      } else {
        const index = bookmarkItems.findIndex(item => item.id === bookmarkId);
        if (index >= 0) bookmarkItems[index] = { ...bookmarkItems[index], client_id: clientId };
        renderShortcuts();
      }
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  function saveCurrentView() {
    customView = {
      label: searchQuery ? `저장 뷰 · ${searchQuery}` : `저장 뷰 · ${getFilterLabel(filterId)}`,
      filterId,
      searchQuery,
    };
    renderCustomView();
    Promise.resolve(Preferences?.setClientCustomView?.(customView))
      .then(() => {
        UI.showToast('현재 보기를 저장했습니다', 'success');
      })
      .catch(err => {
        UI.showToast(err?.message || '저장 뷰 저장 실패', 'error');
      });
  }

  function applyCustomView() {
    if (!customView) return;
    filterId = customView.filterId || 'all';
    searchQuery = customView.searchQuery || '';
    const searchInput = document.getElementById('clients-search-input');
    if (searchInput) searchInput.value = searchQuery;
    persistState();
    render();
  }

  function clearCustomView() {
    customView = null;
    renderCustomView();
    Promise.resolve(Preferences?.setClientCustomView?.(null))
      .then(() => {
        UI.showToast('저장 뷰를 삭제했습니다', 'success');
      })
      .catch(err => {
        UI.showToast(err?.message || '저장 뷰 삭제 실패', 'error');
      });
  }

  function resetFilters() {
    filterId = 'all';
    searchQuery = '';
    const searchInput = document.getElementById('clients-search-input');
    if (searchInput) searchInput.value = '';
    persistState();
    render();
  }

  function exportCsv() {
    const rows = getFilteredClients();
    const headers = ['거래처명', '상태', '경리팀 담당자', '기업 내부 담당자', '연락처', '이메일', '최근 접촉일', '다음 액션', '다음 액션일', '메모'];
    const lines = [
      headers.join(','),
      ...rows.map(client => [
        getClientDisplayName(client),
        getStatusLabel(client.status),
        client.owner_name || '',
        client.company_contact_name || '',
        client.phone || '',
        client.email || '',
        client.last_contact_at || '',
        client.next_action_title || '',
        client.next_action_at || '',
        client.memo || '',
      ].map(csvEscape).join(',')),
    ];
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `linkflow-clients-${todayString()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function syncClientIntoList(client) {
    const normalized = normalizeClient(client);
    const index = clients.findIndex(item => item.id === normalized.id);
    if (index >= 0) {
      clients[index] = { ...clients[index], ...normalized };
    }
  }

  function notifyClientsChanged() {
    window.dispatchEvent(new CustomEvent('lf:clients-changed', {
      detail: { clients: clients.slice() },
    }));
  }

  function persistState() {
    if (persistStateTimer) clearTimeout(persistStateTimer);
    const nextState = { filterId, searchQuery };
    persistStateTimer = setTimeout(() => {
      persistStateTimer = null;
      if (Preferences?.setClientViewState) {
        void Preferences.setClientViewState(nextState);
      }
    }, 250);
  }

  function restoreState() {
    const raw = Preferences?.getClientViewState?.() || {};
    if (raw.filterId) filterId = raw.filterId;
    if (raw.searchQuery) searchQuery = raw.searchQuery;
    const searchInput = document.getElementById('clients-search-input');
    if (searchInput) searchInput.value = searchQuery;
  }

  function buildSubtitle(client) {
    const parts = [];
    if (client.owner_name) parts.push(`경리팀 ${client.owner_name}`);
    if (client.company_contact_name) parts.push(`기업 ${client.company_contact_name}`);
    if (client.phone) parts.push(formatPhoneForDisplay(client.phone));
    if (client.email) parts.push(client.email);
    if (parts.length) return parts.join(' · ');
    if (client.__legacy?.code) return `거래처 코드 ${client.__legacy.code}`;
    return '담당자와 연락 정보를 추가해두면 여기서 바로 보입니다.';
  }

  function buildListMeta(client) {
    if (client.next_action_title) return client.next_action_title;
    const parts = [];
    if (client.company_contact_name) parts.push(`기업 ${client.company_contact_name}`);
    if (client.__legacy?.code) parts.push(`코드 ${client.__legacy.code}`);
    if (client.email) parts.push(client.email);
    return parts.join(' · ');
  }

  function getClientDisplayName(client) {
    return normalizeText(client?.name) || normalizeEmail(client?.gyeongli_id) || '이름 미지정';
  }

  function normalizeClient(client) {
    const base = { ...(client || {}) };
    const legacy = parseLegacyMemo(base.memo || '');
    let ownerName = normalizeText(base.owner_name) || legacy.ownerName || '';
    let companyContactName = legacy.companyContactName || '';
    if (ownerName && !isKnownInternalAssignee(ownerName) && !companyContactName) {
      companyContactName = ownerName;
      ownerName = '';
    }
    const phone = normalizePhone(base.phone) || legacy.managerPhone || legacy.ceoPhone || '';
    const email = normalizeEmail(base.email) || normalizeEmail(base.gyeongli_id) || '';

    return {
      ...base,
      name: normalizeText(base.name) || normalizeEmail(base.gyeongli_id) || '이름 미지정',
      owner_name: ownerName || null,
      company_contact_name: companyContactName || null,
      phone: phone || null,
      email: email || null,
      memo: cleanLegacyMemo(base.memo || '', {
        removeOwner: Boolean(ownerName),
        removeCompanyContact: Boolean(companyContactName),
        removePhones: Boolean(phone),
      }) || null,
      __rawMemo: base.memo || '',
      __legacy: legacy,
    };
  }

  function normalizeBookmark(bookmark) {
    return { ...(bookmark || {}) };
  }

  function parseLegacyMemo(memo) {
    return {
      code: extractLabeledValue(memo, '코드'),
      ownerName: extractLabeledValue(memo, '담당자'),
      companyContactName:
        extractLabeledValue(memo, '기업내부담당자') ||
        extractContactName(extractLabeledValue(memo, '관리자연락처')),
      managerName: extractContactName(extractLabeledValue(memo, '관리자연락처')),
      managerPhone: extractPhoneNumber(extractLabeledValue(memo, '관리자연락처')),
      ceoPhone: extractPhoneNumber(extractLabeledValue(memo, '대표연락처')),
    };
  }

  function extractLabeledValue(memo, label) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*:\\s*([^|]+)`);
    return normalizeText(pattern.exec(String(memo || ''))?.[1] || '');
  }

  function extractContactName(value) {
    const raw = normalizeText(value);
    if (!raw) return '';
    return normalizeText(
      raw
        .replace(/(?:\+?82[- ]?)?(?:0\d{1,2})[- ]?\d{3,4}[- ]?\d{4}/g, '')
        .replace(/\s+/g, ' ')
    );
  }

  function extractPhoneNumber(value) {
    const match = String(value || '').match(/(?:\+?82[- ]?)?(?:0\d{1,2})[- ]?\d{3,4}[- ]?\d{4}/);
    return normalizePhone(match?.[0] || '');
  }

  function cleanLegacyMemo(memo, options = {}) {
    const segments = String(memo || '')
      .split('|')
      .map(segment => segment.trim())
      .filter(Boolean);
    if (!segments.length) return '';
    return segments
      .filter(segment => {
        if (options.removeOwner && segment.startsWith('담당자:')) return false;
        if (options.removeCompanyContact && segment.startsWith('기업내부담당자:')) return false;
        if (options.removePhones && (segment.startsWith('관리자연락처:') || segment.startsWith('대표연락처:'))) return false;
        return true;
      })
      .join(' | ');
  }

  function toClientApiPayload(formData) {
    return {
      name: formData.name,
      status: formData.status,
      owner_name: formData.owner_name,
      phone: formData.phone,
      email: formData.email,
      last_contact_at: formData.last_contact_at,
      next_action_title: formData.next_action_title,
      next_action_at: formData.next_action_at,
      memo: buildStructuredMemo(formData.memo, formData.company_contact_name),
    };
  }

  function buildStructuredMemo(memo, companyContactName) {
    const segments = String(memo || '')
      .split('|')
      .map(segment => segment.trim())
      .filter(Boolean)
      .filter(segment => !segment.startsWith('기업내부담당자:'));
    if (normalizeText(companyContactName)) {
      segments.push(`기업내부담당자: ${normalizeText(companyContactName)}`);
    }
    return segments.join(' | ') || null;
  }

  function normalizeText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text || '';
  }

  function normalizePhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits || '';
  }

  function normalizeEmail(value) {
    const email = normalizeText(value).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
  }

  function isKnownInternalAssignee(name) {
    return INTERNAL_ASSIGNEES.has(normalizeText(name));
  }

  function formatPhoneForDisplay(value) {
    const digits = normalizePhone(value);
    if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    if (digits.length === 10 && digits.startsWith('02')) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
    if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 9 && digits.startsWith('02')) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
    return value || '';
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getLinkedBookmarks(clientId) {
    return bookmarkItems.filter(bookmark => bookmark.client_id === clientId);
  }

  function getSuggestedBookmarks(clientId) {
    const linkedIds = new Set(getLinkedBookmarks(clientId).map(bookmark => bookmark.id));
    return bookmarkItems.filter(bookmark => {
      if (linkedIds.has(bookmark.id) || bookmark.client_id) return false;
      return isCommonClientShortcut(bookmark);
    });
  }

  function isCommonClientShortcut(bookmark) {
    const haystack = [bookmark.title, bookmark.description].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes('거래처');
  }

  function isBookmarkEditable(bookmark) {
    const userId = Auth.getUser?.()?.sub;
    if (!bookmark) return false;
    if (!bookmark.is_shared) return true;
    return !!userId && bookmark.user_id === userId;
  }

  function getBookmarkHost(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url || '';
    }
  }

  function getFilterLabel(id) {
    return FILTERS.find(filter => filter.id === id)?.label || '전체';
  }

  function getStatusLabel(status) {
    return STATUS_LABELS[status || 'active'] || STATUS_LABELS.active;
  }

  function isToday(dateString) {
    return !!dateString && dateString === todayString();
  }

  function isOverdue(dateString) {
    return !!dateString && dateString < todayString();
  }

  function todayString() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
    if (Number.isNaN(date.getTime())) return value;
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
    if (Number.isNaN(date.getTime())) return value;
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function trimText(text, limit) {
    const raw = String(text || '');
    return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
  }

  function csvEscape(value) {
    const raw = String(value || '');
    return `"${raw.replace(/"/g, '""')}"`;
  }

  function escapeHtml(value) {
    const element = document.createElement('div');
    element.textContent = value || '';
    return element.innerHTML;
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  return {
    init,
    load,
    selectClient,
    getAll: () => clients.slice(),
    getClientName,
    populateSelect,
  };
})();

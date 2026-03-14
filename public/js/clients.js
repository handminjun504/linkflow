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

  const STORAGE_STATE_KEY = 'lf_clients_view_state';
  const STORAGE_CUSTOM_VIEW_KEY = 'lf_clients_custom_view';
  const STATUS_LABELS = {
    active: '진행중',
    pending: '대기',
    paused: '중단',
    closed: '종료',
  };
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
  let dragClientId = null;
  let customView = loadCustomView();

  function init() {
    if (initialized) return;
    initialized = true;

    restoreState();
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
    document.getElementById('clients-search-input')?.addEventListener('input', e => {
      searchQuery = e.target.value.trim();
      persistState();
      render();
    });
    document.getElementById('client-next-actions-list')?.addEventListener('click', handleInboxClick);

    document.addEventListener('lf:clients-changed-request', () => load());
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

    try {
      const result = await Auth.request('/clients');
      clients = Array.isArray(result) ? result : [];
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
    }
  }

  async function selectClient(clientId, options = {}) {
    if (!clientId) {
      selectedClientId = null;
      selectedClient = null;
      timelineItems = [];
      renderDetail();
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
      selectedClient = client;
      timelineItems = Array.isArray(timeline) ? timeline : [];
      syncClientIntoList(client);
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
            <strong>${escapeHtml(client.name)}</strong>
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
          <strong>${escapeHtml(client.name)}</strong>
          ${client.next_action_title ? `<small>${escapeHtml(client.next_action_title)}</small>` : ''}
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

    document.getElementById('client-detail-name').textContent = client.name || '거래처';
    document.getElementById('client-detail-status-badge').textContent = getStatusLabel(client.status);
    document.getElementById('client-detail-status-badge').className = `clients-detail-status-badge ${client.status || 'active'}`;
    document.getElementById('client-detail-subtitle').textContent = buildSubtitle(client);

    document.getElementById('client-detail-name-input').value = client.name || '';
    document.getElementById('client-detail-status').value = client.status || 'active';
    document.getElementById('client-detail-owner').value = client.owner_name || '';
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
        body: JSON.stringify(payload),
      });
      UI.closeModal('client-modal');
      UI.showToast('거래처가 추가되었습니다', 'success');
      await load({ selectedClientId: created.id });
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
        body: JSON.stringify(payload),
      });
      selectedClient = updated;
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
      await load({ selectedClientId });
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
        title: client.next_action_title || `${client.name} 후속 조치`,
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
        client.memo,
        client.email,
        client.phone,
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
    return client ? client.name : '';
  }

  function populateSelect(target, selectedValue = '') {
    const select = typeof target === 'string' ? document.getElementById(target) : target;
    if (!select) return;
    const currentValue = selectedValue || select.value || '';
    select.innerHTML =
      '<option value="">없음</option>' +
      clients
        .map(client => `<option value="${escapeAttr(client.id)}">${escapeHtml(client.name)}</option>`)
        .join('');
    select.value = currentValue;
  }

  function saveCurrentView() {
    customView = {
      label: searchQuery ? `저장 뷰 · ${searchQuery}` : `저장 뷰 · ${getFilterLabel(filterId)}`,
      filterId,
      searchQuery,
    };
    localStorage.setItem(STORAGE_CUSTOM_VIEW_KEY, JSON.stringify(customView));
    renderCustomView();
    UI.showToast('현재 보기를 저장했습니다', 'success');
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
    localStorage.removeItem(STORAGE_CUSTOM_VIEW_KEY);
    renderCustomView();
    UI.showToast('저장 뷰를 삭제했습니다', 'success');
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
    const headers = ['거래처명', '상태', '담당자', '연락처', '이메일', '최근 접촉일', '다음 액션', '다음 액션일', '메모'];
    const lines = [
      headers.join(','),
      ...rows.map(client => [
        client.name || '',
        getStatusLabel(client.status),
        client.owner_name || '',
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
    const index = clients.findIndex(item => item.id === client.id);
    if (index >= 0) {
      clients[index] = { ...clients[index], ...client };
    }
  }

  function notifyClientsChanged() {
    window.dispatchEvent(new CustomEvent('lf:clients-changed', {
      detail: { clients: clients.slice() },
    }));
  }

  function persistState() {
    localStorage.setItem(STORAGE_STATE_KEY, JSON.stringify({ filterId, searchQuery }));
  }

  function restoreState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_STATE_KEY) || '{}');
      if (raw.filterId) filterId = raw.filterId;
      if (raw.searchQuery) searchQuery = raw.searchQuery;
      const searchInput = document.getElementById('clients-search-input');
      if (searchInput) searchInput.value = searchQuery;
    } catch {}
  }

  function loadCustomView() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_CUSTOM_VIEW_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function buildSubtitle(client) {
    const parts = [client.owner_name, client.phone, client.email].filter(Boolean);
    return parts.length ? parts.join(' · ') : '담당자와 연락 정보를 추가해두면 여기서 바로 보입니다.';
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

const Clients = (() => {
  const CLIENTS_CACHE_TTL = 60 * 1000;
  const CLIENT_SYNC_TTL = 5 * 60 * 1000;
  const TIMELINE_ICONS = {
    bookmark: 'ri-bookmark-3-line',
    memo: 'ri-sticky-note-line',
    event: 'ri-calendar-event-line',
  };
  const CLIENT_CATEGORY_LABELS = {
    general: '일반',
    welfare_fund: '사내근로복지기금',
    loan: '대출',
  };

  let initialized = false;
  let clients = [];
  let searchQuery = '';
  let staffFilter = 'all';
  let selectedClientId = null;
  let selectedClient = null;
  let timelineItems = [];
  let bookmarkItems = [];
  let clientsLoadedAt = 0;
  let lastSyncAttemptAt = 0;
  let clientsLoadPromise = null;
  let syncPromise = null;
  let persistStateTimer = null;
  let revealPassword = false;
  let schemaMeta = {
    fixed_fields: [],
    extra_fields: [],
    last_synced_at: null,
    last_error: null,
    sheet_title: null,
    sheet_range: null,
  };

  function init() {
    if (initialized) return;
    initialized = true;

    restoreState();

    document.getElementById('btn-add-client')?.addEventListener('click', openCreateClientModal);
    document.getElementById('btn-edit-client')?.addEventListener('click', () => {
      if (selectedClientId) openEditClientModal(selectedClientId);
    });
    document.getElementById('btn-sync-clients')?.addEventListener('click', manualSync);
    document.getElementById('btn-client-create-event')?.addEventListener('click', () => {
      if (selectedClientId) openActionEvent(selectedClientId);
    });
    document.getElementById('btn-hide-client')?.addEventListener('click', hideSelectedClient);
    document.getElementById('client-form')?.addEventListener('submit', saveClient);
    document.getElementById('client-category')?.addEventListener('change', syncClientCategoryFields);
    document.getElementById('btn-link-client-shortcut')?.addEventListener('click', linkSelectedShortcut);
    document.getElementById('client-shortcuts-list')?.addEventListener('click', handleShortcutAction);
    document.getElementById('clients-search-input')?.addEventListener('input', event => {
      searchQuery = event.target.value.trim();
      persistState();
      renderList();
    });
    document.getElementById('clients-staff-filter')?.addEventListener('click', event => {
      const button = event.target.closest('[data-staff-filter]');
      if (!button) return;
      staffFilter = button.dataset.staffFilter || 'all';
      persistState();
      renderList();
      renderStaffFilter();
    });
    document.getElementById('btn-client-password-toggle')?.addEventListener('click', togglePasswordVisibility);

    document.addEventListener('lf:clients-changed-request', () => {
      void load({ force: true, silent: true });
    });
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
      resetState();
      render();
      notifyClientsChanged();
      return [];
    }

    const force = !!options.force;
    const isFresh = clients.length > 0 && (Date.now() - clientsLoadedAt) < CLIENTS_CACHE_TTL;
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
      if (!options.skipSync && shouldAutoSync(force)) {
        await runSync({ silent: options.silent });
      }

      try {
        const [rows, schema] = await Promise.all([
          Auth.request('/clients'),
          Auth.request('/clients/schema').catch(() => null),
        ]);

        clients = Array.isArray(rows) ? rows.map(normalizeClient) : [];
        clientsLoadedAt = Date.now();
        if (schema && typeof schema === 'object') {
          schemaMeta = {
            ...schemaMeta,
            ...schema,
            last_error: schema.last_error || schemaMeta.last_error,
          };
        }

        ensureSelection(options.selectedClientId);
        render();
        notifyClientsChanged();

        if (selectedClientId) {
          await selectClient(selectedClientId, { silentList: true });
        }

        return clients;
      } catch (err) {
        resetState();
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
      revealPassword = false;
      renderDetail();
      renderShortcuts();
      if (!options.silentList) renderList();
      return;
    }

    selectedClientId = clientId;
    timelineItems = [];
    revealPassword = false;
    if (!options.silentList) renderList();

    const fallback = clients.find(client => client.id === clientId) || null;
    if (fallback) {
      selectedClient = fallback;
      renderDetail();
      renderShortcuts();
    }

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

  async function manualSync() {
    const result = await runSync({ silent: false, manual: true });
    if (!result) return;
    await load({ force: true, skipSync: true, silent: false, selectedClientId });
    UI.showToast('거래처 정보를 시트에서 다시 불러왔습니다', 'success');
  }

  async function runSync(options = {}) {
    if (syncPromise) return syncPromise;
    lastSyncAttemptAt = Date.now();

    syncPromise = (async () => {
      try {
        const result = await Auth.request('/clients/sync', { method: 'POST' });
        schemaMeta = {
          ...schemaMeta,
          last_synced_at: result?.last_synced_at || schemaMeta.last_synced_at,
          last_error: null,
          sheet_title: result?.sheet_title || schemaMeta.sheet_title,
          sheet_range: result?.sheet_range || schemaMeta.sheet_range,
          extra_fields: Array.isArray(result?.extra_fields)
            ? result.extra_fields.map(field => ({ key: field, label: field }))
            : schemaMeta.extra_fields,
        };
        renderSyncState();
        return result;
      } catch (err) {
        schemaMeta = {
          ...schemaMeta,
          last_error: err.message,
        };
        renderSyncState();
        if (!options.silent) UI.showToast(err.message, 'error');
        return null;
      } finally {
        syncPromise = null;
      }
    })();

    return syncPromise;
  }

  function shouldAutoSync(force) {
    if (force) return true;
    if (!lastSyncAttemptAt) return true;
    return (Date.now() - lastSyncAttemptAt) > CLIENT_SYNC_TTL;
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

  function resetState() {
    clients = [];
    selectedClientId = null;
    selectedClient = null;
    timelineItems = [];
    revealPassword = false;
  }

  function render() {
    renderSyncState();
    renderStaffFilter();
    renderList();
    renderDetail();
    renderShortcuts();
  }

  function renderSyncState() {
    const status = document.getElementById('client-sync-status');
    const source = document.getElementById('client-sync-source');
    const button = document.getElementById('btn-sync-clients');
    if (!status || !source || !button) return;

    const lastSyncedText = schemaMeta.last_synced_at
      ? `마지막 동기화 ${formatDateTime(schemaMeta.last_synced_at)}`
      : '아직 동기화 기록이 없습니다';

    status.textContent = schemaMeta.last_error
      ? `동기화 오류: ${schemaMeta.last_error}`
      : lastSyncedText;
    status.classList.toggle('is-error', Boolean(schemaMeta.last_error));

    const parts = ['Google Sheet 읽기 전용'];
    if (schemaMeta.sheet_title) parts.push(schemaMeta.sheet_title);
    if (schemaMeta.sheet_range) parts.push(schemaMeta.sheet_range);
    source.textContent = parts.join(' · ');

    button.disabled = Boolean(syncPromise);
    button.innerHTML = syncPromise
      ? '<i class="ri-loader-4-line ri-spin"></i> 동기화 중'
      : '<i class="ri-refresh-line"></i> 시트 동기화';
  }

  function renderList() {
    const list = document.getElementById('clients-list');
    const count = document.getElementById('client-list-count');
    if (!list || !count) return;

    const filtered = getFilteredClients();
    count.textContent = String(filtered.length);

    if (!filtered.length) {
      list.innerHTML = '<div class="clients-list-empty"><i class="ri-building-2-line"></i><p>표시할 거래처가 없습니다</p></div>';
      return;
    }

    list.innerHTML = filtered.map(client => `
      <button class="client-list-row ${selectedClientId === client.id ? 'active' : ''}" data-id="${escapeAttr(client.id)}" type="button">
        <span class="client-cell client-cell-name">
          <span class="client-name-text" title="${escapeAttr(getClientDisplayName(client))}">${escapeHtml(getClientDisplayName(client))}</span>
          ${buildListMeta(client) ? `<small>${escapeHtml(buildListMeta(client))}</small>` : ''}
        </span>
        <span class="client-cell">${escapeHtml(client.owner_name || '-')}</span>
        <span class="client-cell">${escapeHtml(client.company_contact_name || '-')}</span>
        <span class="client-cell">${escapeHtml(formatPhoneForDisplay(client.phone) || '-')}</span>
        <span class="client-cell">${escapeHtml(client.gyeongli_id || '-')}</span>
      </button>
    `).join('');

    list.querySelectorAll('.client-list-row').forEach(row => {
      row.addEventListener('click', () => {
        void selectClient(row.dataset.id);
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

    const client = selectedClient || clients.find(item => item.id === selectedClientId) || null;
    if (!client) {
      empty.classList.remove('hidden');
      body.classList.add('hidden');
      return;
    }

    empty.classList.add('hidden');
    body.classList.remove('hidden');

    setText('client-detail-name', getClientDisplayName(client));
    setText('client-detail-subtitle', buildSubtitle(client));
    setValue('client-detail-name-input', client.name || '');
    setValue('client-detail-category', getClientCategoryLabel(client.client_category));
    setValue('client-detail-owner', client.owner_name || '');
    setValue('client-detail-company-contact', client.company_contact_name || '');
    setValue('client-detail-phone', formatPhoneForDisplay(client.phone) || '');
    setValue('client-detail-email', client.email || '');
    setValue('client-detail-last-contact', client.last_contact_at || '');
    setValue('client-detail-next-action-title', client.next_action_title || '');
    setValue('client-detail-next-action-at', client.next_action_at || '');
    setValue('client-detail-client-code', client.client_code || '');
    setValue('client-detail-business-number', client.business_number || '');
    setValue('client-detail-ceo-name', client.ceo_name || '');
    setValue('client-detail-approval-number', client.approval_number || '');
    setValue('client-detail-incorporation-date', client.incorporation_registry_date || '');
    setValue('client-detail-fund-corporate-name', client.fund_corporate_name || '');
    setValue('client-detail-parent-company-name', client.parent_company_name || '');
    setValue('client-detail-gyeongli-id', client.gyeongli_id || '');
    setValue('client-detail-memo', client.memo || '');

    const passwordInput = document.getElementById('client-detail-gyeongli-password');
    const passwordButton = document.getElementById('btn-client-password-toggle');
    if (passwordInput) {
      passwordInput.value = client.gyeongli_password || '';
      passwordInput.type = revealPassword ? 'text' : 'password';
    }
    if (passwordButton) {
      passwordButton.disabled = !client.gyeongli_password;
      passwordButton.textContent = revealPassword ? '숨기기' : '보기';
    }

    setText(
      'client-detail-next-action-summary',
      client.next_action_title
        ? `${client.next_action_title}${client.next_action_at ? ` · ${formatDate(client.next_action_at)}` : ''}`
        : '미정'
    );
    setText(
      'client-detail-last-contact-summary',
      formatDate(client.last_contact_at) || '기록 없음'
    );
    setText(
      'client-detail-source-summary',
      client.sheet_row_number != null
        ? (schemaMeta.sheet_title
          ? `${schemaMeta.sheet_title}${schemaMeta.sheet_range ? ` · ${schemaMeta.sheet_range}` : ''}`
          : 'Google Sheet')
        : 'LinkFlow 직접 등록'
    );

    document.getElementById('client-detail-fund-section')?.classList.toggle(
      'hidden',
      client.client_category !== 'welfare_fund'
    );

    renderExtraFields(client);
    renderTimeline();
  }

  function renderExtraFields(client) {
    const section = document.getElementById('client-extra-fields-section');
    const list = document.getElementById('client-extra-fields');
    if (!section || !list) return;

    const extraKeys = getExtraFieldLabels(client);
    if (!extraKeys.length) {
      section.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    section.classList.remove('hidden');
    list.innerHTML = extraKeys.map(label => {
      const value = client.sheet_extra_fields?.[label] ?? '';
      const multiline = String(value || '').includes('\n') || String(value || '').length > 70;
      return `
        <div class="client-extra-field">
          <label class="field-label">${escapeHtml(label)}</label>
          ${multiline
            ? `<textarea class="memo-textarea client-readonly-textarea" rows="3" readonly>${escapeHtml(value)}</textarea>`
            : `<input type="text" class="select-input client-readonly-input" readonly value="${escapeAttr(value)}" />`
          }
        </div>
      `;
    }).join('');
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
          ${(item.owner_display_name || item.description)
            ? `<small>${escapeHtml(trimText([item.owner_display_name ? `담당자: ${item.owner_display_name}` : '', item.description || ''].filter(Boolean).join(' · '), 160))}</small>`
            : ''}
        </div>
      </div>
    `).join('');
  }

  async function hideSelectedClient() {
    if (!selectedClientId) return;
    const ok = await UI.confirm(
      '거래처 종료 처리',
      'Google Sheet는 수정되지 않고, LinkFlow 화면에서만 숨김 처리됩니다. 계속하시겠습니까?'
    );
    if (!ok) return;

    try {
      await Auth.request(`/clients/${selectedClientId}/hide`, { method: 'POST' });
      const hiddenId = selectedClientId;
      clients = clients.filter(client => client.id !== hiddenId);
      selectedClientId = null;
      selectedClient = null;
      timelineItems = [];
      revealPassword = false;
      ensureSelection();
      render();
      notifyClientsChanged();
      if (selectedClientId) {
        await selectClient(selectedClientId, { silentList: true });
      }
      UI.showToast('거래처를 LinkFlow 목록에서 숨겼습니다', 'success');
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
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

  function getFilteredClients() {
    const query = searchQuery.toLowerCase();
    return clients.filter(client => {
      const serviceGroup = getClientServiceGroup(client);
      if (staffFilter === 'policy' && serviceGroup !== 'policy') return false;
      if (staffFilter === 'remote' && serviceGroup !== 'remote') return false;
      if (!query) return true;
      const extraValues = Object.entries(client.sheet_extra_fields || {})
        .map(([key, value]) => `${key} ${value}`)
        .join(' ');
      const haystack = [
        client.name,
        getClientCategoryLabel(client.client_category),
        getClientServiceGroupLabel(client),
        client.owner_name,
        client.company_contact_name,
        client.phone,
        client.email,
        client.memo,
        client.client_code,
        client.business_number,
        client.ceo_name,
        client.approval_number,
        client.fund_corporate_name,
        client.parent_company_name,
        client.gyeongli_id,
        client.next_action_title,
        extraValues,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  function getExtraFieldLabels(client) {
    const labelsFromSchema = Array.isArray(schemaMeta.extra_fields)
      ? schemaMeta.extra_fields.map(field => field?.label || field?.key).filter(Boolean)
      : [];
    const labelsFromClient = Object.keys(client.sheet_extra_fields || {});
    return Array.from(new Set([...labelsFromSchema, ...labelsFromClient]))
      .filter(label => String(client.sheet_extra_fields?.[label] || '').trim());
  }

  function buildSubtitle(client) {
    const parts = [];
    if (client.client_category && client.client_category !== 'general') parts.push(getClientCategoryLabel(client.client_category));
    parts.push(getClientServiceGroupLabel(client));
    if (client.owner_name) parts.push(`경리팀 ${client.owner_name}`);
    if (client.company_contact_name) parts.push(`기업 ${client.company_contact_name}`);
    if (client.phone) parts.push(formatPhoneForDisplay(client.phone));
    if (client.email) parts.push(client.email);
    if (parts.length) return parts.join(' · ');
    return client.sheet_row_number != null
      ? 'Google Sheet 기반 거래처 정보입니다.'
      : 'LinkFlow에 직접 등록한 거래처입니다.';
  }

  function buildListMeta(client) {
    const parts = [];
    parts.push(getClientServiceGroupLabel(client));
    if (client.client_category && client.client_category !== 'general') parts.push(getClientCategoryLabel(client.client_category));
    if (client.client_code) parts.push(`코드 ${client.client_code}`);
    if (client.business_number) parts.push(`사업자번호 ${client.business_number}`);
    if (client.ceo_name) parts.push(`대표 ${client.ceo_name}`);
    return parts.join(' · ');
  }

  function getClientDisplayName(client) {
    return normalizeText(client?.name) || normalizeText(client?.gyeongli_id) || '이름 미지정';
  }

  function getClientName(clientId) {
    if (!clientId) return '';
    const client = clients.find(item => item.id === clientId) || (selectedClient?.id === clientId ? selectedClient : null);
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

  function togglePasswordVisibility() {
    revealPassword = !revealPassword;
    renderDetail();
  }

  function syncClientIntoList(client) {
    const normalized = normalizeClient(client);
    const index = clients.findIndex(item => item.id === normalized.id);
    if (index >= 0) {
      clients[index] = { ...clients[index], ...normalized };
      return;
    }
    clients.unshift(normalized);
  }

  function notifyClientsChanged() {
    window.dispatchEvent(new CustomEvent('lf:clients-changed', {
      detail: { clients: clients.slice() },
    }));
  }

  function persistState() {
    if (persistStateTimer) clearTimeout(persistStateTimer);
    const nextState = { searchQuery, staffFilter };
    persistStateTimer = setTimeout(() => {
      persistStateTimer = null;
      if (Preferences?.setClientViewState) {
        void Preferences.setClientViewState(nextState);
      }
    }, 250);
  }

  function restoreState() {
    const raw = Preferences?.getClientViewState?.() || {};
    if (raw.searchQuery) searchQuery = raw.searchQuery;
    if (raw.staffFilter) staffFilter = raw.staffFilter;
    const searchInput = document.getElementById('clients-search-input');
    if (searchInput) searchInput.value = searchQuery;
  }

  function normalizeClient(client) {
    const base = { ...(client || {}) };
    return {
      ...base,
      name: normalizeText(base.name) || normalizeText(base.gyeongli_id) || '이름 미지정',
      client_category: normalizeText(base.client_category) || 'general',
      owner_name: normalizeText(base.owner_name) || null,
      company_contact_name: normalizeText(base.company_contact_name) || null,
      phone: normalizeText(base.phone) || null,
      email: normalizeText(base.email) || null,
      memo: normalizeMultilineText(base.memo) || null,
      client_code: normalizeText(base.client_code) || null,
      business_number: normalizeText(base.business_number) || null,
      ceo_name: normalizeText(base.ceo_name) || null,
      approval_number: normalizeText(base.approval_number) || null,
      incorporation_registry_date: normalizeText(base.incorporation_registry_date) || null,
      fund_corporate_name: normalizeText(base.fund_corporate_name) || null,
      parent_company_name: normalizeText(base.parent_company_name) || null,
      gyeongli_id: normalizeText(base.gyeongli_id) || null,
      gyeongli_password: normalizeText(base.gyeongli_password) || null,
      last_contact_at: normalizeText(base.last_contact_at) || null,
      next_action_title: normalizeText(base.next_action_title) || null,
      next_action_at: normalizeText(base.next_action_at) || null,
      sheet_extra_fields: (base.sheet_extra_fields && typeof base.sheet_extra_fields === 'object')
        ? base.sheet_extra_fields
        : {},
    };
  }

  function normalizeBookmark(bookmark) {
    return { ...(bookmark || {}) };
  }

  function normalizeText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text || '';
  }

  function normalizeMultilineText(value) {
    const text = String(value || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .join('\n')
      .trim();
    return text || '';
  }

  function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function formatPhoneForDisplay(value) {
    const digits = normalizePhone(value);
    if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    if (digits.length === 10 && digits.startsWith('02')) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
    if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 9 && digits.startsWith('02')) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
    return value || '';
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

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value || '';
  }

  function setValue(id, value) {
    const node = document.getElementById(id);
    if (node) node.value = value || '';
  }

  function getClientCategoryLabel(value) {
    return CLIENT_CATEGORY_LABELS[String(value || 'general').trim().toLowerCase()] || '일반';
  }

  function renderStaffFilter() {
    document.querySelectorAll('#clients-staff-filter [data-staff-filter]').forEach(button => {
      button.classList.toggle('active', button.dataset.staffFilter === staffFilter);
    });
  }

  function getClientServiceGroup(client) {
    const code = String(client?.client_code || '').replace(/\D/g, '');
    if (code.startsWith('6')) return 'policy';
    return 'remote';
  }

  function getClientServiceGroupLabel(client) {
    return getClientServiceGroup(client) === 'policy' ? '정책경리' : '원격경리';
  }

  function syncClientCategoryFields() {
    const category = document.getElementById('client-category')?.value || 'general';
    const fundWrap = document.getElementById('client-fund-fields');
    if (fundWrap) fundWrap.classList.toggle('hidden', category !== 'welfare_fund');
    if (category !== 'welfare_fund') {
      setValue('client-approval-number', '');
      setValue('client-incorporation-date', '');
      setValue('client-fund-corporate-name', '');
      setValue('client-parent-company-name', '');
    }
  }

  function resetClientForm() {
    document.getElementById('client-form')?.reset();
    setValue('client-id', '');
    setValue('client-category', 'general');
    syncClientCategoryFields();
  }

  function openCreateClientModal() {
    resetClientForm();
    setText('client-modal-title', '거래처 추가');
    UI.openModal('client-modal');
  }

  function openEditClientModal(clientId) {
    const client = clients.find(item => item.id === clientId) || selectedClient;
    if (!client) return;
    resetClientForm();
    setText('client-modal-title', '거래처 편집');
    setValue('client-id', client.id);
    setValue('client-name', client.name);
    setValue('client-category', client.client_category || 'general');
    setValue('client-code', client.client_code);
    setValue('client-business-number', client.business_number);
    setValue('client-ceo-name', client.ceo_name);
    setValue('client-owner', client.owner_name);
    setValue('client-company-contact', client.company_contact_name);
    setValue('client-phone', client.phone);
    setValue('client-email', client.email);
    setValue('client-gyeongli-id', client.gyeongli_id);
    setValue('client-gyeongli-password', client.gyeongli_password);
    setValue('client-last-contact', client.last_contact_at);
    setValue('client-next-action-title', client.next_action_title);
    setValue('client-next-action-at', client.next_action_at);
    setValue('client-approval-number', client.approval_number);
    setValue('client-incorporation-date', client.incorporation_registry_date);
    setValue('client-fund-corporate-name', client.fund_corporate_name);
    setValue('client-parent-company-name', client.parent_company_name);
    setValue('client-memo', client.memo);
    syncClientCategoryFields();
    UI.openModal('client-modal');
  }

  function collectClientFormData() {
    const category = document.getElementById('client-category')?.value || 'general';
    const rawPassword = document.getElementById('client-gyeongli-password')?.value ?? '';
    return {
      name: normalizeText(document.getElementById('client-name')?.value),
      status: 'active',
      client_category: category,
      owner_name: normalizeText(document.getElementById('client-owner')?.value) || null,
      company_contact_name: normalizeText(document.getElementById('client-company-contact')?.value) || null,
      phone: normalizeText(document.getElementById('client-phone')?.value) || null,
      email: normalizeText(document.getElementById('client-email')?.value) || null,
      memo: normalizeMultilineText(document.getElementById('client-memo')?.value) || null,
      last_contact_at: normalizeText(document.getElementById('client-last-contact')?.value) || null,
      next_action_title: normalizeText(document.getElementById('client-next-action-title')?.value) || null,
      next_action_at: normalizeText(document.getElementById('client-next-action-at')?.value) || null,
      client_code: normalizeText(document.getElementById('client-code')?.value) || null,
      business_number: normalizeText(document.getElementById('client-business-number')?.value) || null,
      ceo_name: normalizeText(document.getElementById('client-ceo-name')?.value) || null,
      gyeongli_id: normalizeText(document.getElementById('client-gyeongli-id')?.value) || null,
      gyeongli_password: normalizeText(rawPassword) || undefined,
      approval_number: category === 'welfare_fund' ? (normalizeText(document.getElementById('client-approval-number')?.value) || null) : null,
      incorporation_registry_date: category === 'welfare_fund' ? (normalizeText(document.getElementById('client-incorporation-date')?.value) || null) : null,
      fund_corporate_name: category === 'welfare_fund' ? (normalizeText(document.getElementById('client-fund-corporate-name')?.value) || null) : null,
      parent_company_name: category === 'welfare_fund' ? (normalizeText(document.getElementById('client-parent-company-name')?.value) || null) : null,
    };
  }

  async function saveClient(event) {
    event.preventDefault();
    const clientId = document.getElementById('client-id')?.value || '';
    const data = collectClientFormData();
    if (!data.name) {
      UI.showToast('거래처명을 입력해주세요', 'error');
      return;
    }

    try {
      const saved = clientId
        ? await Auth.request(`/clients/${clientId}`, { method: 'PUT', body: JSON.stringify(data) })
        : await Auth.request('/clients', { method: 'POST', body: JSON.stringify(data) });
      syncClientIntoList(saved);
      selectedClientId = saved.id;
      selectedClient = normalizeClient(saved);
      render();
      renderShortcuts();
      notifyClientsChanged();
      UI.closeModal('client-modal');
      UI.showToast(clientId ? '거래처를 수정했습니다' : '거래처를 추가했습니다', 'success');
      await selectClient(saved.id, { silentList: true });
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
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

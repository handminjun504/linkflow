const Calendar = (() => {
  let currentYear, currentMonth;
  let events = [];
  let eventsByDate = new Map();
  let weekTasks = [];
  let notifyTimers = [];
  let holidayCache = {};
  let holidayRequests = {};
  let monthEventCache = new Map();
  let monthLoadToken = 0;
  let weekTasksLoadedAt = 0;
  let weekTasksCacheKey = '';
  let weekTasksPromise = null;
  let notificationSessionKey = '';
  let activeCalendarView = 'work';

  const HOLIDAY_API_BASE = (() => {
    const explicit = window.__LF_API_BASE__;
    if (explicit) return String(explicit).replace(/\/+$/, '');
    if (location.origin.includes('bookmark-one-lemon.vercel.app')) return '/api';
    return 'https://bookmark-one-lemon.vercel.app/api';
  })();

  const DEFAULT_EVENT_COLOR = '#111111';
  const EVENTS_TTL = 60 * 1000;
  const WEEK_TASKS_TTL = 60 * 1000;
  const CALENDAR_VIEW_LABELS = {
    work: '업무 일정',
    personal: '개인 일정',
  };

  const DAY_COLORS = [
    { cls: 'task-day-sun', label: '일' },
    { cls: 'task-day-mon', label: '월' },
    { cls: 'task-day-tue', label: '화' },
    { cls: 'task-day-wed', label: '수' },
    { cls: 'task-day-thu', label: '목' },
    { cls: 'task-day-fri', label: '금' },
    { cls: 'task-day-sat', label: '토' },
  ];

  function populateClientOptions(selected = '') {
    const wrap = document.getElementById('evt-client-wrap');
    const select = document.getElementById('evt-client');
    if (!wrap || !select) return;
    const clientItems = Clients?.getAll?.() || [];
    if (!clientItems.length) {
      wrap.style.display = 'none';
      select.innerHTML = '<option value="">없음</option>';
      return;
    }
    wrap.style.display = '';
    Clients.populateSelect(select, selected);
  }

  function getClientName(clientId) {
    return Clients?.getClientName?.(clientId) || '';
  }

  function getNotificationSessionKey() {
    const userId = Auth?.getUser?.()?.id || 'anonymous';
    const token = Auth?.getToken?.() || '';
    return `${userId}:${token}`;
  }

  function resetNotificationState() {
    notifyTimers.forEach(timerId => clearTimeout(timerId));
    notifyTimers = [];
    notificationSessionKey = '';
  }

  function getMonthKey(year, month) {
    return `${activeCalendarView}:${year}-${String(month + 1).padStart(2, '0')}`;
  }

  function getWeekKey(baseDate = new Date()) {
    const start = new Date(baseDate);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return `${activeCalendarView}:${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  }

  function getActiveCalendarView() {
    return activeCalendarView === 'personal' ? 'personal' : 'work';
  }

  function isWorkView() {
    return getActiveCalendarView() === 'work';
  }

  function getCurrentCalendarTypeForForm() {
    const user = Auth?.getUser?.();
    if (!user?.team_id && getActiveCalendarView() === 'work') return 'personal';
    return getActiveCalendarView();
  }

  function invalidateCalendarCaches() {
    monthEventCache.clear();
    weekTasksLoadedAt = 0;
    weekTasksCacheKey = '';
  }

  function rebuildEventIndex() {
    const nextMap = new Map();
    events.forEach(event => {
      const key = event.start_date;
      if (!key) return;
      if (!nextMap.has(key)) nextMap.set(key, []);
      nextMap.get(key).push(event);
    });
    nextMap.forEach(dayEvents => {
      dayEvents.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    });
    eventsByDate = nextMap;
  }

  function renderViewSwitch() {
    const wrap = document.getElementById('calendar-view-switch');
    if (!wrap) return;
    wrap.querySelectorAll('.calendar-view-btn').forEach(button => {
      button.classList.toggle('active', button.dataset.view === getActiveCalendarView());
    });
  }

  function updateCalendarLayoutMode() {
    const layout = document.querySelector('#tab-calendar .calendar-layout');
    if (!layout) return;
    layout.classList.toggle('personal-mode', !isWorkView());
  }

  function setCalendarView(nextView, options = {}) {
    const normalized = nextView === 'personal' ? 'personal' : 'work';
    if (activeCalendarView === normalized && !options.force) {
      renderViewSwitch();
      updateCalendarLayoutMode();
      return;
    }
    activeCalendarView = normalized;
    renderViewSwitch();
    updateCalendarLayoutMode();
    syncCalendarTypeControls(getCurrentCalendarTypeForForm());
    if (!options.silent) {
      void load({ force: true, forceWeekTasks: isWorkView() });
    }
  }

  function syncCalendarTypeControls(selectedType = null) {
    const select = document.getElementById('evt-calendar-type');
    const hint = document.getElementById('evt-calendar-hint');
    const taskCheckbox = document.getElementById('evt-is-task');
    const taskWrap = document.getElementById('evt-is-task-wrap');
    if (!select || !hint || !taskCheckbox || !taskWrap) return;

    const user = Auth?.getUser?.() || {};
    const hasTeam = Boolean(user.team_id);
    const requested = selectedType || select.value || getCurrentCalendarTypeForForm();
    const nextType = requested === 'work' && !hasTeam ? 'personal' : requested;

    const workOption = select.querySelector('option[value="work"]');
    if (workOption) workOption.disabled = !hasTeam;

    select.value = nextType;
    taskCheckbox.disabled = nextType !== 'work';
    taskWrap.classList.toggle('is-disabled', nextType !== 'work');
    if (nextType !== 'work') {
      taskCheckbox.checked = false;
    }

    hint.textContent = nextType === 'work'
      ? (hasTeam
        ? '같은 팀 계정에게 바로 공유됩니다.'
        : '팀이 지정된 계정만 업무 일정으로 등록할 수 있습니다.')
      : '본인 계정에서만 보이는 개인 일정입니다.';
  }

  function getEventCalendarType(event) {
    if ((event?.calendar_type || '').toLowerCase() === 'work') return 'work';
    if ((event?.calendar_type || '').toLowerCase() === 'personal') return 'personal';
    return event?.is_task ? 'work' : 'personal';
  }

  function init() {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth();

    document.getElementById('cal-prev').addEventListener('click', () => navigate(-1));
    document.getElementById('cal-next').addEventListener('click', () => navigate(1));
    document.getElementById('cal-today').addEventListener('click', goToday);
    document.getElementById('cal-add')?.addEventListener('click', () => openAddEvent(getTodayDateStr()));
    document.querySelectorAll('#calendar-view-switch .calendar-view-btn').forEach(button => {
      button.addEventListener('click', () => setCalendarView(button.dataset.view));
    });
    document.getElementById('event-form').addEventListener('submit', saveEvent);
    document.getElementById('evt-delete-btn').addEventListener('click', deleteCurrentEvent);
    document.getElementById('evt-calendar-type')?.addEventListener('change', event => {
      syncCalendarTypeControls(event.target.value);
    });
    bindDayEventsModal();
    document.getElementById('calendar-grid')?.addEventListener('click', event => {
      const cell = event.target.closest('.cal-cell:not(.empty)');
      if (cell?.dataset.date) openDayEvents(cell.dataset.date);
    });

    document.getElementById('evt-color-picker').querySelectorAll('.color-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        document.getElementById('evt-color-picker').querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        document.getElementById('evt-color').value = dot.dataset.color;
      });
    });

    document.getElementById('evt-recurrence').addEventListener('change', e => {
      const val = e.target.value;
      const hasRecurrence = !!val;
      const isMonthly = val === 'monthly';
      document.getElementById('evt-recurrence-end-wrap').style.display = hasRecurrence ? '' : 'none';
      document.getElementById('evt-skip-weekend-wrap').style.display = hasRecurrence ? '' : 'none';
      document.getElementById('evt-recurrence-day-wrap').style.display = isMonthly ? '' : 'none';
    });

    requestNotificationPermission();
    populateClientOptions();
    renderViewSwitch();
    updateCalendarLayoutMode();
    syncCalendarTypeControls();
    window.addEventListener('lf:clients-changed', () => {
      populateClientOptions(document.getElementById('evt-client')?.value || '');
      if (document.getElementById('tab-calendar')?.classList.contains('active')) {
        render();
        renderTaskSidebar();
      }
    });
    window.addEventListener('lf:auth-changed', event => {
      resetNotificationState();
      invalidateCalendarCaches();
      syncCalendarTypeControls();
      if (!event.detail?.loggedIn) {
        events = [];
        eventsByDate = new Map();
        weekTasks = [];
        render();
        renderTaskSidebar();
      }
    });
  }

  async function loadHolidays(year) {
    if (holidayCache[year]) return holidayCache[year];
    if (holidayRequests[year]) return holidayRequests[year];
    holidayRequests[year] = (async () => {
      try {
        const res = await fetch(`${HOLIDAY_API_BASE}/holidays?year=${year}`);
        const data = await res.json();
        const map = {};
        data.forEach(h => { map[h.date] = h.name; });
        holidayCache[year] = map;
        return map;
      } catch {
        return {};
      } finally {
        delete holidayRequests[year];
      }
    })();
    return holidayRequests[year];
  }

  function ensureHolidays(year) {
    if (holidayCache[year]) return Promise.resolve(holidayCache[year]);
    return loadHolidays(year).then(map => {
      if (currentYear === year && document.getElementById('tab-calendar')?.classList.contains('active')) {
        render();
      }
      return map;
    });
  }

  function navigate(dir) {
    currentMonth += dir;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    load();
  }

  function goToday() {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth();
    load();
  }

  async function load(options = {}) {
    const retryCount = Number(options.retryCount) || 0;
    const force = !!options.force;
    const skipWeekTasks = !!options.skipWeekTasks;
    const forceWeekTasks = !!options.forceWeekTasks;
    document.getElementById('cal-month-title').textContent =
      `${currentYear}년 ${currentMonth + 1}월`;

    const monthKey = getMonthKey(currentYear, currentMonth);
    const cachedMonth = monthEventCache.get(monthKey);

    try {
      if (!Auth.isLoggedIn()) {
        events = [];
        eventsByDate = new Map();
        if (!skipWeekTasks) {
          weekTasks = [];
          renderTaskSidebar();
        }
        render();
        return [];
      }

      const isMonthFresh = !force && cachedMonth && (Date.now() - cachedMonth.loadedAt) < EVENTS_TTL;
      if (isMonthFresh) {
        events = cachedMonth.items.slice();
        rebuildEventIndex();
        render();
        scheduleNotifications();
        if (!skipWeekTasks && isWorkView()) void loadWeekTasks({ force: forceWeekTasks });
        else if (!isWorkView()) {
          weekTasks = [];
          renderTaskSidebar();
        }
        void ensureHolidays(currentYear);
        return events;
      }

      if (cachedMonth?.items?.length) {
        events = cachedMonth.items.slice();
        rebuildEventIndex();
        render();
      } else {
        events = [];
        rebuildEventIndex();
        render();
      }

      const requestToken = ++monthLoadToken;
      void ensureHolidays(currentYear);
      const loadedEvents = await Auth.request(`/events?year=${currentYear}&month=${currentMonth + 1}&calendar_type=${encodeURIComponent(getActiveCalendarView())}`);
      if (requestToken !== monthLoadToken) return events;
      events = Array.isArray(loadedEvents) ? loadedEvents : [];
      monthEventCache.set(monthKey, { items: events.slice(), loadedAt: Date.now() });
    } catch (err) {
      console.error('[Calendar] 일정 로드 실패:', err.message);
      if (err.message !== 'Session expired' && retryCount < 2) {
        await new Promise(r => setTimeout(r, 1000));
        return load({ ...options, retryCount: retryCount + 1 });
      }
      if (err.message !== 'Session expired' && typeof UI !== 'undefined') {
        UI.showToast('일정을 불러오지 못했습니다', 'error');
      }
      events = [];
      eventsByDate = new Map();
    }
    rebuildEventIndex();
    render();
    scheduleNotifications();
    if (!skipWeekTasks && isWorkView()) void loadWeekTasks({ force: forceWeekTasks });
    else if (!isWorkView()) {
      weekTasks = [];
      renderTaskSidebar();
    }
    return events;
  }

  function render() {
    const grid = document.getElementById('calendar-grid');
    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const rowCount = Math.ceil((firstDay + daysInMonth) / 7);
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === currentYear && today.getMonth() === currentMonth;
    const holidays = holidayCache[currentYear] || {};

    let html = '';

    for (let i = 0; i < firstDay; i++) {
      html += '<div class="cal-cell empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayEvents = eventsByDate.get(dateStr) || [];
      const isToday = isCurrentMonth && today.getDate() === d;
      const dow = (firstDay + d - 1) % 7;
      const isSun = dow === 0;
      const isSat = dow === 6;
      const holidayName = holidays[dateStr];
      const isHoliday = !!holidayName;

      let cellClass = 'cal-cell';
      if (isToday) cellClass += ' today';
      if (isSun) cellClass += ' sun';
      if (isSat) cellClass += ' sat';
      if (isHoliday) cellClass += ' holiday';

      html += `<div class="${cellClass}" data-date="${dateStr}">`;
      html += `<span class="cal-day-num">${d}</span>`;
      if (isHoliday) {
        html += `<div class="cal-holiday-name">${escapeHtml(holidayName)}</div>`;
      }
      if (dayEvents.length > 0) {
        html += '<div class="cal-events">';
        dayEvents.slice(0, 3).forEach(ev => {
          const time = ev.start_time ? ev.start_time.substring(0, 5) + ' ' : '';
          const recurIcon = ev._recurring || ev.recurrence_type ? '<i class="ri-repeat-line" style="font-size:9px;margin-right:2px"></i>' : '';
          const taskIcon = ev.is_task ? '<i class="ri-checkbox-circle-line" style="font-size:9px;margin-right:2px"></i>' : '';
          const clientName = getClientName(ev.client_id);
          const doneClass = ev.is_done ? ' cal-event-done' : '';
          const scopeClass = getEventCalendarType(ev) === 'work' ? ' team-event' : '';
          const scopeLabel = getEventCalendarType(ev) === 'work' ? '팀 공유' : '개인';
          html += `<div class="cal-event-bar${doneClass}${scopeClass}" style="background:${ev.color || DEFAULT_EVENT_COLOR}" data-id="${ev.id}" title="${scopeLabel} · ${time}${ev.title}${clientName ? ` · ${clientName}` : ''}">${recurIcon}${taskIcon}${time}${escapeHtml(ev.title)}${clientName ? ` · ${escapeHtml(clientName)}` : ''}</div>`;
        });
        if (dayEvents.length > 3) {
          html += `<div class="cal-event-more">+${dayEvents.length - 3}</div>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }

    grid.innerHTML = html;
    grid.style.setProperty('--calendar-row-count', String(Math.max(rowCount, 5)));
  }

  // ── Task Sidebar ──

  async function loadWeekTasks(options = {}) {
    if (!Auth.isLoggedIn()) { weekTasks = []; renderTaskSidebar(); return []; }
    if (!isWorkView()) { weekTasks = []; renderTaskSidebar(); return []; }

    const force = !!options.force;
    const today = getTodayDateStr();
    const weekKey = getWeekKey(new Date(`${today}T00:00:00`));
    const isFresh = !force && weekTasksCacheKey === weekKey && (Date.now() - weekTasksLoadedAt) < WEEK_TASKS_TTL;
    if (isFresh) {
      renderTaskSidebar();
      return weekTasks;
    }

    if (weekTasksPromise) return weekTasksPromise;

    weekTasksPromise = (async () => {
      try {
        const loadedTasks = await Auth.request(`/events/week?date_str=${today}&calendar_type=work`);
        weekTasks = Array.isArray(loadedTasks) ? loadedTasks : [];
        weekTasksLoadedAt = Date.now();
        weekTasksCacheKey = weekKey;
      } catch (err) {
        console.error('[Calendar] 주간 작업 로드 실패:', err.message);
        weekTasks = [];
      } finally {
        renderTaskSidebar();
        weekTasksPromise = null;
      }
      return weekTasks;
    })();

    return weekTasksPromise;
  }

  function applyTaskDoneState(eventId, targetDate, isDone) {
    const matchTask = weekTasks.find(task => task.id === eventId && (!targetDate || task.start_date === targetDate))
      || weekTasks.find(task => task.id === eventId);
    if (matchTask) matchTask.is_done = isDone;

    const dayEvents = targetDate ? (eventsByDate.get(targetDate) || []) : events;
    const matchEvent = dayEvents.find(event => event.id === eventId)
      || events.find(event => event.id === eventId);
    if (matchEvent) matchEvent.is_done = isDone;
  }

  function renderTaskSidebar() {
    const container = document.getElementById('task-list');
    const title = document.querySelector('#task-sidebar .task-sidebar-header h3');
    if (!container) return;
    if (title) {
      title.innerHTML = isWorkView()
        ? '<i class="ri-list-check-2"></i> 이번 주 업무'
        : '<i class="ri-user-line"></i> 개인 일정';
    }
    if (!isWorkView()) {
      container.innerHTML = '<div class="task-sidebar-empty-state"><i class="ri-user-line"></i><p>개인 일정 탭에서는 주간 업무 목록을 숨깁니다</p></div>';
      return;
    }
    if (weekTasks.length === 0) {
      container.innerHTML = '<div class="task-empty"><i class="ri-checkbox-circle-line"></i><p>이번 주 업무가 없습니다</p></div>';
      return;
    }

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const grouped = {};
    weekTasks.forEach(t => {
      const d = t.start_date;
      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(t);
    });

    let html = '';
    Object.keys(grouped).sort().forEach(dateKey => {
      const dt = new Date(dateKey + 'T00:00:00');
      const dow = dt.getDay();
      const dayInfo = DAY_COLORS[dow];
      const isToday = dateKey === todayStr;
      const dayLabel = `${dt.getMonth() + 1}/${dt.getDate()} (${dayInfo.label})`;

      html += `<div class="task-day-group ${dayInfo.cls}${isToday ? ' task-day-today' : ''}">`;
      html += `<div class="task-day-label">${dayLabel}${isToday ? ' <span class="task-today-badge">오늘</span>' : ''}</div>`;

      grouped[dateKey].forEach(t => {
        const checked = t.is_done ? 'checked' : '';
        const doneClass = t.is_done ? ' task-done' : '';
        const time = t.start_time ? t.start_time.substring(0, 5) : '';
        const note = (t.description || '').trim();
        const clientName = getClientName(t.client_id);
        const calendarBadge = getEventCalendarType(t) === 'work'
          ? '<span class="task-item-badge work"><i class="ri-team-line"></i> 팀 공유</span>'
          : '<span class="task-item-badge"><i class="ri-user-line"></i> 개인</span>';
        const dateAttr = (t._recurring || t.recurrence_type) ? ` data-date="${t.start_date}"` : '';
        html += `<div class="task-item${doneClass}">
          <input type="checkbox" class="task-check" data-id="${t.id}"${dateAttr} ${checked} />
          <div class="task-item-body">
            <span class="task-item-title">${escapeHtml(t.title)}</span>
            ${time ? `<span class="task-item-time">${time}</span>` : ''}
            ${clientName ? `<span class="task-item-time">거래처 · ${escapeHtml(clientName)}</span>` : ''}
            ${calendarBadge}
            ${note ? `<span class="task-item-note">${escapeHtml(note)}</span>` : ''}
          </div>
          <span class="task-color-dot" style="background:${t.color || DEFAULT_EVENT_COLOR}"></span>
        </div>`;
      });
      html += '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('.task-check').forEach(cb => {
      cb.addEventListener('change', async () => {
        const nextDone = cb.checked;
        const targetDate = cb.dataset.date || '';
        const taskItem = cb.closest('.task-item');
        cb.disabled = true;
        applyTaskDoneState(cb.dataset.id, targetDate, nextDone);
        if (taskItem) taskItem.classList.toggle('task-done', nextDone);
        render();
        try {
          const qs = targetDate ? `?target_date=${encodeURIComponent(targetDate)}` : '';
          await Auth.request(`/events/${cb.dataset.id}/done${qs}`, {
            method: 'PATCH',
            body: JSON.stringify({ is_done: nextDone }),
          });
          invalidateCalendarCaches();
          void Promise.all([
            loadWeekTasks({ force: true }),
            load({ force: true, skipWeekTasks: true }),
          ]);
        } catch (err) {
          applyTaskDoneState(cb.dataset.id, targetDate, !nextDone);
          if (taskItem) taskItem.classList.toggle('task-done', !nextDone);
          render();
          cb.checked = !nextDone;
          UI.showToast(err.message, 'error');
        } finally {
          cb.disabled = false;
        }
      });
    });
  }

  // ── Event Modal ──

  function openAddEvent(dateStr) {
    populateClientOptions();
    document.getElementById('event-modal-title').textContent = '일정 추가';
    document.getElementById('evt-submit-btn').textContent = '추가';
    document.getElementById('evt-delete-btn').classList.add('hidden');
    document.getElementById('event-form').reset();
    document.getElementById('evt-date').value = dateStr || '';
    document.getElementById('evt-color').value = DEFAULT_EVENT_COLOR;
    document.getElementById('evt-edit-id').value = '';
    document.getElementById('evt-recurrence-end-wrap').style.display = 'none';
    document.getElementById('evt-recurrence-day-wrap').style.display = 'none';
    document.getElementById('evt-skip-weekend-wrap').style.display = 'none';
    document.getElementById('evt-skip-weekend').checked = true;
    document.getElementById('evt-recurrence-day').value = '';
    document.getElementById('evt-client').value = '';
    document.getElementById('evt-calendar-type').value = getCurrentCalendarTypeForForm();
    syncCalendarTypeControls(getCurrentCalendarTypeForForm());
    resetColorPicker('evt-color-picker', DEFAULT_EVENT_COLOR);
    UI.openModal('event-modal');
  }


  function bindDayEventsModal() {
    document.getElementById('btn-day-events-add')?.addEventListener('click', () => {
      const selectedDate = document.getElementById('day-events-date')?.value || getTodayDateStr();
      UI.closeModal('day-events-modal');
      openAddEvent(selectedDate);
    });

    document.getElementById('day-events-list')?.addEventListener('click', e => {
      const item = e.target.closest('.day-event-item');
      if (!item) return;
      UI.closeModal('day-events-modal');
      openEditEvent(item.dataset.id);
    });
  }

  function openDayEvents(dateStr) {
    if (!dateStr) return;
    const titleEl = document.getElementById('day-events-title');
    const dateEl = document.getElementById('day-events-date');
    if (titleEl) titleEl.textContent = `${formatDateLabel(dateStr)} 일정`;
    if (dateEl) dateEl.value = dateStr;
    renderDayEventsList(dateStr);
    UI.openModal('day-events-modal');
  }

  function renderDayEventsList(dateStr) {
    const listEl = document.getElementById('day-events-list');
    if (!listEl) return;

    const dayEvents = (eventsByDate.get(dateStr) || []).slice();

    if (!dayEvents.length) {
      listEl.innerHTML = '<div class="day-event-empty"><i class="ri-calendar-event-line"></i><p>등록된 일정이 없습니다</p></div>';
      return;
    }

    listEl.innerHTML = dayEvents.map(ev => {
      const time = ev.start_time ? ev.start_time.substring(0, 5) : '종일';
      const note = (ev.description || '').trim();
      const clientName = getClientName(ev.client_id);
      const doneClass = ev.is_done ? ' day-event-done' : '';
      const isWork = getEventCalendarType(ev) === 'work';
      return `<button type="button" class="day-event-item${doneClass}" data-id="${ev.id}">
        <span class="day-event-color" style="background:${ev.color || DEFAULT_EVENT_COLOR}"></span>
        <div class="day-event-main">
          <div class="day-event-line">
            <span class="day-event-time">${time}</span>
            <span class="day-event-title">${escapeHtml(ev.title)}</span>
          </div>
          <div class="day-event-meta">
            <span class="day-event-badge ${isWork ? 'work' : ''}"><i class="${isWork ? 'ri-team-line' : 'ri-user-line'}"></i>${isWork ? '업무 일정' : '개인 일정'}</span>
            ${clientName ? `<span class="day-event-badge"><i class="ri-briefcase-4-line"></i>${escapeHtml(clientName)}</span>` : ''}
          </div>
          ${note ? `<div class="day-event-note">${escapeHtml(note)}</div>` : ''}
        </div>
        <i class="ri-arrow-right-s-line"></i>
      </button>`;
    }).join('');
  }

  function formatDateLabel(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`;
  }

  function getTodayDateStr() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  function openEditEvent(id) {
    const ev = events.find(e => e.id === id);
    if (!ev) return;
    populateClientOptions(ev.client_id || '');
    document.getElementById('event-modal-title').textContent = '일정 수정';
    document.getElementById('evt-submit-btn').textContent = '저장';
    document.getElementById('evt-delete-btn').classList.remove('hidden');
    document.getElementById('evt-edit-id').value = id;
    document.getElementById('evt-title').value = ev.title;
    document.getElementById('evt-date').value = ev.start_date;
    document.getElementById('evt-time').value = ev.start_time || '';
    document.getElementById('evt-end-date').value = ev.end_date || '';
    document.getElementById('evt-desc').value = ev.description || '';
    document.getElementById('evt-remind').value = ev.remind_minutes != null ? String(ev.remind_minutes) : '';
    document.getElementById('evt-recurrence').value = ev.recurrence_type || '';
    document.getElementById('evt-recurrence-end').value = ev.recurrence_end || '';
    const hasRecurrence = !!ev.recurrence_type;
    const isMonthly = ev.recurrence_type === 'monthly';
    document.getElementById('evt-recurrence-end-wrap').style.display = hasRecurrence ? '' : 'none';
    document.getElementById('evt-skip-weekend-wrap').style.display = hasRecurrence ? '' : 'none';
    document.getElementById('evt-recurrence-day-wrap').style.display = isMonthly ? '' : 'none';
    document.getElementById('evt-recurrence-day').value = isMonthly ? (ev.recurrence_day || new Date(ev.start_date + 'T00:00:00').getDate()) : '';
    document.getElementById('evt-skip-weekend').checked = ev.skip_weekend || false;
    document.getElementById('evt-calendar-type').value = getEventCalendarType(ev);
    syncCalendarTypeControls(getEventCalendarType(ev));
    document.getElementById('evt-is-task').checked = ev.is_task || false;
    document.getElementById('evt-client').value = ev.client_id || '';
    document.getElementById('evt-color').value = ev.color || DEFAULT_EVENT_COLOR;
    resetColorPicker('evt-color-picker', ev.color || DEFAULT_EVENT_COLOR);
    UI.openModal('event-modal');
  }

  function resetColorPicker(pickerId, activeColor) {
    document.getElementById(pickerId).querySelectorAll('.color-dot').forEach(d => {
      d.classList.toggle('active', d.dataset.color === activeColor);
    });
  }

  async function saveEvent(e) {
    e.preventDefault();
    const id = document.getElementById('evt-edit-id').value;
    const remindVal = document.getElementById('evt-remind').value;
    const recurrence = document.getElementById('evt-recurrence').value;

    let startDate = document.getElementById('evt-date').value;
    let recurrenceDay = null;
    if (recurrence === 'monthly') {
      const dayInput = document.getElementById('evt-recurrence-day').value;
      if (dayInput) {
        recurrenceDay = Math.min(31, Math.max(1, parseInt(dayInput, 10)));
        const parts = startDate.split('-');
        if (parts.length === 3) {
          const y = parseInt(parts[0], 10);
          const m = parseInt(parts[1], 10);
          const maxDay = new Date(y, m, 0).getDate();
          const day = Math.min(recurrenceDay, maxDay);
          startDate = `${parts[0]}-${parts[1]}-${String(day).padStart(2, '0')}`;
        }
      }
    }

    const data = {
      title: document.getElementById('evt-title').value.trim(),
      start_date: startDate,
      start_time: document.getElementById('evt-time').value || null,
      end_date: document.getElementById('evt-end-date').value || null,
      description: document.getElementById('evt-desc').value.trim() || null,
      color: document.getElementById('evt-color').value,
      remind_minutes: remindVal !== '' ? parseInt(remindVal, 10) : null,
      recurrence_type: recurrence || null,
      recurrence_end: recurrence ? (document.getElementById('evt-recurrence-end').value || null) : null,
      recurrence_interval: 1,
      recurrence_day: recurrenceDay,
      calendar_type: document.getElementById('evt-calendar-type').value || getCurrentCalendarTypeForForm(),
      is_task: document.getElementById('evt-calendar-type').value === 'work' && document.getElementById('evt-is-task').checked,
      skip_weekend: recurrence ? document.getElementById('evt-skip-weekend').checked : false,
      client_id: document.getElementById('evt-client').value || null,
    };

    try {
      if (id) {
        await Auth.request(`/events/${id}`, { method: 'PUT', body: JSON.stringify(data) });
        UI.showToast('일정이 수정되었습니다', 'success');
      } else {
        await Auth.request('/events', { method: 'POST', body: JSON.stringify(data) });
        UI.showToast('일정이 추가되었습니다', 'success');
      }
      invalidateCalendarCaches();
      UI.closeModal('event-modal');
      void load({ force: true, forceWeekTasks: true });
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  async function deleteCurrentEvent() {
    const id = document.getElementById('evt-edit-id').value;
    if (!id) return;
    const ok = await UI.confirm('삭제 확인', '이 일정을 삭제하시겠습니까?');
    if (!ok) return;
    try {
      await Auth.request(`/events/${id}`, { method: 'DELETE' });
      UI.showToast('삭제되었습니다', 'success');
      invalidateCalendarCaches();
      UI.closeModal('event-modal');
      void load({ force: true, forceWeekTasks: true });
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  // ── Notifications ──

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function scheduleNotifications() {
    resetNotificationState();
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const now = new Date();
    const sessionKey = getNotificationSessionKey();
    notificationSessionKey = sessionKey;
    events.forEach(ev => {
      if (ev.remind_minutes == null || !ev.start_time) return;
      const eventTime = new Date(`${ev.start_date}T${ev.start_time}`);
      const notifyTime = new Date(eventTime.getTime() - ev.remind_minutes * 60000);
      const delay = notifyTime.getTime() - now.getTime();

      if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
        const timer = setTimeout(() => {
          if (notificationSessionKey !== sessionKey) return;
          const remindText = ev.remind_minutes === 0 ? '지금' : `${ev.remind_minutes}분 후`;
          new Notification('LinkFlow - 일정 알림', {
            body: `${ev.title} (${remindText} 시작)`,
            icon: '/icons/icon-192.png',
            tag: ev.id,
          });
        }, delay);
        notifyTimers.push(timer);
      }
    });
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function openPrefilledEvent(prefill = {}) {
    openAddEvent(prefill.date || getTodayDateStr());
    document.getElementById('evt-title').value = prefill.title || '';
    document.getElementById('evt-desc').value = prefill.description || '';
    document.getElementById('evt-is-task').checked = !!prefill.isTask;
    const prefillType = prefill.calendarType || (prefill.isTask ? 'work' : getCurrentCalendarTypeForForm());
    document.getElementById('evt-calendar-type').value = prefillType;
    syncCalendarTypeControls(prefillType);
    if (prefill.isTask && prefillType === 'work') {
      document.getElementById('evt-is-task').checked = true;
    }
    if (prefill.clientId) {
      populateClientOptions(prefill.clientId);
      document.getElementById('evt-client').value = prefill.clientId;
    }
  }

  return { init, load, openAddEvent, openPrefilledEvent };
})();

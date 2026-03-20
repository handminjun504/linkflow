const Calendar = (() => {
  let currentYear, currentMonth;
  let events = [];
  let allEvents = [];
  let eventsByDate = new Map();
  let weekTasks = [];
  let allWeekTasks = [];
  let notifyTimers = [];
  let holidayCache = {};
  let holidayRequests = {};
  let monthEventCache = new Map();
  let monthLoadToken = 0;
  let weekTasksLoadedAt = 0;
  let weekTasksCacheKey = '';
  let weekTasksPromise = null;
  let weekTasksPromiseKey = '';
  let teamMembers = [];
  let teamMembersLoadedAt = 0;
  let teamMembersCacheKey = '';
  let teamMembersPromise = null;
  let teamMembersPromiseKey = '';
  let selectedStaffIds = new Set();
  let staffSelectionInitialized = false;
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
  const TEAM_MEMBERS_TTL = 5 * 60 * 1000;
  const MONTHLY_ANCHOR_RECURRENCES = new Set(['monthly', 'quarterly', 'semi_annually']);
  const CALENDAR_VIEW_LABELS = {
    work: '업무 일정',
    personal: '개인 일정',
  };

  function normalizeRecurrenceType(value) {
    const normalized = (value || '').toLowerCase();
    return normalized === 'yearly' ? 'annually' : normalized;
  }

  function usesMonthlyAnchor(value) {
    return MONTHLY_ANCHOR_RECURRENCES.has(normalizeRecurrenceType(value));
  }

  const DAY_COLORS = [
    { cls: 'task-day-sun', label: '일' },
    { cls: 'task-day-mon', label: '월' },
    { cls: 'task-day-tue', label: '화' },
    { cls: 'task-day-wed', label: '수' },
    { cls: 'task-day-thu', label: '목' },
    { cls: 'task-day-fri', label: '금' },
    { cls: 'task-day-sat', label: '토' },
  ];
  const WEEKDAY_OPTIONS = [
    { key: 'mon', label: '월' },
    { key: 'tue', label: '화' },
    { key: 'wed', label: '수' },
    { key: 'thu', label: '목' },
    { key: 'fri', label: '금' },
    { key: 'sat', label: '토' },
    { key: 'sun', label: '일' },
  ];
  const WEEKDAY_KEY_INDEX = WEEKDAY_OPTIONS.reduce((map, item, index) => {
    map[item.key] = index;
    return map;
  }, {});
  const MAX_EVENTS_PER_DAY_CELL = 4;

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

  function getWeekKey(baseDate = new Date(), tasksOnly = isWorkView()) {
    const start = new Date(baseDate);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return `${activeCalendarView}:${tasksOnly ? 'tasks' : 'all'}:${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
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

  function hasTeamCalendarAccess() {
    return Boolean(Auth?.getUser?.()?.team_id);
  }

  function shouldShowStaffFilters() {
    return isWorkView() && hasTeamCalendarAccess();
  }

  function resetTeamMemberState() {
    teamMembers = [];
    teamMembersLoadedAt = 0;
    teamMembersCacheKey = '';
    teamMembersPromise = null;
    teamMembersPromiseKey = '';
    selectedStaffIds = new Set();
    staffSelectionInitialized = false;
  }

  function getTeamMembersKey() {
    return Auth?.getUser?.()?.team_id || 'no-team';
  }

  function getStaffFilterLabel(member) {
    if (!member) return '사용자';
    if (member.is_current_user) return '나';
    return member.display_name || member.username || '사용자';
  }

  function getEventOwnerLabel(event) {
    const ownerId = event?.user_id || '';
    const matchedMember = teamMembers.find(member => member.id === ownerId);
    if (matchedMember) return getStaffFilterLabel(matchedMember);

    const currentUser = Auth?.getUser?.();
    if (ownerId && currentUser?.id === ownerId) return '나';
    return event?.owner_display_name || event?.owner_username || '';
  }

  function syncSelectedStaffIds() {
    const validIds = new Set(teamMembers.map(member => member.id));
    if (!staffSelectionInitialized) {
      selectedStaffIds = new Set(teamMembers.map(member => member.id));
      staffSelectionInitialized = true;
      return;
    }
    selectedStaffIds = new Set(
      Array.from(selectedStaffIds).filter(memberId => validIds.has(memberId))
    );
  }

  function isEventVisibleForSelectedStaff(event) {
    if (!shouldShowStaffFilters()) return true;
    if (!selectedStaffIds.size) return false;
    const ownerId = event?.user_id || '';
    return ownerId ? selectedStaffIds.has(ownerId) : true;
  }

  function filterEventsForSelectedStaff(items) {
    const rows = Array.isArray(items) ? items : [];
    if (!shouldShowStaffFilters()) return rows.slice();
    return rows.filter(isEventVisibleForSelectedStaff);
  }

  function isTeamSharedEvent(event) {
    return getEventCalendarType(event) === 'work' && Boolean(event?.team_id || event?.is_team_shared);
  }

  function getEventScopeMeta(event) {
    const calendarType = getEventCalendarType(event);
    if (calendarType !== 'work') {
      return {
        label: '개인 일정',
        badgeLabel: '개인 일정',
        badgeIcon: 'ri-user-line',
        badgeClass: '',
        barClass: '',
      };
    }

    const isShared = isTeamSharedEvent(event);
    return {
      label: isShared ? '팀 공유 일정' : '업무 일정',
      badgeLabel: isShared ? '팀 공유' : '업무 일정',
      badgeIcon: isShared ? 'ri-team-line' : 'ri-briefcase-4-line',
      badgeClass: ' work',
      barClass: isShared ? ' team-event' : '',
    };
  }

  function invalidateCalendarCaches() {
    monthEventCache.clear();
    weekTasksLoadedAt = 0;
    weekTasksCacheKey = '';
    weekTasksPromiseKey = '';
    allEvents = [];
    allWeekTasks = [];
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

  function renderStaffFilters() {
    const wrap = document.getElementById('task-staff-filters');
    if (!wrap) return;

    if (!shouldShowStaffFilters() || !teamMembers.length) {
      wrap.innerHTML = '';
      return;
    }

    wrap.innerHTML = teamMembers.map(member => {
      const checked = selectedStaffIds.has(member.id) ? 'checked' : '';
      const activeClass = selectedStaffIds.has(member.id) ? ' is-active' : '';
      return `<label class="task-staff-chip${activeClass}">
        <input type="checkbox" data-user-id="${member.id}" ${checked} />
        <span>${escapeHtml(getStaffFilterLabel(member))}</span>
      </label>`;
    }).join('');

    wrap.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.addEventListener('change', () => {
        const memberId = input.dataset.userId;
        if (!memberId) return;
        if (input.checked) {
          selectedStaffIds.add(memberId);
        } else {
          selectedStaffIds.delete(memberId);
        }
        applyCalendarFilters();
      });
    });
  }

  function applyCalendarFilters(options = {}) {
    const {
      renderMonth = true,
      renderSidebar = true,
      renderDayModal = true,
    } = options;

    events = filterEventsForSelectedStaff(allEvents);
    rebuildEventIndex();
    weekTasks = filterEventsForSelectedStaff(allWeekTasks);

    if (renderMonth) render();
    renderStaffFilters();
    if (renderSidebar) renderTaskSidebar();
    if (renderDayModal) {
      const selectedDate = document.getElementById('day-events-date')?.value || '';
      if (selectedDate) renderDayEventsList(selectedDate);
    }
  }

  async function loadTeamMembers(options = {}) {
    if (!Auth.isLoggedIn() || !hasTeamCalendarAccess()) {
      resetTeamMemberState();
      renderStaffFilters();
      return [];
    }

    const force = !!options.force;
    const cacheKey = getTeamMembersKey();
    const isFresh = !force
      && teamMembersCacheKey === cacheKey
      && (Date.now() - teamMembersLoadedAt) < TEAM_MEMBERS_TTL;

    if (isFresh) {
      renderStaffFilters();
      return teamMembers;
    }

    if (teamMembersPromise && teamMembersPromiseKey === cacheKey) {
      return teamMembersPromise;
    }

    teamMembersPromiseKey = cacheKey;
    teamMembersPromise = (async () => {
      try {
        const loadedMembers = await Auth.request('/team/members');
        teamMembers = Array.isArray(loadedMembers) ? loadedMembers : [];
        teamMembersLoadedAt = Date.now();
        teamMembersCacheKey = cacheKey;
        syncSelectedStaffIds();
      } catch (err) {
        console.error('[Calendar] 팀 멤버 로드 실패:', err.message);
        resetTeamMemberState();
      } finally {
        renderStaffFilters();
        teamMembersPromise = null;
        teamMembersPromiseKey = '';
      }
      return teamMembers;
    })();

    return teamMembersPromise;
  }

  function setCalendarView(nextView, options = {}) {
    const normalized = nextView === 'personal' ? 'personal' : 'work';
    if (activeCalendarView === normalized && !options.force) {
      renderViewSwitch();
      updateCalendarLayoutMode();
      renderStaffFilters();
      return;
    }
    activeCalendarView = normalized;
    renderViewSwitch();
    updateCalendarLayoutMode();
    renderStaffFilters();
    syncCalendarTypeControls(getCurrentCalendarTypeForForm());
    if (!options.silent) {
      void load({ force: true, forceWeekTasks: true });
    }
  }

  function syncCalendarTypeControls(selectedType = null) {
    const select = document.getElementById('evt-calendar-type');
    const hint = document.getElementById('evt-calendar-hint');
    const shareCheckbox = document.getElementById('evt-share-with-team');
    const shareWrap = document.getElementById('evt-share-with-team-wrap');
    const shareHelp = document.getElementById('evt-share-with-team-help');
    const taskCheckbox = document.getElementById('evt-is-task');
    const taskWrap = document.getElementById('evt-is-task-wrap');
    if (!select || !hint || !shareCheckbox || !shareWrap || !shareHelp || !taskCheckbox || !taskWrap) return;

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

    const canShareWithTeam = nextType === 'work' && hasTeam;
    shareWrap.style.display = nextType === 'work' ? '' : 'none';
    shareHelp.style.display = nextType === 'work' ? '' : 'none';
    shareCheckbox.disabled = !canShareWithTeam;
    shareWrap.classList.toggle('is-disabled', !canShareWithTeam);
    if (!canShareWithTeam) {
      shareCheckbox.checked = false;
    }

    hint.textContent = nextType === 'work'
      ? (hasTeam
        ? '업무 일정으로 분류됩니다. 팀 공유는 아래에서 직접 선택합니다.'
        : '팀이 지정된 계정만 업무 일정으로 등록할 수 있습니다.')
      : '본인 계정에서만 보이는 개인 일정입니다.';

    if (nextType === 'work') {
      shareHelp.textContent = hasTeam
        ? (shareCheckbox.checked
          ? '같은 팀 계정이 이 일정을 함께 확인할 수 있습니다.'
          : '기본값은 비공유입니다. 체크하면 같은 팀 계정과 공유됩니다.')
        : '팀이 지정된 계정만 팀 공유를 사용할 수 있습니다.';
    }
  }

  function getEventCalendarType(event) {
    if ((event?.calendar_type || '').toLowerCase() === 'work') return 'work';
    if ((event?.calendar_type || '').toLowerCase() === 'personal') return 'personal';
    return event?.is_task ? 'work' : 'personal';
  }

  function getWeekdayKeyForDateStr(dateStr) {
    const target = new Date(`${dateStr || getTodayDateStr()}T00:00:00`);
    if (Number.isNaN(target.getTime())) return 'mon';
    return WEEKDAY_OPTIONS[(target.getDay() + 6) % 7].key;
  }

  function normalizeRecurrenceWeekdays(values, fallbackDateStr = '') {
    const items = Array.isArray(values)
      ? values
      : typeof values === 'string'
        ? values.split(',')
        : [];
    const selected = new Set();
    items.forEach(value => {
      const normalized = String(value || '').trim().toLowerCase();
      if (WEEKDAY_KEY_INDEX[normalized] != null) selected.add(normalized);
    });
    const ordered = WEEKDAY_OPTIONS.filter(item => selected.has(item.key)).map(item => item.key);
    if (!ordered.length && fallbackDateStr) {
      return [getWeekdayKeyForDateStr(fallbackDateStr)];
    }
    return ordered;
  }

  function getSelectedRecurrenceWeekdays(fallbackDateStr = '') {
    const inputs = document.querySelectorAll('#evt-weekdays input');
    return normalizeRecurrenceWeekdays(
      Array.from(inputs).filter(input => input.checked).map(input => input.value),
      fallbackDateStr,
    );
  }

  function setSelectedRecurrenceWeekdays(values, fallbackDateStr = '') {
    const selected = new Set(normalizeRecurrenceWeekdays(values, fallbackDateStr));
    document.querySelectorAll('#evt-weekdays input').forEach(input => {
      input.checked = selected.has(input.value);
    });
  }

  function updateRecurrenceUi() {
    const recurrenceType = normalizeRecurrenceType(document.getElementById('evt-recurrence')?.value || '');
    const hasRecurrence = !!recurrenceType;
    const isWeekly = recurrenceType === 'weekly';
    const hasMonthlyAnchor = usesMonthlyAnchor(recurrenceType);
    const startDate = document.getElementById('evt-date')?.value || getTodayDateStr();
    const currentWeeklySelection = getSelectedRecurrenceWeekdays();

    document.getElementById('evt-recurrence-end-wrap').style.display = hasRecurrence ? '' : 'none';
    document.getElementById('evt-skip-weekend-wrap').style.display = hasRecurrence && !isWeekly ? '' : 'none';
    document.getElementById('evt-recurrence-day-wrap').style.display = hasMonthlyAnchor ? '' : 'none';
    document.getElementById('evt-weekdays-wrap').style.display = isWeekly ? '' : 'none';

    if (isWeekly) {
      setSelectedRecurrenceWeekdays(currentWeeklySelection, startDate);
    }

    if (!hasMonthlyAnchor) {
      document.getElementById('evt-recurrence-day').value = '';
    }
    if (recurrenceType === 'daily') {
      document.getElementById('evt-skip-weekend').checked = true;
    }
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
    document.getElementById('evt-share-with-team')?.addEventListener('change', () => {
      syncCalendarTypeControls(document.getElementById('evt-calendar-type')?.value);
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

    document.getElementById('evt-recurrence').addEventListener('change', () => updateRecurrenceUi());
    document.getElementById('evt-date')?.addEventListener('change', () => {
      if (normalizeRecurrenceType(document.getElementById('evt-recurrence')?.value || '') === 'weekly') {
        const currentSelection = getSelectedRecurrenceWeekdays();
        setSelectedRecurrenceWeekdays(currentSelection, document.getElementById('evt-date')?.value || getTodayDateStr());
      }
      updateRecurrenceUi();
    });

    requestNotificationPermission();
    populateClientOptions();
    renderViewSwitch();
    updateCalendarLayoutMode();
    renderStaffFilters();
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
      resetTeamMemberState();
      syncCalendarTypeControls();
      renderStaffFilters();
      if (!event.detail?.loggedIn) {
        allEvents = [];
        events = [];
        eventsByDate = new Map();
        allWeekTasks = [];
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
        allEvents = [];
        events = [];
        eventsByDate = new Map();
        allWeekTasks = [];
        if (!skipWeekTasks) {
          weekTasks = [];
          renderTaskSidebar();
        }
        renderStaffFilters();
        render();
        return [];
      }

      if (shouldShowStaffFilters()) {
        await loadTeamMembers({ force });
      } else {
        renderStaffFilters();
      }

      const isMonthFresh = !force && cachedMonth && (Date.now() - cachedMonth.loadedAt) < EVENTS_TTL;
      if (isMonthFresh) {
        allEvents = cachedMonth.items.slice();
        applyCalendarFilters({ renderSidebar: false });
        scheduleNotifications();
        if (!skipWeekTasks) void loadWeekTasks({ force: forceWeekTasks });
        void ensureHolidays(currentYear);
        return events;
      }

      if (cachedMonth?.items?.length) {
        allEvents = cachedMonth.items.slice();
        applyCalendarFilters({ renderSidebar: false });
      } else {
        allEvents = [];
        events = [];
        rebuildEventIndex();
        render();
      }

      const requestToken = ++monthLoadToken;
      void ensureHolidays(currentYear);
      const loadedEvents = await Auth.request(`/events?year=${currentYear}&month=${currentMonth + 1}&calendar_type=${encodeURIComponent(getActiveCalendarView())}`);
      if (requestToken !== monthLoadToken) return events;
      allEvents = Array.isArray(loadedEvents) ? loadedEvents : [];
      monthEventCache.set(monthKey, { items: allEvents.slice(), loadedAt: Date.now() });
    } catch (err) {
      console.error('[Calendar] 일정 로드 실패:', err.message);
      if (err.message !== 'Session expired' && retryCount < 2) {
        await new Promise(r => setTimeout(r, 1000));
        return load({ ...options, retryCount: retryCount + 1 });
      }
      if (err.message !== 'Session expired' && typeof UI !== 'undefined') {
        UI.showToast('일정을 불러오지 못했습니다', 'error');
      }
      allEvents = [];
      events = [];
      eventsByDate = new Map();
    }
    applyCalendarFilters({ renderSidebar: false });
    scheduleNotifications();
    if (!skipWeekTasks) void loadWeekTasks({ force: forceWeekTasks });
    return events;
  }

  function buildCalendarEventBar(ev) {
    const time = ev.start_time ? `${ev.start_time.substring(0, 5)} ` : '';
    const recurIcon = ev._recurring || ev.recurrence_type ? '<i class="ri-repeat-line" style="font-size:9px;margin-right:2px"></i>' : '';
    const taskIcon = ev.is_task ? '<i class="ri-checkbox-circle-line" style="font-size:9px;margin-right:2px"></i>' : '';
    const clientName = getClientName(ev.client_id);
    const ownerLabel = getEventOwnerLabel(ev);
    const doneClass = ev.is_done ? ' cal-event-done' : '';
    const scope = getEventScopeMeta(ev);
    return `<div class="cal-event-bar${doneClass}${scope.barClass}" style="background:${ev.color || DEFAULT_EVENT_COLOR}" data-id="${ev.id}" title="${scope.label}${ownerLabel ? ` · ${ownerLabel}` : ''} · ${time}${ev.title}${clientName ? ` · ${clientName}` : ''}">${recurIcon}${taskIcon}${time}${escapeHtml(ev.title)}${clientName ? ` · ${escapeHtml(clientName)}` : ''}</div>`;
  }

  function buildCalendarCellMarkup({ dateStr, dayNumber, dayEvents, isToday, dow, holidayName }) {
    const isSun = dow === 0;
    const isSat = dow === 6;
    const isHoliday = !!holidayName;

    let cellClass = 'cal-cell';
    if (isToday) cellClass += ' today';
    if (isSun) cellClass += ' sun';
    if (isSat) cellClass += ' sat';
    if (isHoliday) cellClass += ' holiday';

    let html = `<div class="${cellClass}" data-date="${dateStr}">`;
    html += '<div class="cal-cell-head">';
    html += `<span class="cal-day-num">${dayNumber}</span>`;
    if (isHoliday) {
      html += `<div class="cal-holiday-name">${escapeHtml(holidayName)}</div>`;
    }
    html += '</div>';
    html += '<div class="cal-cell-body">';
    if (dayEvents.length > 0) {
      html += '<div class="cal-events-wrap">';
      html += '<div class="cal-events">';
      dayEvents.slice(0, MAX_EVENTS_PER_DAY_CELL).forEach(ev => {
        html += buildCalendarEventBar(ev);
      });
      html += '</div>';
      if (dayEvents.length > MAX_EVENTS_PER_DAY_CELL) {
        html += `<div class="cal-event-more">+${dayEvents.length - MAX_EVENTS_PER_DAY_CELL}</div>`;
      }
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderDayCell(dateStr) {
    const cell = document.querySelector(`#calendar-grid .cal-cell[data-date="${dateStr}"]`);
    if (!cell) return;
    const target = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(target.getTime())) return;
    if (target.getFullYear() !== currentYear || target.getMonth() !== currentMonth) return;
    const today = new Date();
    const holidays = holidayCache[currentYear] || {};
    const nextMarkup = buildCalendarCellMarkup({
      dateStr,
      dayNumber: target.getDate(),
      dayEvents: eventsByDate.get(dateStr) || [],
      isToday: today.getFullYear() === currentYear && today.getMonth() === currentMonth && today.getDate() === target.getDate(),
      dow: target.getDay(),
      holidayName: holidays[dateStr],
    });
    cell.outerHTML = nextMarkup;
  }

  function refreshVisibleEventViews(dateStr = '') {
    if (dateStr) renderDayCell(dateStr);
    const dayEventsDate = document.getElementById('day-events-date')?.value || '';
    if (dayEventsDate && (!dateStr || dayEventsDate === dateStr)) {
      renderDayEventsList(dayEventsDate);
    }
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
      const holidayName = holidays[dateStr];
      html += buildCalendarCellMarkup({
        dateStr,
        dayNumber: d,
        dayEvents,
        isToday,
        dow,
        holidayName,
      });
    }

    grid.innerHTML = html;
    grid.style.setProperty('--calendar-row-count', String(Math.max(rowCount, 5)));
  }

  // ── Task Sidebar ──

  async function loadWeekTasks(options = {}) {
    if (!Auth.isLoggedIn()) {
      allWeekTasks = [];
      weekTasks = [];
      renderTaskSidebar();
      return [];
    }

    const force = !!options.force;
    const today = getTodayDateStr();
    const tasksOnly = options.tasksOnly ?? isWorkView();
    const calendarType = getActiveCalendarView();
    const weekKey = getWeekKey(new Date(`${today}T00:00:00`), tasksOnly);
    const isFresh = !force && weekTasksCacheKey === weekKey && (Date.now() - weekTasksLoadedAt) < WEEK_TASKS_TTL;
    if (isFresh) {
      applyCalendarFilters({ renderMonth: false, renderDayModal: false });
      return weekTasks;
    }

    if (weekTasksPromise && weekTasksPromiseKey === weekKey) return weekTasksPromise;

    weekTasksPromiseKey = weekKey;
    weekTasksPromise = (async () => {
      try {
        const loadedTasks = await Auth.request(`/events/week?date_str=${today}&calendar_type=${encodeURIComponent(calendarType)}&tasks_only=${tasksOnly ? 'true' : 'false'}`);
        allWeekTasks = Array.isArray(loadedTasks) ? loadedTasks : [];
        weekTasksLoadedAt = Date.now();
        weekTasksCacheKey = weekKey;
      } catch (err) {
        console.error('[Calendar] 주간 작업 로드 실패:', err.message);
        allWeekTasks = [];
        weekTasks = [];
      } finally {
        applyCalendarFilters({ renderMonth: false, renderDayModal: false });
        weekTasksPromise = null;
        weekTasksPromiseKey = '';
      }
      return weekTasks;
    })();

    return weekTasksPromise;
  }

  function applyTaskDoneState(eventId, targetDate, isDone) {
    const matchTask = allWeekTasks.find(task => task.id === eventId && (!targetDate || task.start_date === targetDate))
      || allWeekTasks.find(task => task.id === eventId);
    if (matchTask) matchTask.is_done = isDone;

    const dayEvents = targetDate ? allEvents.filter(event => event.start_date === targetDate) : allEvents;
    const matchEvent = dayEvents.find(event => event.id === eventId)
      || allEvents.find(event => event.id === eventId);
    if (matchEvent) matchEvent.is_done = isDone;
  }

  function renderTaskSidebar() {
    const container = document.getElementById('task-list');
    const title = document.querySelector('#task-sidebar .task-sidebar-header h3');
    if (!container) return;
    if (title) {
      title.innerHTML = isWorkView()
        ? '<i class="ri-list-check-2"></i> 이번 주 업무'
        : '<i class="ri-user-line"></i> 이번 주 개인 일정';
    }
    if (weekTasks.length === 0) {
      container.innerHTML = `<div class="task-empty"><i class="${isWorkView() ? 'ri-checkbox-circle-line' : 'ri-calendar-line'}"></i><p>${isWorkView() ? '이번 주 업무가 없습니다' : '이번 주 개인 일정이 없습니다'}</p></div>`;
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
        const ownerLabel = getEventOwnerLabel(t);
        const scope = getEventScopeMeta(t);
        const calendarBadge = `<span class="task-item-badge${scope.badgeClass}"><i class="${scope.badgeIcon}"></i> ${scope.badgeLabel}</span>`;
        const dateAttr = (t._recurring || t.recurrence_type) ? ` data-date="${t.start_date}"` : '';
        html += `<div class="task-item${doneClass}">
          <input type="checkbox" class="task-check" data-id="${t.id}"${dateAttr} ${checked} />
          <div class="task-item-body">
            <span class="task-item-title">${escapeHtml(t.title)}</span>
            ${time ? `<span class="task-item-time">${time}</span>` : ''}
            ${ownerLabel ? `<span class="task-item-time">담당자 · ${escapeHtml(ownerLabel)}</span>` : ''}
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
        const targetDate = cb.dataset.date || weekTasks.find(task => task.id === cb.dataset.id)?.start_date || '';
        const taskItem = cb.closest('.task-item');
        cb.disabled = true;
        applyTaskDoneState(cb.dataset.id, targetDate, nextDone);
        if (taskItem) taskItem.classList.toggle('task-done', nextDone);
        refreshVisibleEventViews(targetDate);
        try {
          const qs = targetDate ? `?target_date=${encodeURIComponent(targetDate)}` : '';
          await Auth.request(`/events/${cb.dataset.id}/done${qs}`, {
            method: 'PATCH',
            body: JSON.stringify({ is_done: nextDone }),
          });
          weekTasksLoadedAt = Date.now();
          const cachedMonth = monthEventCache.get(getMonthKey(currentYear, currentMonth));
          if (cachedMonth) cachedMonth.loadedAt = Date.now();
          applyCalendarFilters({ renderDayModal: true });
        } catch (err) {
          applyTaskDoneState(cb.dataset.id, targetDate, !nextDone);
          if (taskItem) taskItem.classList.toggle('task-done', !nextDone);
          refreshVisibleEventViews(targetDate);
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
    document.getElementById('evt-skip-weekend').checked = true;
    document.getElementById('evt-recurrence-day').value = '';
    setSelectedRecurrenceWeekdays([], dateStr || getTodayDateStr());
    document.getElementById('evt-client').value = '';
    document.getElementById('evt-share-with-team').checked = false;
    document.getElementById('evt-calendar-type').value = getCurrentCalendarTypeForForm();
    syncCalendarTypeControls(getCurrentCalendarTypeForForm());
    updateRecurrenceUi();
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
      const ownerLabel = getEventOwnerLabel(ev);
      const doneClass = ev.is_done ? ' day-event-done' : '';
      const scope = getEventScopeMeta(ev);
      return `<button type="button" class="day-event-item${doneClass}" data-id="${ev.id}">
        <span class="day-event-color" style="background:${ev.color || DEFAULT_EVENT_COLOR}"></span>
        <div class="day-event-main">
          <div class="day-event-line">
            <span class="day-event-time">${time}</span>
            <span class="day-event-title">${escapeHtml(ev.title)}</span>
          </div>
          <div class="day-event-meta">
            <span class="day-event-badge${scope.badgeClass}"><i class="${scope.badgeIcon}"></i>${scope.badgeLabel}</span>
            ${ownerLabel ? `<span class="day-event-badge"><i class="ri-user-line"></i>${escapeHtml(ownerLabel)}</span>` : ''}
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
    const recurrenceType = normalizeRecurrenceType(ev.recurrence_type || '');
    document.getElementById('evt-recurrence').value = recurrenceType || '';
    document.getElementById('evt-recurrence-end').value = ev.recurrence_end || '';
    const hasMonthlyAnchor = usesMonthlyAnchor(recurrenceType);
    document.getElementById('evt-recurrence-day').value = hasMonthlyAnchor ? (ev.recurrence_day || new Date(ev.start_date + 'T00:00:00').getDate()) : '';
    setSelectedRecurrenceWeekdays(ev.recurrence_weekdays || [], ev.start_date);
    document.getElementById('evt-skip-weekend').checked = recurrenceType === 'daily' ? true : (ev.skip_weekend || false);
    document.getElementById('evt-calendar-type').value = getEventCalendarType(ev);
    document.getElementById('evt-share-with-team').checked = isTeamSharedEvent(ev);
    syncCalendarTypeControls(getEventCalendarType(ev));
    updateRecurrenceUi();
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
    const recurrence = normalizeRecurrenceType(document.getElementById('evt-recurrence').value);
    const recurrenceWeekdays = recurrence === 'weekly'
      ? getSelectedRecurrenceWeekdays(document.getElementById('evt-date').value || getTodayDateStr())
      : [];
    const calendarType = document.getElementById('evt-calendar-type').value || getCurrentCalendarTypeForForm();
    const shareWithTeam = calendarType === 'work' && document.getElementById('evt-share-with-team').checked;

    let startDate = document.getElementById('evt-date').value;
    let recurrenceDay = null;
    if (usesMonthlyAnchor(recurrence)) {
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
      recurrence_weekdays: recurrenceWeekdays,
      calendar_type: calendarType,
      share_with_team: shareWithTeam,
      is_task: calendarType === 'work' && document.getElementById('evt-is-task').checked,
      skip_weekend: recurrence === 'daily' ? true : (recurrence ? document.getElementById('evt-skip-weekend').checked : false),
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
    allEvents.forEach(ev => {
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
    document.getElementById('evt-share-with-team').checked = !!prefill.shareWithTeam;
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

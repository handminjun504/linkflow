const Preferences = (() => {
  const LEGACY_KEYS = {
    clientViewState: 'lf_clients_view_state',
    clientCustomView: 'lf_clients_custom_view',
    urlNotes: 'lf_url_notes',
  };

  let state = freshState();
  let loadedUserId = null;
  let loadPromise = null;
  let saveQueue = Promise.resolve();

  function freshState() {
    return {
      clientViewState: {},
      clientCustomView: null,
      urlNotes: {},
    };
  }

  function cloneObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { ...value };
  }

  function cloneMaybeObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return { ...value };
  }

  function snapshot() {
    return {
      clientViewState: cloneObject(state.clientViewState),
      clientCustomView: cloneMaybeObject(state.clientCustomView),
      urlNotes: cloneObject(state.urlNotes),
    };
  }

  function emitChange() {
    window.dispatchEvent(new CustomEvent('lf:preferences-changed', {
      detail: snapshot(),
    }));
  }

  function getActiveUserId() {
    return Auth?.getUser?.()?.id || null;
  }

  function normalizeRemote(remote) {
    return {
      clientViewState: cloneObject(remote?.client_view_state),
      clientCustomView: cloneMaybeObject(remote?.client_custom_view),
      urlNotes: cloneObject(remote?.url_notes),
    };
  }

  function applyRemote(remote) {
    state = normalizeRemote(remote);
  }

  function parseLegacyValue(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function readLegacy() {
    return {
      clientViewState: cloneObject(parseLegacyValue(LEGACY_KEYS.clientViewState, {})),
      clientCustomView: cloneMaybeObject(parseLegacyValue(LEGACY_KEYS.clientCustomView, null)),
      urlNotes: cloneObject(parseLegacyValue(LEGACY_KEYS.urlNotes, {})),
    };
  }

  function clearLegacy() {
    Object.values(LEGACY_KEYS).forEach(key => localStorage.removeItem(key));
  }

  function getMigrationPayload(legacy) {
    const payload = {};
    if (!Object.keys(state.clientViewState).length && Object.keys(legacy.clientViewState).length) {
      payload.client_view_state = legacy.clientViewState;
    }
    if (!state.clientCustomView && legacy.clientCustomView) {
      payload.client_custom_view = legacy.clientCustomView;
    }
    if (!Object.keys(state.urlNotes).length && Object.keys(legacy.urlNotes).length) {
      payload.url_notes = legacy.urlNotes;
    }
    return payload;
  }

  async function saveRaw(payload) {
    if (!Auth?.isLoggedIn?.()) return snapshot();
    const userId = getActiveUserId();
    if (!userId) return snapshot();

    saveQueue = saveQueue.catch(() => null).then(async () => {
      const remote = await Auth.request('/user/preferences', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      loadedUserId = userId;
      applyRemote(remote);
      emitChange();
      return snapshot();
    });

    return saveQueue;
  }

  async function load(options = {}) {
    const force = !!options.force;
    const userId = getActiveUserId();
    if (!Auth?.isLoggedIn?.() || !userId) {
      reset();
      return snapshot();
    }

    if (!force && loadedUserId === userId && !loadPromise) {
      return snapshot();
    }

    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      const legacy = readLegacy();
      let fetched = false;

      try {
        const remote = await Auth.request('/user/preferences');
        applyRemote(remote);
        loadedUserId = userId;
        fetched = true;
      } catch {
        state = {
          clientViewState: legacy.clientViewState,
          clientCustomView: legacy.clientCustomView,
          urlNotes: legacy.urlNotes,
        };
      }

      const migrationPayload = getMigrationPayload(legacy);
      if (fetched && Object.keys(migrationPayload).length) {
        try {
          await saveRaw(migrationPayload);
        } catch {}
      }

      if (fetched) clearLegacy();
      emitChange();
      return snapshot();
    })().finally(() => {
      loadPromise = null;
    });

    return loadPromise;
  }

  function reset() {
    state = freshState();
    loadedUserId = null;
    loadPromise = null;
    emitChange();
  }

  function getClientViewState() {
    return cloneObject(state.clientViewState);
  }

  function getClientCustomView() {
    return cloneMaybeObject(state.clientCustomView);
  }

  function getUrlNotes() {
    return cloneObject(state.urlNotes);
  }

  async function setClientViewState(viewState) {
    state.clientViewState = cloneObject(viewState);
    emitChange();
    return saveRaw({ client_view_state: state.clientViewState });
  }

  async function setClientCustomView(customView) {
    state.clientCustomView = cloneMaybeObject(customView);
    emitChange();
    return saveRaw({ client_custom_view: state.clientCustomView });
  }

  async function setUrlNotes(urlNotes) {
    state.urlNotes = cloneObject(urlNotes);
    emitChange();
    return saveRaw({ url_notes: state.urlNotes });
  }

  async function setUrlNote(host, noteText) {
    const nextNotes = cloneObject(state.urlNotes);
    if (noteText) nextNotes[host] = noteText;
    else delete nextNotes[host];
    return setUrlNotes(nextNotes);
  }

  window.addEventListener('lf:auth-changed', event => {
    const nextUserId = event.detail?.user?.id || null;
    if (nextUserId !== loadedUserId) reset();
  });

  return {
    load,
    reset,
    getClientViewState,
    getClientCustomView,
    getUrlNotes,
    setClientViewState,
    setClientCustomView,
    setUrlNotes,
    setUrlNote,
  };
})();

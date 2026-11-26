'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const state = { users: new Map(), cursor: null, pages: 0, loading: false, deciding: false, isAdmin: false, accountId:null };
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function dateLabel(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? dateFormat.format(date) : 'Not recorded';
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function badge(text, className) {
    return element('span', `badge ${className}`, text);
  }

  function message(text, error = false) {
    const target = byId('adminMessage');
    target.textContent = text;
    target.className = error ? 'notice error' : 'notice';
    target.hidden = !text;
  }

  function accessState(title, copy, { signIn = false, retry = false } = {}) {
    state.isAdmin = false;
    state.accountId = null;
    state.users.clear();
    state.cursor = null;
    state.pages = 0;
    byId('userRows').replaceChildren();
    byId('requestList').replaceChildren();
    byId('adminEmail').textContent = '';
    byId('adminContent').hidden = true;
    byId('accessState').hidden = false;
    byId('accessTitle').textContent = title;
    byId('accessCopy').textContent = copy;
    byId('signInLink').hidden = !signIn;
    byId('retryAccess').hidden = !retry;
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'manual', ...options, signal: controller.signal,
        headers: { Accept: 'application/json', ...(state.accountId ? {'X-Farmer-Account-Id':state.accountId} : {}), ...(options.headers || {}) }
      });
      if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 302) {
        throw Object.assign(new Error('Please sign in again to use administration.'), { status: 401 });
      }
      if (response.status === 403) {
        throw Object.assign(new Error('This account does not have administrator access.'), { status: 403 });
      }
      if (response.status === 409) {
        throw Object.assign(new Error('This request has changed. The list has been refreshed so you can see its latest status.'), { status: 409 });
      }
      if (!response.ok) {
        const message = response.status === 404 || response.status >= 500
          ? `The account service is temporarily unavailable (HTTP ${response.status}). Please retry in a moment.`
          : `The account service could not complete this request (HTTP ${response.status}). Please retry.`;
        throw Object.assign(new Error(message), { status: response.status });
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('The account service returned an unexpected response. Please retry in a moment.');
      }
      return await response.json().catch(() => { throw new Error('The account service returned an unexpected response. Please retry in a moment.'); });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The account service took too long to respond. Please retry.');
      if (error.name === 'TypeError') throw new Error('Could not connect to the account service. Check your connection and retry.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function handleAccessError(error) {
    if (error.status === 401) {
      accessState('Sign in to continue', 'Your session has ended. Sign in with an administrator account to view this page.', { signIn: true });
      return true;
    }
    if (error.status === 403) {
      accessState('Administrator access only', 'Your signed-in account is not an administrator. You can request Frontier Farm early access from the app.');
      return true;
    }
    return false;
  }

  function syncControls() {
    const busy = state.loading || state.deciding;
    byId('refreshUsers').disabled = busy;
    byId('loadMore').disabled = busy;
    byId('loadMore').hidden = !state.cursor;
    byId('requestList').setAttribute('aria-busy', String(busy));
    document.querySelectorAll('.request-actions button').forEach(button => { button.disabled = busy; });
  }

  function renderUsers() {
    const users = [...state.users.values()];
    const pending = users.filter(user => user.request?.status === 'pending' && !user.isAdmin)
      .sort((a, b) => String(a.request.requestedAt || '').localeCompare(String(b.request.requestedAt || '')));
    byId('accountCount').textContent = String(users.length);
    byId('pendingCount').textContent = String(pending.length);
    byId('premiumCount').textContent = String(users.filter(user => user.plan === 'premium' || user.isAdmin).length);
    const requests = document.createDocumentFragment();
    pending.forEach(user => {
      const row = element('article', 'request-row');
      const content = element('div');
      const heading = element('div', 'request-heading');
      const email = typeof user.email === 'string' && user.email ? user.email : 'Email unavailable';
      heading.append(element('h3', '', email), badge('Pending', 'pending'));
      content.append(heading, element('p', 'request-meta', `Requested ${dateLabel(user.request.requestedAt)}`),
        element('p', 'request-reason', user.request.reason || 'No message included.'));
      const actions = element('div', 'request-actions');
      [['approve', 'Approve', 'primary'], ['decline', 'Decline', 'secondary decline-action']].forEach(([action, label, style]) => {
        const button = element('button', `button ${style}`, label);
        button.type = 'button';
        button.setAttribute('aria-label', `${label} Frontier Farm request from ${email}`);
        button.addEventListener('click', () => decide(user, action));
        actions.append(button);
      });
      row.append(content, actions);
      requests.append(row);
    });
    if (!pending.length) {
      requests.append(element('p', 'empty-state', state.cursor
        ? 'No pending requests among the accounts shown. Load more below to check the remaining accounts.'
        : 'All caught up. New Frontier Farm requests will appear here.'));
    }
    byId('requestList').replaceChildren(requests);

    const rows = document.createDocumentFragment();
    users.forEach(user => {
      const row = element('tr');
      const identity = element('td');
      identity.append(element('span', 'account-email', user.email || 'Email unavailable'));
      if (user.isAdmin) identity.append(element('span', 'account-admin', 'Administrator'));
      const plan = element('td');
      plan.append(user.isAdmin ? badge('Admin · all features', 'admin')
        : user.plan === 'premium' ? badge('Frontier', 'premium') : badge('Free', 'free'));
      const historyCell = element('td');
      const request = user.request;
      if (request && ['pending', 'approved', 'declined'].includes(request.status)) {
        const history = element('div', 'request-history');
        history.append(badge(request.status.charAt(0).toUpperCase() + request.status.slice(1), request.status));
        history.append(element('small', '', `Requested ${dateLabel(request.requestedAt)}`));
        if (request.decidedAt) history.append(element('small', '', `Decided ${dateLabel(request.decidedAt)}`));
        if (request.decidedBy) history.append(element('small', '', `By ${request.decidedBy}`));
        if (request.reason) {
          const details = element('details');
          details.append(element('summary', '', 'Request message'), element('p', '', request.reason));
          history.append(details);
        }
        historyCell.append(history);
      } else historyCell.textContent = 'No request';
      row.append(identity, plan, element('td', '', dateLabel(user.joinedAt)), element('td', '', dateLabel(user.lastSeenAt)), historyCell);
      rows.append(row);
    });
    byId('userRows').replaceChildren(rows);
    byId('usersEmpty').hidden = users.length > 0;
    byId('paginationNote').textContent = (state.cursor ? 'More accounts and requests are available. ' : 'All available accounts are shown. ')
      + 'Dates use your device’s time zone. Last active records app activity; it does not mean someone is online.';
    syncControls();
  }

  async function loadUsers({ append = false, preservePages = false } = {}) {
    if (state.loading || !state.isAdmin) return false;
    state.loading = true;
    syncControls();
    let completed = false;
    try {
      const pageLimit = preservePages ? Math.max(state.pages, 1) : 1;
      let cursor = append ? state.cursor : null;
      const nextUsers = append ? new Map(state.users) : new Map();
      let pages = append ? state.pages : 0;
      for (let index = 0; index < pageLimit; index += 1) {
        const data = await api(`/api/management${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!Array.isArray(data.users)) throw new Error('Account information could not be read. Please refresh.');
        data.users.forEach(user => {
          if (user && typeof user.id === 'string') nextUsers.set(user.id, user);
        });
        cursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : null;
        pages += 1;
        if (!cursor || append) break;
      }
      state.users = nextUsers;
      state.cursor = cursor;
      state.pages = pages;
      renderUsers();
      byId('updatedLabel').textContent = `Updated ${dateLabel(new Date().toISOString())}`;
      completed = true;
    } catch (error) {
      if (!handleAccessError(error)) {
        message(error.message || 'Could not load accounts. Check your connection and try again.', true);
        if (!state.users.size) byId('requestList').replaceChildren(element('p', 'empty-state', 'Account information is unavailable. Use Refresh to try again.'));
        byId('updatedLabel').textContent = state.users.size ? 'Refresh failed. Showing the previously loaded accounts.' : 'Account information is unavailable.';
      }
    } finally {
      state.loading = false;
      syncControls();
    }
    return completed;
  }

  async function decide(user, action) {
    if (state.loading || state.deciding || !state.isAdmin) return;
    state.deciding = true;
    syncControls();
    message('');
    try {
      await api('/api/management', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, userId: user.id, requestId: user.request.id })
      });
      const refreshed = await loadUsers({ preservePages: true });
      if (refreshed) message(action === 'approve' ? `Frontier Farm approved for ${user.email || 'this account'}.`
        : `Frontier Farm request declined for ${user.email || 'this account'}.`);
    } catch (error) {
      if (!handleAccessError(error)) {
        if (error.status === 409) {
          const refreshed = await loadUsers({ preservePages: true });
          if (refreshed) message(error.message, true);
        } else message(error.message || 'Could not save the decision. Please try again.', true);
      }
    } finally {
      state.deciding = false;
      syncControls();
    }
  }

  async function initialize() {
    accessState('Checking your access…', 'Connecting to your Farmer Daily account.');
    try {
      const account = await api('/api/account');
      if (typeof account?.isAdmin !== 'boolean' || typeof account?.user?.id !== 'string' || !account.user.id) {
        throw new Error('The account service returned an incomplete response. Please retry in a moment.');
      }
      if (account.isAdmin !== true) {
        accessState('Administrator access only', 'Your signed-in account is not an administrator. You can request Frontier Farm early access from the app.');
        return;
      }
      state.isAdmin = true;
      state.accountId = account.user.id;
      byId('adminEmail').textContent = account.user.email || 'Administrator';
      byId('accessState').hidden = true;
      byId('adminContent').hidden = false;
      message('');
      await loadUsers();
    } catch (error) {
      if (!handleAccessError(error)) accessState('Account service unavailable', error.message || 'Check your connection and try again.', { retry: true });
    }
  }

  byId('refreshUsers').addEventListener('click', () => { message(''); loadUsers({ preservePages: true }); });
  byId('loadMore').addEventListener('click', () => { message(''); loadUsers({ append: true }); });
  byId('retryAccess').addEventListener('click', initialize);
  window.addEventListener('pageshow', event => { if (event.persisted) initialize(); });
  initialize();
})();

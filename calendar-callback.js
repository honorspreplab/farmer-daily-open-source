'use strict';

// Deliberately isolated from the app shell and its storage, analytics, fonts and
// administrator routing. Authorization codes live only in this short-lived
// closure and a same-origin HTTPS POST, never in farm state or browser storage.
(() => {
  const original = new URL(location.href);
  const parameters = original.searchParams;
  const provider = /^\/calendar-callback\/(google|outlook)$/.exec(original.pathname)?.[1];
  // Remove the query before any asynchronous work or additional requests.
  history.replaceState(null, '', original.pathname);
  const status = document.getElementById('calendarCallbackStatus');
  const message = text => { status.textContent = text; };
  const back = result => location.replace(`/?view=farmer&calendar=${result}#connected`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  window.addEventListener('pagehide', () => controller.abort(), { once: true });
  async function json(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: controller.signal, ...options });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Connection not confirmed');
    return response.json();
  }
  async function complete() {
    if (!provider || original.href.length > 18000 || parameters.getAll('state').length !== 1 || !/^[A-Za-z0-9_-]{32,256}$/.test(parameters.get('state') || '')) {
      message('This calendar connection link is incomplete or expired. Return to Connected farm and start again.');
      return;
    }
    if (parameters.has('error')) { back('cancelled'); return; }
    const code = parameters.get('code');
    if (parameters.getAll('code').length !== 1 || !code || code.length > 12000 || /[\u0000-\u001f\u007f]/.test(code)) {
      message('No valid authorization was returned. Return to Connected farm and start again.');
      return;
    }
    const identity = (await json('/.auth/me')).clientPrincipal;
    if (!identity || identity.identityProvider !== 'aad' || !Array.isArray(identity.userRoles) || !identity.userRoles.includes('authenticated') || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.userId || '')) {
      message('Your Farmer Daily sign-in expired. Return to the app, sign in with Microsoft, and start the calendar connection again.');
      return;
    }
    message('Finishing the connection securely. Please keep this page open.');
    const result = await json('/api/calendar-connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Farmer-Account-Id': identity.userId },
      body: JSON.stringify({ action: 'complete', provider, code, state: parameters.get('state') })
    });
    if (result?.connected !== true || result.provider !== provider) throw new Error('Connection not confirmed');
    back('connected');
  }
  complete().catch(() => {
    message('The connection could not be confirmed. Return to Connected farm and reload connections before trying again. An empty Farmer Daily calendar may already have been created; no task was sent by this page.');
  }).finally(() => clearTimeout(timer));
})();

const { getContainer: defaultContainer, readDocument, replaceDocument } = require('./store');

// Only the Azure Static Web Apps identity header can establish administrator access.
// Never read these identities from a profile, request body, or browser storage.
// Configure exact administrator addresses in server settings, never in client code.
// Missing, empty, oversized, or malformed configuration deliberately grants nobody.
function configuredAdminEmails() {
  const configured = process.env.ADMIN_EMAILS;
  if (typeof configured !== 'string' || !configured.trim() || configured.length > 8192) return new Set();
  const emails = configured.split(',').map(value => value.trim().toLowerCase());
  const emailPattern = /^[^\s@,;<>*]+@[^\s@,;<>*]+\.[^\s@,;<>*]+$/;
  if (emails.some(email => email.length > 320 || !emailPattern.test(email))) return new Set();
  return new Set(emails);
}
const TIME_ZONE = 'America/Los_Angeles';
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function dateKey(value = Date.now()) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function header(req, name) {
  if (typeof req.headers?.get === 'function') return req.headers.get(name);
  const value = req.headers?.[name] ?? req.headers?.[Object.keys(req.headers || {}).find(key => key.toLowerCase() === name)];
  return typeof value === 'string' ? value : '';
}

function isAdminIdentity(email, identityProvider) {
  return identityProvider === 'aad' && typeof email === 'string' && configuredAdminEmails().has(email.trim().toLowerCase());
}

function principalFrom(req) {
  const encoded = header(req, 'x-ms-client-principal');
  if (!encoded || encoded.length > 16000) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (typeof value.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.userId) ||
        !Array.isArray(value.userRoles) || !value.userRoles.includes('authenticated') ||
        value.identityProvider !== 'aad' || typeof value.userDetails !== 'string' || value.userDetails.length > 320) return null;
    return {
      id: value.userId,
      email: value.userDetails.trim().toLowerCase(),
      identityProvider: value.identityProvider,
      isAdmin: isAdminIdentity(value.userDetails, value.identityProvider),
      isFarmer: value.userRoles.includes('farmer')
    };
  } catch { return null; }
}

function checkMutation(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  if (header(req, 'sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Use Farmer Daily to make this change');
  const origin = header(req, 'origin');
  if (origin) {
    const allowed = new Set(['https://calm-desert-02e51f41e.1.azurestaticapps.net']);
    if (process.env.APP_ORIGIN) allowed.add(process.env.APP_ORIGIN.replace(/\/$/, ''));
    const host = header(req, 'host');
    if (/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) {
      allowed.add(`https://${host}`);
      if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) allowed.add(`http://${host}`);
    }
    if (!allowed.has(origin)) throw new HttpError(403, 'Use Farmer Daily to make this change');
  }
  if (req.method !== 'DELETE' && !/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type'))) {
    throw new HttpError(415, 'Send a JSON request');
  }
}

function respond(context, status, body) {
  context.res = { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, ...(status === 204 ? {} : { body }) };
}

function handleError(context, error) {
  if (error instanceof HttpError) return respond(context, error.status, { error: error.message });
  context.log?.error?.('Account operation failed. No user or farm information was logged.');
  return respond(context, 503, { error: 'Cloud service temporarily unavailable. Please retry.', retryable: true });
}

function accountPlan(account, isAdmin) {
  return isAdmin || (account.plan === 'premium' && account.request?.status === 'approved') ? 'premium' : 'free';
}

function publicAccount(account, isAdmin = isAdminIdentity(account.email, account.identityProvider)) {
  return {
    id: account.userId, email: account.email,
    joinedAt: account.joinedAt, lastSeenAt: account.lastSeenAt,
    plan: accountPlan(account, isAdmin), isAdmin,
    request: account.request ? {
      id: account.request.id, status: account.request.status, reason: account.request.reason || '',
      requestedAt: account.request.requestedAt, decidedAt: account.request.decidedAt || null,
      decidedBy: account.request.decidedBy || null
    } : null
  };
}

function createAccess({ getContainer = defaultContainer, now = Date.now } = {}) {
  async function ensureAccount(principal, touch = false) {
    const container = getContainer();
    const id = `account-${principal.id}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const account = await readDocument(container, id, principal.id);
      const timestamp = new Date(now()).toISOString();
      if (account) {
        if (!touch && account.email === principal.email && account.identityProvider === principal.identityProvider) return account;
        const updated = { ...account, email: principal.email, identityProvider: principal.identityProvider, lastSeenAt: timestamp };
        try { return (await replaceDocument(container, updated)).resource || updated; }
        catch (error) { if (Number(error.code) === 412) continue; throw error; }
      }
      const created = {
        id, userId: principal.id, type: 'account', schemaVersion: 1,
        email: principal.email, identityProvider: principal.identityProvider,
        joinedAt: timestamp, lastSeenAt: timestamp, plan: 'free', request: null, requestHistory: []
      };
      try { return (await container.items.create(created)).resource || created; }
      catch (error) { if (Number(error.code) === 409) continue; throw error; }
    }
    throw new HttpError(409, 'Your account changed. Please retry.');
  }

  async function requireAccess(req, { premium = false, admin = false, touch = false } = {}) {
    const principal = principalFrom(req);
    if (!principal) throw new HttpError(401, 'Sign in to Farmer Daily');
    const expectedAccount = header(req, 'x-farmer-account-id');
    if (expectedAccount && expectedAccount !== principal.id) throw new HttpError(409, 'Account changed. Reload Farmer Daily before continuing.');
    if (admin && !principal.isAdmin) throw new HttpError(403, 'Administrator access required');
    checkMutation(req);
    const account = await ensureAccount(principal, touch);
    const plan = accountPlan(account, principal.isAdmin);
    if (premium && plan !== 'premium') throw new HttpError(403, 'Premium approval is required for this feature');
    return { principal, account, isAdmin: principal.isAdmin, plan };
  }
  return { principalFrom, requireAccess, ensureAccount };
}

module.exports = { createAccess, principalFrom, isAdminIdentity, accountPlan, publicAccount, HttpError, dateKey, header, checkMutation, respond, handleError };

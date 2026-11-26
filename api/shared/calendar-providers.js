'use strict';

// All network destinations are fixed here. Provider response bodies (which may
// contain tokens or personal information) are never logged or returned as errors.
const { HttpError } = require('./access');
const GOOGLE_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.app.created';
const MICROSOFT_SCOPE = 'offline_access User.Read Calendars.ReadWrite';
const DEFINITIONS = Object.freeze({
  google: { name: 'Google Calendar', client: 'GOOGLE_CALENDAR_CLIENT_ID', secret: 'GOOGLE_CALENDAR_CLIENT_SECRET', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: GOOGLE_SCOPE },
  outlook: { name: 'Outlook Calendar', client: 'MICROSOFT_CALENDAR_CLIENT_ID', secret: 'MICROSOFT_CALENDAR_CLIENT_SECRET', authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: MICROSOFT_SCOPE }
});
function providerDefinition(provider) {
  if (typeof provider !== 'string' || !Object.hasOwn(DEFINITIONS, provider)) throw new HttpError(400, 'Choose Google Calendar or Outlook Calendar');
  return DEFINITIONS[provider];
}
function configuration(provider, env = process.env) {
  const definition = providerDefinition(provider), missing = [];
  let origin;
  try { const url = new URL(env.APP_ORIGIN); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(); origin = url.origin; } catch { missing.push('APP_ORIGIN'); }
  for (const name of [definition.client, definition.secret]) if (typeof env[name] !== 'string' || !env[name].trim() || env[name].length > 8192) missing.push(name);
  let key;
  if (typeof env.CALENDAR_TOKEN_KEY === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(env.CALENDAR_TOKEN_KEY)) key = Buffer.from(env.CALENDAR_TOKEN_KEY, 'base64');
  if (!key || key.length !== 32) missing.push('CALENDAR_TOKEN_KEY');
  return { ...definition, provider, configured: missing.length === 0, missing, origin, key, clientId: env[definition.client], clientSecret: env[definition.secret], redirectUri: origin ? `${origin}/calendar-callback/${provider}` : null };
}
function authorizationUrl(config, state, challenge) {
  const url = new URL(config.authorize);
  for (const [key, value] of Object.entries({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: config.scope, state, code_challenge: challenge, code_challenge_method: 'S256', ...(config.provider === 'google' ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' } : { response_mode: 'query', prompt: 'select_account' }) })) url.searchParams.set(key, value);
  return url.href;
}
class ProviderError extends Error {
  constructor(status = 0) { super('Calendar provider did not confirm this operation'); this.providerStatus = status; }
}
async function providerJson(fetchImpl, url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['oauth2.googleapis.com', 'openidconnect.googleapis.com', 'www.googleapis.com', 'login.microsoftonline.com', 'graph.microsoft.com'].includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) throw new Error('Invalid calendar endpoint');
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new ProviderError(response.status);
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new ProviderError();
    if (Number(response.headers.get('content-length') || 0) > 65536) throw new ProviderError();
    const reader = response.body?.getReader();
    let content = '';
    if (reader) {
      let total = 0; const chunks = [];
      while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > 65536) { await reader.cancel(); throw new ProviderError(); } chunks.push(Buffer.from(value)); }
      content = Buffer.concat(chunks).toString('utf8');
    } else { content = await response.text(); if (Buffer.byteLength(content) > 65536) throw new ProviderError(); }
    const result = JSON.parse(content);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ProviderError();
    return result;
  } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError(); }
}
function normalizeTokens(value, config, now, previous) {
  if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16000 || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0 || Number(value.expires_in) > 86400) throw new ProviderError();
  const refresh = value.refresh_token || previous?.refreshToken;
  if (typeof refresh !== 'string' || !refresh || refresh.length > 16000) throw new ProviderError();
  // OAuth permits omitted scope when it is identical to the requested scope.
  // When returned, verify the capability this adapter uses. Extra grants are unused.
  if (typeof value.scope === 'string') {
    const scopes = new Set(value.scope.toLowerCase().split(/\s+/));
    const needed = config.provider === 'google' ? 'https://www.googleapis.com/auth/calendar.app.created' : 'calendars.readwrite';
    if (!scopes.has(needed) && !scopes.has(`https://graph.microsoft.com/${needed}`)) throw new ProviderError(403);
  }
  return { accessToken: value.access_token, refreshToken: refresh, expiresAt: now + Number(value.expires_in) * 1000 };
}
async function tokenRequest(fetchImpl, config, values, now, previous) {
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...values });
  const result = await providerJson(fetchImpl, config.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  return normalizeTokens(result, config, now, previous);
}
function redeem(fetchImpl, config, code, verifier, now) { return tokenRequest(fetchImpl, config, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.redirectUri }, now); }
function refresh(fetchImpl, config, tokens, now) { return tokenRequest(fetchImpl, config, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, ...(config.provider === 'outlook' ? { scope: config.scope } : {}) }, now, tokens); }
function bearer(tokens, json = false) { return { Authorization: `Bearer ${tokens.accessToken}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }; }
async function identity(fetchImpl, config, tokens) {
  const result = await providerJson(fetchImpl, config.provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', { headers: bearer(tokens) });
  const id = config.provider === 'google' ? result.sub : result.id;
  const label = config.provider === 'google' ? result.email : result.mail || result.userPrincipalName;
  if (typeof id !== 'string' || !id || id.length > 512 || typeof label !== 'string' || !label || label.length > 320 || /[\u0000-\u001f]/.test(label) || config.provider === 'google' && result.email_verified !== true) throw new ProviderError();
  return { id, label };
}
async function createCalendar(fetchImpl, config, tokens) {
  const google = config.provider === 'google';
  const result = await providerJson(fetchImpl, google ? 'https://www.googleapis.com/calendar/v3/calendars' : 'https://graph.microsoft.com/v1.0/me/calendars', { method: 'POST', headers: bearer(tokens, true), body: JSON.stringify(google ? { summary: 'Farmer Daily', timeZone: 'America/Los_Angeles' } : { name: 'Farmer Daily' }) });
  if (typeof result.id !== 'string' || !result.id || result.id.length > 1024 || /[\u0000-\u001f]/.test(result.id)) throw new ProviderError();
  return { id: result.id, name: 'Farmer Daily' };
}
async function createEvent(fetchImpl, config, connection, tokens, proposal) {
  const google = config.provider === 'google', snapshot = proposal.preview, calendar = encodeURIComponent(connection.calendarId);
  const body = google ? { id: proposal.externalId, summary: snapshot.title, visibility: 'private', reminders: { useDefault: false }, ...(snapshot.allDay ? { start: { date: snapshot.date }, end: { date: snapshot.endDate } } : { start: { dateTime: snapshot.startUtc, timeZone: 'America/Los_Angeles' }, end: { dateTime: snapshot.endUtc, timeZone: 'America/Los_Angeles' } }) } : { subject: snapshot.title, sensitivity: 'private', isReminderOn: false, transactionId: proposal.id, isAllDay: snapshot.allDay, start: { dateTime: snapshot.allDay ? `${snapshot.date}T00:00:00` : snapshot.startUtc.replace(/Z$/, ''), timeZone: snapshot.allDay ? 'Pacific Standard Time' : 'UTC' }, end: { dateTime: snapshot.allDay ? `${snapshot.endDate}T00:00:00` : snapshot.endUtc.replace(/Z$/, ''), timeZone: snapshot.allDay ? 'Pacific Standard Time' : 'UTC' } };
  const result = await providerJson(fetchImpl, google ? `https://www.googleapis.com/calendar/v3/calendars/${calendar}/events?sendUpdates=none` : `https://graph.microsoft.com/v1.0/me/calendars/${calendar}/events`, { method: 'POST', headers: bearer(tokens, true), body: JSON.stringify(body) });
  if (typeof result.id !== 'string' || !result.id || result.id.length > 2048 || google && result.id !== proposal.externalId) throw new ProviderError();
  let eventUrl = null;
  const rawUrl = google ? result.htmlLink : result.webLink;
  try { const url = new URL(rawUrl); if (url.protocol === 'https:' && !url.username && !url.password && !url.port && (google ? ['calendar.google.com', 'www.google.com'].includes(url.hostname) : ['outlook.live.com', 'outlook.office.com', 'outlook.office365.com'].includes(url.hostname))) eventUrl = url.href; } catch { /* A provider link is optional, not a success criterion. */ }
  return { eventId: result.id, eventUrl };
}
module.exports = { DEFINITIONS, configuration, providerDefinition, authorizationUrl, ProviderError, providerJson, normalizeTokens, redeem, refresh, identity, createCalendar, createEvent };

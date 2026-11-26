'use strict';

// Twilio boundary only. Consent, ownership, deduplication and budgets are enforced
// by the messaging service before invoking this adapter. Never retry a POST here.
const crypto = require('node:crypto');
const net = require('node:net');
const MAX_RESPONSE_BYTES = 65536;
const MAX_WEBHOOK_BYTES = 65536;
const MESSAGE_SID = /^(?:SM|MM)[0-9a-fA-F]{32}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const CONTENT_SID = /^HX[0-9a-fA-F]{32}$/;
const SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const DISPATCH_ID = /^[0-9a-f]{64}$/;
const OUTBOUND_STATUSES = new Set(['accepted', 'scheduled', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'canceled']);

class MessageProviderError extends Error {
  constructor(code = 'provider-unconfirmed', outcome = 'unknown', providerStatus = 0) {
    super(outcome === 'unknown' ? 'The message provider did not confirm this operation. Do not resend automatically.' : 'The message could not be sent.');
    this.name = 'MessageProviderError';
    this.code = code;
    this.outcome = outcome;
    this.providerStatus = providerStatus;
  }
}
class MessageWebhookError extends Error {
  constructor() { super('Invalid messaging callback'); this.name = 'MessageWebhookError'; this.status = 403; }
}
function validOrigin(value) {
  try {
    if (typeof value !== 'string' || value !== value.trim() || value.length > 2048) return null;
    const url = new URL(value), host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || net.isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
    return url.origin;
  } catch { return null; }
}
function address(value, channel) {
  if (typeof value !== 'string') return null;
  const phone = channel === 'whatsapp' ? value.replace(/^whatsapp:/, '') : value;
  if (!PHONE.test(phone)) return null;
  return channel === 'whatsapp' ? `whatsapp:${phone}` : phone;
}
function configuration(env = process.env) {
  const missing = [], origin = validOrigin(env.APP_ORIGIN);
  const accountSid = typeof env.TWILIO_ACCOUNT_SID === 'string' && ACCOUNT_SID.test(env.TWILIO_ACCOUNT_SID) ? env.TWILIO_ACCOUNT_SID : null;
  const authToken = typeof env.TWILIO_AUTH_TOKEN === 'string' && /^[0-9a-fA-F]{32}$/.test(env.TWILIO_AUTH_TOKEN) ? env.TWILIO_AUTH_TOKEN : null;
  if (!origin) missing.push('APP_ORIGIN');
  if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
  const smsFrom = address(env.TWILIO_SMS_FROM, 'sms');
  const whatsappFrom = address(env.TWILIO_WHATSAPP_FROM, 'whatsapp');
  const whatsappContentSid = typeof env.TWILIO_WHATSAPP_CONTENT_SID === 'string' && CONTENT_SID.test(env.TWILIO_WHATSAPP_CONTENT_SID) ? env.TWILIO_WHATSAPP_CONTENT_SID : null;
  const messagingServiceSid = typeof env.TWILIO_MESSAGING_SERVICE_SID === 'string' && SERVICE_SID.test(env.TWILIO_MESSAGING_SERVICE_SID) ? env.TWILIO_MESSAGING_SERVICE_SID : null;
  if (env.TWILIO_MESSAGING_SERVICE_SID && !messagingServiceSid) missing.push('TWILIO_MESSAGING_SERVICE_SID');
  const enabled = env.MESSAGING_ENABLED === 'true', sandboxEnabled = env.MESSAGING_WHATSAPP_SANDBOX === 'true';
  const configured = missing.length === 0;
  const smsMissing = [...missing, ...(!smsFrom ? ['TWILIO_SMS_FROM'] : [])];
  const whatsappMissing = [...missing, ...(!whatsappFrom ? ['TWILIO_WHATSAPP_FROM'] : []), ...(!whatsappContentSid ? ['TWILIO_WHATSAPP_CONTENT_SID'] : [])];
  return {
    enabled, configured, missing, origin, accountSid, authToken, smsFrom, whatsappFrom, whatsappContentSid, messagingServiceSid, sandboxEnabled,
    statusCallbackUrl: origin ? `${origin}/api/messaging-webhook/status` : null,
    inboundCallbackUrl: origin ? `${origin}/api/messaging-webhook/inbound` : null,
    channels: {
      sms: { configured: smsMissing.length === 0, ready: enabled && smsMissing.length === 0, missing: smsMissing },
      whatsapp: { configured: whatsappMissing.length === 0, ready: enabled && whatsappMissing.length === 0, sandboxReady: enabled && configured && Boolean(whatsappFrom) && sandboxEnabled, missing: whatsappMissing }
    }
  };
}
function publicConfiguration(env = process.env) {
  const config = configuration(env);
  return { enabled: config.enabled, configured: config.configured, provider: 'Twilio', sandboxEnabled: config.sandboxEnabled, channels: config.channels };
}
function callbackUrl(config, kind, dispatchId) {
  if (!['inbound', 'status'].includes(kind) || !config.origin || validOrigin(config.origin) !== config.origin) throw new MessageWebhookError();
  const base = `${config.origin}/api/messaging-webhook/${kind}`;
  if (dispatchId === undefined || dispatchId === null || dispatchId === '') return base;
  if (kind !== 'status' || typeof dispatchId !== 'string' || !DISPATCH_ID.test(dispatchId)) throw new MessageWebhookError();
  return `${base}?dispatch=${dispatchId}`;
}
function templateVariables(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new MessageProviderError('invalid-template-variables', 'not-sent');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 10 || entries.some(([key, item]) => !/^[1-9][0-9]?$/.test(key) || typeof item !== 'string' || !item.trim() || item.length > 800 || /[\u0000-\u001f\u007f]/.test(item))) throw new MessageProviderError('invalid-template-variables', 'not-sent');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 4096) throw new MessageProviderError('invalid-template-variables', 'not-sent');
  return encoded;
}
async function readJson(response) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) throw new MessageProviderError();
  const reader = response.body?.getReader();
  let text;
  if (reader) {
    const chunks = []; let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new MessageProviderError(); }
      chunks.push(Buffer.from(value));
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new MessageProviderError();
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MessageProviderError();
  return value;
}
async function sendMessage(fetchImpl, config, message) {
  if (config?.enabled !== true) throw new MessageProviderError('messaging-disabled', 'not-sent');
  if (!config.configured || !ACCOUNT_SID.test(config.accountSid || '') || !/^[0-9a-fA-F]{32}$/.test(config.authToken || '') || validOrigin(config.origin) !== config.origin) throw new MessageProviderError('messaging-unconfigured', 'not-sent');
  if (!message || !['sms', 'whatsapp'].includes(message.channel) || !['daily-brief', 'verification', 'test'].includes(message.purpose)) throw new MessageProviderError('invalid-message', 'not-sent');
  const channel = message.channel, to = address(message.to, channel), from = address(channel === 'sms' ? config.smsFrom : config.whatsappFrom, channel);
  if (!to || !from || to === from) throw new MessageProviderError('invalid-address', 'not-sent');
  let statusCallback;
  try { statusCallback = callbackUrl(config, 'status', message.dispatchId); } catch { throw new MessageProviderError('invalid-dispatch', 'not-sent'); }
  const form = new URLSearchParams({ To: to, From: from, StatusCallback: statusCallback });
  if (config.messagingServiceSid) {
    if (!SERVICE_SID.test(config.messagingServiceSid)) throw new MessageProviderError('messaging-unconfigured', 'not-sent');
    form.set('MessagingServiceSid', config.messagingServiceSid);
  }
  if (channel === 'whatsapp' && CONTENT_SID.test(config.whatsappContentSid || '')) {
    form.set('ContentSid', config.whatsappContentSid);
    form.set('ContentVariables', templateVariables(message.templateVariables));
  } else {
    if (channel === 'whatsapp') {
      const now = message.now ?? Date.now(), inbound = message.lastVerifiedInboundAt;
      // This timestamp must come from the persisted, signature-verified inbound
      // webhook, never from a browser's claim that it has opened a chat window.
      if (message.purpose !== 'test' || config.sandboxEnabled !== true || !Number.isFinite(now) || !Number.isFinite(inbound) || inbound > now || now - inbound >= 24 * 60 * 60 * 1000) throw new MessageProviderError('whatsapp-template-required', 'not-sent');
    }
    if (typeof message.body !== 'string' || !message.body.trim() || message.body.length > 1600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message.body)) throw new MessageProviderError('invalid-body', 'not-sent');
    form.set('Body', message.body);
  }
  if (typeof fetchImpl !== 'function') throw new MessageProviderError('messaging-unconfigured', 'not-sent');
  try {
    const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString()
    });
    if (!response.ok) throw new MessageProviderError('provider-rejected', response.status >= 400 && response.status < 500 && response.status !== 408 ? 'rejected' : 'unknown', response.status);
    const result = await readJson(response);
    if (response.status !== 201 || !MESSAGE_SID.test(result.sid || '') || result.account_sid !== config.accountSid || result.to !== to || result.from !== from || !OUTBOUND_STATUSES.has(result.status)) throw new MessageProviderError();
    // API acceptance is not a delivery receipt. Delivery comes from a verified
    // callback tied to this SID and the pre-persisted dispatch identifier.
    return { messageSid: result.sid, status: result.status, accepted: true, delivered: false };
  } catch (error) {
    if (error instanceof MessageProviderError) throw error;
    throw new MessageProviderError();
  }
}
function parseForm(rawBody, contentType) {
  if (typeof contentType !== 'string' || !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=(?:utf-8|UTF-8))?\s*$/i.test(contentType) || !(typeof rawBody === 'string' || Buffer.isBuffer(rawBody)) || Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) throw new MessageWebhookError();
  let text;
  try { text = Buffer.isBuffer(rawBody) ? new TextDecoder('utf-8', { fatal: true }).decode(rawBody) : rawBody; } catch { throw new MessageWebhookError(); }
  const parts = text.split('&'), result = Object.create(null);
  if (!text || parts.length > 128) throw new MessageWebhookError();
  try {
    for (const part of parts) {
      const separator = part.indexOf('=');
      if (separator < 1) throw new MessageWebhookError();
      const key = decodeURIComponent(part.slice(0, separator).replace(/\+/g, ' '));
      const value = decodeURIComponent(part.slice(separator + 1).replace(/\+/g, ' '));
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key) || Object.hasOwn(result, key) || Buffer.byteLength(value) > 8192) throw new MessageWebhookError();
      result[key] = value;
    }
  } catch { throw new MessageWebhookError(); }
  return result;
}
function validateWebhookIdentity(params, config, options = {}) {
  const kind = options.kind;
  if (!params || !['status', 'inbound'].includes(kind) || params.AccountSid !== config.accountSid || !ACCOUNT_SID.test(params.AccountSid || '') || !MESSAGE_SID.test(params.MessageSid || '')) throw new MessageWebhookError();
  for (const alias of ['SmsSid', 'SmsMessageSid']) if (params[alias] && params[alias] !== params.MessageSid) throw new MessageWebhookError();
  const channel = typeof params.From === 'string' && params.From.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  const from = address(params.From, channel), to = address(params.To, channel), sender = channel === 'sms' ? config.smsFrom : config.whatsappFrom;
  // Require the actual wire addresses, not a normalization that could disguise
  // a missing channel prefix or allow another sender in the same account.
  if (!from || !to || from !== params.From || to !== params.To || (kind === 'status' ? from : to) !== sender) throw new MessageWebhookError();
  if (options.expectedFrom !== undefined && address(options.expectedFrom, channel) !== from || options.expectedTo !== undefined && address(options.expectedTo, channel) !== to || options.expectedMessageSid !== undefined && options.expectedMessageSid !== params.MessageSid) throw new MessageWebhookError();
  if (params.MessagingServiceSid && config.messagingServiceSid && params.MessagingServiceSid !== config.messagingServiceSid) throw new MessageWebhookError();
  const status = params.MessageStatus || params.SmsStatus || (kind === 'inbound' ? 'received' : null);
  if (kind === 'status' && (!OUTBOUND_STATUSES.has(status) || params.MessageStatus && params.SmsStatus && params.MessageStatus !== params.SmsStatus) || kind === 'inbound' && status !== 'received') throw new MessageWebhookError();
  if (params.ErrorCode && !/^[0-9]{1,8}$/.test(params.ErrorCode)) throw new MessageWebhookError();
  return { channel, from, to, phone: (kind === 'inbound' ? from : to).replace(/^whatsapp:/, ''), messageSid: params.MessageSid, status, delivered: status === 'delivered' || status === 'read', errorCode: params.ErrorCode || null, body: kind === 'inbound' ? params.Body || '' : undefined, optOutType: kind === 'inbound' ? params.OptOutType || null : undefined };
}
function signatureForForm(authToken, url, params) {
  const input = url + Object.keys(params).sort().map(key => key + params[key]).join('');
  return crypto.createHmac('sha1', authToken).update(input, 'utf8').digest();
}
function verifyWebhook(request, config) {
  if (!request || !config?.configured || typeof config.authToken !== 'string' || !/^[0-9a-fA-F]{32}$/.test(config.authToken)) throw new MessageWebhookError();
  const url = callbackUrl(config, request.kind, request.dispatchId);
  const params = parseForm(request.rawBody, request.contentType);
  // Sign every parameter, including future provider fields, in the documented
  // case-sensitive order: https://www.twilio.com/docs/usage/security
  const expected = signatureForForm(config.authToken, url, params);
  if (typeof request.signature !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(request.signature)) throw new MessageWebhookError();
  const supplied = Buffer.from(request.signature, 'base64');
  if (supplied.length !== expected.length || supplied.toString('base64') !== request.signature || !crypto.timingSafeEqual(expected, supplied)) throw new MessageWebhookError();
  validateWebhookIdentity(params, config, { kind: request.kind });
  return params;
}

module.exports = { configuration, publicConfiguration, sendMessage, verifyWebhook, validateWebhookIdentity, signatureForForm, parseForm, callbackUrl, MessageProviderError, MessageWebhookError };

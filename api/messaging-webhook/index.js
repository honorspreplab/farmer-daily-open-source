'use strict';

const provider = require('../shared/message-provider');
const { createMessagingService } = require('../shared/messaging');
const { header } = require('../shared/access');

function reject() { throw new provider.MessageWebhookError(); }
function callbackDispatch(req, kind) {
  if (!['status', 'inbound'].includes(kind)) reject();
  const expectedPath = `/api/messaging-webhook/${kind}`;
  let urlDispatch, hasUrl = false;
  if (req.url !== undefined && req.url !== null) {
    if (typeof req.url !== 'string' || req.url.length > 8192 || /[\\\u0000-\u0020\u007f#]/.test(req.url)) reject();
    // Inspect the raw path/query, not URLSearchParams' forgiving decoder. Neither
    // duplicate keys nor percent-encoded aliases may alter a signed callback URL.
    const match = /^(?:https?:\/\/[^/?#]+)?(\/[^?#]*)(?:\?([^#]*))?$/.exec(req.url);
    if (!match || match[1] !== expectedPath) reject();
    try {
      const parsed = new URL(req.url, 'https://request.invalid');
      if (parsed.username || parsed.password) reject();
    } catch { reject(); }
    if (kind === 'status') {
      if (!/^dispatch=[a-f0-9]{64}$/.test(match[2] || '')) reject();
      urlDispatch = match[2].slice('dispatch='.length);
    } else if (match[2] !== undefined) reject();
    hasUrl = true;
  }
  let queryDispatch;
  if (req.query !== undefined && req.query !== null) {
    if (typeof req.query !== 'object' || Array.isArray(req.query)) reject();
    const entries = req.query instanceof URLSearchParams ? [...req.query.entries()] : Object.entries(req.query);
    if (kind === 'status') {
      if (entries.length !== 1 || entries[0][0] !== 'dispatch' || typeof entries[0][1] !== 'string' || !/^[a-f0-9]{64}$/.test(entries[0][1])) reject();
      queryDispatch = entries[0][1];
      if (hasUrl && queryDispatch !== urlDispatch) reject();
    } else if (entries.length) reject();
  }
  const dispatchId = hasUrl ? urlDispatch : queryDispatch;
  if (kind === 'status' && !dispatchId) reject();
  return dispatchId;
}
function respond(context, status, body, contentType = 'application/json; charset=utf-8') {
  context.res = { status, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' }, ...(status === 204 ? {} : { body }) };
}
function createMessagingWebhookHandler({ env = process.env, service, getContainer, now, fetchImpl } = {}) {
  const messaging = service || createMessagingService({ env, getContainer, now, fetchImpl });
  return async function messagingWebhook(context, req) {
    if (req?.method !== 'POST') {
      respond(context, 405, { error: 'Use POST for messaging callbacks.' });
      context.res.headers.Allow = 'POST';
      return;
    }
    let params, dispatchId, kind;
    try {
      kind = req.params?.kind;
      dispatchId = callbackDispatch(req, kind);
      // Azure v3 supplies rawBody even when it parses the form into req.body.
      // Never rebuild a signed form from a parsed or coerced object.
      const rawBody = req.rawBody !== undefined && req.rawBody !== null ? req.rawBody : typeof req.body === 'string' ? req.body : undefined;
      params = provider.verifyWebhook({ kind, dispatchId, rawBody, contentType: header(req, 'content-type'), signature: header(req, 'x-twilio-signature') }, provider.configuration(env));
    } catch {
      respond(context, 403, { error: 'Invalid messaging callback.' });
      return;
    }
    try {
      if (kind === 'inbound') {
        await messaging.inbound(params);
        // Empty TwiML acknowledges STOP/verification without authorizing a reply.
        respond(context, 200, '<Response/>', 'application/xml; charset=utf-8');
      } else {
        await messaging.status(params, dispatchId);
        respond(context, 204);
      }
    } catch {
      // Do not log request bodies, signatures, phone numbers or storage errors.
      respond(context, 503, { error: 'Messaging service temporarily unavailable.' });
    }
  };
}

module.exports = createMessagingWebhookHandler();
module.exports.createMessagingWebhookHandler = createMessagingWebhookHandler;
module.exports.callbackDispatch = callbackDispatch;

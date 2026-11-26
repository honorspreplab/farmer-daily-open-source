'use strict';
const { timingSafeEqual } = require('node:crypto');
const { header, HttpError, respond, handleError } = require('../shared/access');
const { createMessagingService } = require('../shared/messaging');
function createMessagingDispatchHandler({ env = process.env, service = createMessagingService({ env }) } = {}) {
  return async (context, req) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const expected = env.MESSAGING_DISPATCH_KEY || '', supplied = header(req, 'x-farmer-messaging-key');
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(expected) || !/^[A-Za-z0-9_-]{43,128}$/.test(supplied) || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)) || header(req, 'origin') || header(req, 'sec-fetch-site')) throw new HttpError(403, 'Scheduler authorization required');
      if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type'))) throw new HttpError(415, 'Send JSON');
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'cursor') || Buffer.byteLength(JSON.stringify(body)) > 13000) throw new HttpError(400, 'Invalid schedule request');
      return respond(context, 200, await service.dispatch(body.cursor));
    } catch (error) { handleError(context, error); }
  };
}
module.exports = createMessagingDispatchHandler();
module.exports.createMessagingDispatchHandler = createMessagingDispatchHandler;

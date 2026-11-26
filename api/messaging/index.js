'use strict';
const { createAccess, HttpError, respond, handleError } = require('../shared/access');
const { getContainer: defaultContainer } = require('../shared/store');
const { createMessagingService } = require('../shared/messaging');
function createMessagingHandler({ getContainer = defaultContainer, now = Date.now, env = process.env, fetchImpl = globalThis.fetch, service = createMessagingService({ getContainer, now, env, fetchImpl }) } = {}) {
  const access = createAccess({ getContainer, now });
  return async (context, req) => {
    try {
      if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
      const { principal } = await access.requireAccess(req);
      if (req.method === 'POST') {
        const body = req.body;
        const allowed = { beginVerification: ['action', 'channel', 'phone', 'consent'], savePreferences: ['action', 'channel', 'dailyEnabled', 'briefTime', 'consent'], stop: ['action', 'channel'], sendBrief: ['action', 'channel', 'approved', 'approvalToken'] };
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(allowed, body.action) || Object.keys(body).some(key => !allowed[body.action].includes(key)) || Buffer.byteLength(JSON.stringify(body)) > 2000) throw new HttpError(400, 'Invalid messaging request');
        if (body.action === 'beginVerification') await service.beginVerification(principal.id, body.channel, body.phone, body.consent);
        if (body.action === 'savePreferences') await service.savePreferences(principal.id, body.channel, body.dailyEnabled, body.briefTime, body.consent);
        if (body.action === 'stop') await service.stop(principal.id, body.channel);
        if (body.action === 'sendBrief') {
          if (body.approved !== true) throw new HttpError(400, 'Confirm sending your brief to your verified number');
          if (typeof body.approvalToken !== 'string' || !/^\d{13}\.[a-f0-9]{64}$/.test(body.approvalToken)) throw new HttpError(409, 'Reload messaging status and approve the current brief again');
          await service.sendBrief(principal.id, body.channel, { approvalToken: body.approvalToken });
        }
      }
      return respond(context, 200, await service.view(principal.id, principal.isAdmin));
    } catch (error) { handleError(context, error); }
  };
}
module.exports = createMessagingHandler();
module.exports.createMessagingHandler = createMessagingHandler;

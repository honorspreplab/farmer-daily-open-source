const { randomUUID } = require('node:crypto');
const { getContainer: defaultContainer, readDocument, replaceDocument } = require('../shared/store');
const { createAccess, publicAccount, accountPlan, HttpError, dateKey, respond, handleError } = require('../shared/access');

function createAccountHandler({ getContainer = defaultContainer, now = Date.now } = {}) {
  const access = createAccess({ getContainer, now });
  function result(context, account, isAdmin) {
    const user = publicAccount(account, isAdmin);
    respond(context, 200, {
      user: { id: user.id, email: user.email, joinedAt: user.joinedAt, lastSeenAt: user.lastSeenAt },
      isAdmin, plan: user.plan, request: user.request, date: dateKey(now())
    });
  }
  return async function account(context, req) {
    try {
      if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
      let { account, isAdmin, principal } = await access.requireAccess(req, { touch: req.method === 'GET' });
      if (req.method === 'GET') return result(context, account, isAdmin);
      if (req.body?.action !== 'request-premium') throw new HttpError(400, 'Unknown account action');
      if (req.body.reason !== undefined && (typeof req.body.reason !== 'string' || req.body.reason.length > 1000)) {
        throw new HttpError(400, 'Request reason must be 1,000 characters or fewer');
      }
      const container = getContainer();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (accountPlan(account, isAdmin) === 'premium' || account.request?.status === 'pending') return result(context, account, isAdmin);
        const timestamp = new Date(now()).toISOString();
        const updated = {
          ...account, lastSeenAt: timestamp,
          request: { id: randomUUID(), status: 'pending', reason: (req.body.reason || '').trim(), requestedAt: timestamp, decidedAt: null, decidedBy: null }
        };
        try { return result(context, (await replaceDocument(container, updated)).resource || updated, isAdmin); }
        catch (error) {
          if (Number(error.code) !== 412) throw error;
          account = await readDocument(container, account.id, principal.id);
          if (!account) throw new HttpError(409, 'Account changed. Please reload.');
        }
      }
      throw new HttpError(409, 'Request changed. Please reload.');
    } catch (error) { handleError(context, error); }
  };
}

module.exports = createAccountHandler();
module.exports.createAccountHandler = createAccountHandler;

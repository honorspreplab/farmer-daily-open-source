const { getContainer: defaultContainer, readDocument, replaceDocument } = require('../shared/store');
const { createAccess, publicAccount, isAdminIdentity, HttpError, respond, handleError } = require('../shared/access');

function createAdminHandler({ getContainer = defaultContainer, now = Date.now } = {}) {
  const access = createAccess({ getContainer, now });
  return async function management(context, req) {
    try {
      if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
      const { principal } = await access.requireAccess(req, { admin: true });
      const container = getContainer();
      if (req.method === 'GET') {
        let continuationToken;
        if (req.query?.cursor) {
          if (typeof req.query.cursor !== 'string' || req.query.cursor.length > 16000 || !/^[A-Za-z0-9_-]+$/.test(req.query.cursor)) throw new HttpError(400, 'Invalid page cursor');
          continuationToken = Buffer.from(req.query.cursor, 'base64url').toString('utf8');
        }
        // Projection is intentional: administrators never receive private farm state.
        const page = await container.items.query({
          query: 'SELECT c.userId, c.email, c.identityProvider, c.joinedAt, c.lastSeenAt, c.plan, c.request FROM c WHERE c.type = @type ORDER BY c.joinedAt DESC',
          parameters: [{ name: '@type', value: 'account' }]
        }, { maxItemCount: 50, continuationToken }).fetchNext();
        return respond(context, 200, {
          users: (page.resources || []).map(account => publicAccount(account)),
          cursor: page.continuationToken ? Buffer.from(page.continuationToken).toString('base64url') : null
        });
      }
      const { action, userId, requestId } = req.body || {};
      if (!['approve', 'decline'].includes(action) || typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId) ||
          typeof requestId !== 'string' || requestId.length > 100) throw new HttpError(400, 'Invalid decision');
      const target = await readDocument(container, `account-${userId}`, userId);
      if (!target) throw new HttpError(404, 'Account not found');
      if (isAdminIdentity(target.email, target.identityProvider)) throw new HttpError(409, 'Administrators already have Premium access');
      if (target.request?.id !== requestId || target.request?.status !== 'pending') throw new HttpError(409, 'This request has already changed. Reload the admin page.');
      const request = {
        ...target.request, status: action === 'approve' ? 'approved' : 'declined',
        decidedAt: new Date(now()).toISOString(), decidedBy: principal.email
      };
      const updated = {
        ...target, request, plan: action === 'approve' ? 'premium' : 'free',
        // Decision + audit are one conditional document write, so neither can be lost independently.
        requestHistory: [...(Array.isArray(target.requestHistory) ? target.requestHistory : []), {
          ...request, decidedByUserId: principal.id
        }].slice(-100)
      };
      try {
        const saved = (await replaceDocument(container, updated)).resource || updated;
        return respond(context, 200, { user: publicAccount(saved) });
      } catch (error) {
        if (Number(error.code) === 412) throw new HttpError(409, 'This request has already changed. Reload the admin page.');
        throw error;
      }
    } catch (error) { handleError(context, error); }
  };
}

module.exports = createAdminHandler();
module.exports.createAdminHandler = createAdminHandler;

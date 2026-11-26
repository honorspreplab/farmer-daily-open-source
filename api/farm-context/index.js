const { getContainer: defaultContainer, readDocument } = require('../shared/store');
const { createAccess, HttpError, respond, handleError } = require('../shared/access');
const { createFarmContextService } = require('../shared/farm-context');

function createFarmContextHandler({ getContainer = defaultContainer, now = Date.now, farmContextService = createFarmContextService({ getContainer, now }) } = {}) {
  const access = createAccess({ getContainer, now });
  return async function farmContext(context, req) {
    try {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const { principal } = await access.requireAccess(req);
      const fieldId = req.query?.fieldId;
      if (typeof fieldId !== 'string' || !fieldId.trim() || fieldId.length > 100) throw new HttpError(400, 'Choose a saved field');
      const saved = await readDocument(getContainer(), `state-${principal.id}`, principal.id);
      const field = saved?.state?.fields?.find(item => item.id === fieldId);
      if (!field) throw new HttpError(404, 'Field not found');
      if (field.contextConsent !== true) throw new HttpError(409, 'Enable Farm Context sharing for this field first.');
      const result = await farmContextService.getFarmContext({ userId: principal.id, field, refresh: req.query?.refresh === '1' });
      const latest = await readDocument(getContainer(), `state-${principal.id}`, principal.id);
      if (JSON.stringify(latest?.state?.fields?.find(item => item.id === fieldId)) !== JSON.stringify(field)) throw new HttpError(409, 'This field changed. Reload before requesting farm context.');
      return respond(context, 200, result);
    } catch (error) { handleError(context, error); }
  };
}
module.exports = createFarmContextHandler();
module.exports.createFarmContextHandler = createFarmContextHandler;

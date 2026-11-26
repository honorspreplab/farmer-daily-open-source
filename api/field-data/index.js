const { getContainer: defaultContainer, readDocument } = require('../shared/store');
const { createAccess, HttpError, respond, handleError } = require('../shared/access');
const { createFieldDataService } = require('../shared/field-data');

function createFieldDataHandler({ getContainer = defaultContainer, now = Date.now, fieldDataService = createFieldDataService({ getContainer, now }) } = {}) {
  const access = createAccess({ getContainer, now });
  return async function fieldData(context, req) {
    try {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const { principal } = await access.requireAccess(req);
      const fieldId = req.query?.fieldId;
      if (typeof fieldId !== 'string' || !fieldId.trim() || fieldId.length > 100) throw new HttpError(400, 'Choose a saved field');
      const saved = await readDocument(getContainer(), `state-${principal.id}`, principal.id);
      const field = saved?.state?.fields?.find(item => item.id === fieldId);
      if (!field) throw new HttpError(404, 'Field not found');
      const result = await fieldDataService.getFieldData({ userId: principal.id, field, refresh: req.query?.refresh === '1' });
      const latest = await readDocument(getContainer(), `state-${principal.id}`, principal.id);
      if (JSON.stringify(latest?.state?.fields?.find(item => item.id === fieldId)) !== JSON.stringify(field)) throw new HttpError(409, 'This field changed. Reload before requesting field data.');
      return respond(context, 200, result);
    } catch (error) { handleError(context, error); }
  };
}
module.exports = createFieldDataHandler();
module.exports.createFieldDataHandler = createFieldDataHandler;

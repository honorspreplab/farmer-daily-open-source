const { getContainer: defaultContainer, readDocument } = require('../shared/store');
const { createAccess, HttpError, header, respond, handleError } = require('../shared/access');
const { MAX_OPERATIONS_BYTES, PHASE_FOUR_ACTIONS, WORKFLOW_ACTIONS, operationsId, checkedDocument, publicOperations, assertOperationsSize, addEvent, applyOperation, batchError } = require('../shared/farm-operations');

function createFarmOperationsHandler({ getContainer = defaultContainer, now = Date.now, applyWorkflow } = {}) {
  const access = createAccess({ getContainer, now });
  return async function farmOperations(context, req) {
    try {
      if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
      const { principal, account } = await access.requireAccess(req, { premium: true });
      if (header(req, 'x-farmer-account-id') !== principal.id) throw new HttpError(409, 'Confirm your account by reloading Farmer Daily before continuing.');
      const container = getContainer(), id = operationsId(principal.id);
      const saved = await readDocument(container, `state-${principal.id}`, principal.id);
      if (!saved?.state?.profile) throw new HttpError(409, 'Save your farm profile before using connected farm tools');
      const existing = checkedDocument(await readDocument(container, id, principal.id), principal.id);
      if (req.method === 'GET') return respond(context, 200, publicOperations(existing));
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['action', 'payload', 'revision'].includes(key)) || !Object.hasOwn(body, 'revision')) throw new HttpError(400, 'Send an operation, payload and saved revision');
      if (body.revision !== (existing?._etag || null)) throw new HttpError(409, 'Your farm operations changed. Reload before trying this change again.');
      if (!PHASE_FOUR_ACTIONS.has(body.action) && !WORKFLOW_ACTIONS.has(body.action)) throw new HttpError(400, 'Unsupported farm operation');
      const timestamp = now(), operations = publicOperations(existing).operations;
      const workflow = WORKFLOW_ACTIONS.has(body.action);
      const apply = workflow ? (applyWorkflow || require('../shared/farm-workflows').applyWorkflow) : applyOperation;
      const outcome = apply({ operations, state: structuredClone(saved.state), action: body.action, payload: body.payload, now: timestamp });
      if (workflow && outcome.result?.alreadyExecuted) return respond(context, 200, { ...publicOperations(existing), result: outcome.result, state: { ...saved.state, workflowRevision: saved.workflowRevision || 0 } });
      if (workflow) addEvent(outcome.operations, body.action, outcome.result, timestamp);
      assertOperationsSize(outcome.operations);
      const stateChanged = JSON.stringify(outcome.state) !== JSON.stringify(saved.state);
      const tasksChanged = JSON.stringify(outcome.state.tasks || []) !== JSON.stringify(saved.state.tasks || []);
      if (stateChanged && !workflow) throw new Error('Unexpected farm state mutation');
      if (stateChanged) {
        if (tasksChanged) require('../state').validateTasks(outcome.state.tasks);
        if (Buffer.byteLength(JSON.stringify(outcome.state), 'utf8') > 512 * 1024) throw new HttpError(413, 'Farm state is too large');
        outcome.state.updatedAt = new Date(timestamp).toISOString();
      }
      const nextState = stateChanged ? { ...saved, state: outcome.state } : saved;
      if (tasksChanged) nextState.workflowRevision = (Number.isSafeInteger(saved.workflowRevision) ? saved.workflowRevision : 0) + 1;
      const document = { id, userId: principal.id, type: 'farmOperations', schemaVersion: 1, operations: outcome.operations, updatedAt: new Date(timestamp).toISOString() };
      if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_OPERATIONS_BYTES) throw new HttpError(413, 'Farm operations storage is full. Remove old records before adding more.');
      try {
        const batch = await container.items.batch([
          // Guard owner farm edits/deletion, approval revocation and the form revision
          // together. A failed batch has no partial task, document or audit writes.
          { operationType: 'Replace', id: saved.id, resourceBody: nextState, ifMatch: saved._etag },
          { operationType: 'Replace', id: account.id, resourceBody: account, ifMatch: account._etag },
          existing ? { operationType: 'Replace', id, resourceBody: document, ifMatch: existing._etag } : { operationType: 'Create', resourceBody: document }
        ], principal.id);
        batchError(batch);
        const resultDocument = batch.result[2]?.resourceBody;
        // The Cosmos transactional response normally includes resource bodies.
        // Read only to obtain the authoritative ETag when it is omitted.
        const persisted = resultDocument?._etag ? checkedDocument(resultDocument, principal.id) : checkedDocument(await readDocument(container, id, principal.id), principal.id);
        if (!persisted) throw new HttpError(409, 'Your farm records changed. Reload before continuing.');
        return respond(context, 200, { ...publicOperations(persisted), result: outcome.result, ...(workflow ? { state: { ...nextState.state, workflowRevision: nextState.workflowRevision || 0 } } : {}) });
      } catch (error) {
        if ([404, 409, 412].includes(Number(error.code))) throw new HttpError(409, 'Your farm or access changed. Reload before trying this change again.');
        throw error;
      }
    } catch (error) { handleError(context, error); }
  };
}

module.exports = createFarmOperationsHandler();
module.exports.createFarmOperationsHandler = createFarmOperationsHandler;

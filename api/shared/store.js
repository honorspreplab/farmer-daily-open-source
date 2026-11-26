const { CosmosClient } = require('@azure/cosmos');

let cachedContainer;
function getContainer() {
  if (!cachedContainer) {
    const connectionString = process.env.COSMOS_CONNECTION_STRING;
    if (!connectionString) throw new Error('Cloud storage is not configured');
    cachedContainer = new CosmosClient(connectionString).database('farmer-daily').container('user-state');
  }
  return cachedContainer;
}

async function readDocument(container, id, userId) {
  try { return (await container.item(id, userId).read()).resource || null; }
  catch (error) { if (Number(error.code) === 404) return null; throw error; }
}

function replaceDocument(container, document) {
  if (!document._etag) throw new Error('Missing concurrency token');
  return container.item(document.id, document.userId).replace(document, {
    accessCondition: { type: 'IfMatch', condition: document._etag }
  });
}

module.exports = { getContainer, readDocument, replaceDocument };

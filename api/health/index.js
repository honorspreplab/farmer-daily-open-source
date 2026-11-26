const { version } = require('../package.json');

// Public liveness only: no identity, storage reads, configuration, or farm data.
// A successful static-site upload alone does not prove the API worker can start.
module.exports = async function health(context, req) {
  context.res = {
    status: req.method === 'GET' ? 200 : 405,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: req.method === 'GET' ? { status: 'ok', version } : { error: 'Method not allowed' }
  };
};

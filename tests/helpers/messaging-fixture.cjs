'use strict';
const { createMessagingService } = require('../../api/shared/messaging');
const { createMessagingHandler } = require('../../api/messaging');
const provider = require('../../api/shared/message-provider');
const { dateKey } = require('../../api/shared/access');
const clone = value => value === undefined ? undefined : structuredClone(value);
function fixture(options = {}) {
  const docs = new Map(); let revision = 0, timestamp = Date.parse('2026-10-22T14:00:00Z'), sid = 0;
  const key = (id, owner) => `${owner}/${id}`;
  const failure = code => Object.assign(new Error('Private storage detail'), { code });
  const env = { APP_ORIGIN: 'https://calm-desert-02e51f41e.1.azurestaticapps.net', MESSAGING_ENABLED: 'true', MESSAGING_DATA_KEY: Buffer.alloc(32, 7).toString('base64'), MESSAGING_DISPATCH_KEY: 'd'.repeat(64), MESSAGING_SCHEDULER_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'b'.repeat(32), TWILIO_SMS_FROM: '+12065550101', TWILIO_WHATSAPP_FROM: 'whatsapp:+12065550102', TWILIO_WHATSAPP_CONTENT_SID: 'HX' + 'c'.repeat(32), ...options.env };
  const f = { docs, key, env, calls: [], beforeBatch: null, beforeDelete: null, send: null, setTime: value => timestamp = value, now: () => timestamp };
  function save(doc) { const resource = { ...clone(doc), _etag: String(++revision) }; docs.set(key(doc.id, doc.userId), resource); return clone(resource); }
  const container = {
    item(id, owner) { return {
      async read() { const doc = docs.get(key(id, owner)); if (!doc) throw failure(404); return { resource: clone(doc) }; },
      async replace(doc, opts) { const old = docs.get(key(id, owner)); if (!old) throw failure(404); if (old._etag !== opts?.accessCondition?.condition) throw failure(412); return { resource: save(doc) }; },
      async delete(opts) { if (f.beforeDelete) await f.beforeDelete(id, owner); const doc = docs.get(key(id, owner)); if (!doc) throw failure(404); if (opts?.accessCondition && doc._etag !== opts.accessCondition.condition) throw failure(412); docs.delete(key(id, owner)); }
    }; },
    items: {
      async create(doc) { if (docs.has(key(doc.id, doc.userId))) throw failure(409); return { resource: save(doc) }; },
      async batch(operations, owner) {
        if (f.beforeBatch) await f.beforeBatch(operations, owner);
        for (let i = 0; i < operations.length; i++) {
          const op = operations[i], old = docs.get(key(op.id || op.resourceBody.id, owner));
          const code = op.operationType === 'Create' ? old ? 409 : 0 : !old ? 404 : old._etag !== op.ifMatch ? 412 : 0;
          if (code) return { code, result: operations.map((unused, j) => ({ statusCode: j === i ? code : 424 })) };
        }
        return { code: 200, result: operations.map(op => ({ statusCode: 200, resourceBody: save(op.resourceBody) })) };
      },
      query(spec, opts = {}) {
        function rows() {
          const p = Object.fromEntries((spec.parameters || []).map(x => [x.name, x.value]));
          let result = [...docs.values()].filter(d => (!p['@type'] || d.type === p['@type']) && (!p['@owner'] || d.userId === p['@owner']) && (!p['@userId'] || d.userId === p['@userId']) && (!opts.partitionKey || d.userId === opts.partitionKey));
          if (p['@hash']) { const channel = /channels\.(sms|whatsapp)/.exec(spec.query)[1]; result = result.filter(d => d.channels?.[channel]?.pending?.hash === p['@hash']); }
          if (p['@dispatch']) result = result.filter(d => d.dispatchId === p['@dispatch']);
          if (p['@operation'] !== undefined) result = result.filter(d => d.operation === p['@operation']);
          if (p['@targetGeneration'] !== undefined) result = result.filter(d => d.targetGeneration === p['@targetGeneration']);
          if (p['@channel'] !== undefined) result = result.filter(d => d.channel === p['@channel']);
          if (/scheduleEnabled = true/.test(spec.query)) result = result.filter(d => d.scheduleEnabled);
          if (p['@after'] !== undefined) result = result.filter(d => d.id > p['@after']);
          if (p['@from'] !== undefined && p['@through'] !== undefined) result = result.filter(d => ['sms', 'whatsapp'].some(channel => d.channels?.[channel]?.dailyEnabled && d.channels[channel].briefTime >= p['@from'] && d.channels[channel].briefTime <= p['@through']));
          if (/ORDER BY c\.id/i.test(spec.query)) result.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
          if (/TOP 1\b/i.test(spec.query)) result = result.slice(0, 1);
          if (/TOP 2/i.test(spec.query)) result = result.slice(0, 2);
          return clone(result);
        }
        return { async fetchAll() { return { resources: rows() }; }, async fetchNext() { const all = rows(), start = Number(opts.continuationToken || 0), size = opts.maxItemCount || 1; return { resources: all.slice(start, start + size), continuationToken: all.length > start + size ? String(start + size) : undefined }; } };
      }
    }
  };
  const transport = { ...provider, async sendMessage(fetch, config, message) { f.calls.push(clone(message)); if (f.send) return f.send(message); return { messageSid: 'SM' + String(++sid).padStart(32, '0'), status: 'queued', accepted: true, delivered: false }; } };
  function seed(owner = 'owner') {
    save({ id: `account-${owner}`, userId: owner, type: 'account', email: `${owner}@example.test`, identityProvider: 'aad', plan: 'free' });
    save({ id: `state-${owner}`, userId: owner, type: 'state', state: { profile: { farmName: 'Test Farm' }, fields: [], tasks: [] } });
    save({ id: `brief-${owner}-${dateKey(timestamp)}`, userId: owner, type: 'dailyBrief', date: dateKey(timestamp), brief: { date: dateKey(timestamp), createdAt: new Date(timestamp).toISOString(), summary: 'Test brief', advisories: [{ fieldName: 'Test block', title: 'Review conditions', whatChanged: 'Wind forecast changed to 8 mph.' }] } });
  }
  seed();
  const service = createMessagingService({ getContainer: () => container, env, now: () => timestamp, transport, briefHandler: { async forOwner(owner) { f.prepared = (f.prepared || 0) + 1; return docs.get(key(`brief-${owner}-${dateKey(timestamp)}`, owner))?.brief; } } });
  const handler = createMessagingHandler({ getContainer: () => container, env, now: () => timestamp, service });
  async function call(method = 'GET', body, owner = 'owner', extras = {}) {
    const context = { log: { error() {} } };
    const headers = { 'content-type': 'application/json', 'x-farmer-account-id': owner, 'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: owner, userDetails: `${owner}@example.test`, identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64'), ...extras.headers };
    await handler(context, { method, body, headers }); return context.res;
  }
  async function verify(channel = 'sms', phone = '+12065550111', owner = 'owner') {
    await service.beginVerification(owner, channel, phone, true);
    const view = await service.view(owner), command = view.channels.find(x => x.id === channel).verification.command;
    await service.inbound({ From: `${channel === 'whatsapp' ? 'whatsapp:' : ''}${phone}`, To: channel === 'sms' ? env.TWILIO_SMS_FROM : env.TWILIO_WHATSAPP_FROM, Body: command, AccountSid: env.TWILIO_ACCOUNT_SID, MessageSid: 'SM' + String(++sid).padStart(32, '0') });
    return command;
  }
  Object.assign(f, { container, save, seed, service, handler, call, verify, provider }); return f;
}
module.exports = { fixture };

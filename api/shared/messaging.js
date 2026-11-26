'use strict';
const crypto = require('node:crypto');
const { getContainer: defaultContainer, readDocument, replaceDocument } = require('./store');
const { HttpError, dateKey } = require('./access');
const provider = require('./message-provider');
const { batchError } = require('./farm-operations');
const CHANNELS = ['sms', 'whatsapp'];
const DIRECTORY = 'messaging-directory';
const CONSENT_VERSION = '2026-10-22';
const idFor = owner => `messaging-${owner}`;
const stamp = now => new Date(now).toISOString();
const validTime = time => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function minuteOfDay(now) { const p = Object.fromEntries(clock.formatToParts(now).map(x => [x.type, x.value])); return Number(p.hour) * 60 + Number(p.minute); }
function channelId(value) { if (!CHANNELS.includes(value)) throw new HttpError(400, 'Choose SMS or WhatsApp'); return value; }
function phoneNumber(value) { if (typeof value !== 'string' || !/^\+[1-9]\d{7,14}$/.test(value)) throw new HttpError(400, 'Enter your phone with a country code, for example +12065550123'); return value; }
function settingsKey(env) { const key = Buffer.from(env.MESSAGING_DATA_KEY || '', 'base64'); return key.length === 32 ? key : null; }
function seal(value, key, owner, channel) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`farmer-daily:messaging:v1:${owner}:${channel}`));
  return { iv: iv.toString('base64'), data: Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function unseal(value, key, owner, channel) {
  try {
    if (!key || typeof value?.data !== 'string' || value.data.length > 5000) throw new Error();
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    cipher.setAAD(Buffer.from(`farmer-daily:messaging:v1:${owner}:${channel}`)); cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
  } catch { throw new HttpError(409, 'Messaging verification has expired. Stop this channel and verify again.'); }
}
function recipientKey(key, channel, phone) { return crypto.createHmac('sha256', key).update(`${channel}:${phone}`).digest('hex'); }
function empty(owner) { return { id: idFor(owner), userId: owner, type: 'messagingSettings', channels: {}, scheduleEnabled: false, schemaVersion: 1 }; }
function checked(doc, owner) { if (doc && (doc.id !== idFor(owner) || doc.userId !== owner || doc.type !== 'messagingSettings' || !doc.channels)) throw new Error('Invalid messaging record'); return doc; }
function cleanText(value, limit) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit); }
function briefText(brief, origin, now) {
  if (!brief || brief.date !== dateKey(now) || !Number.isFinite(Date.parse(brief.createdAt)) || Date.parse(brief.createdAt) > now + 60000) return null;
  const priorities = (Array.isArray(brief.advisories) ? brief.advisories.slice(0, 3).map(a => cleanText(`${a.fieldName || 'Farm'}: ${a.whatChanged || a.title || a.summary || ''}`, 105)) : (brief.items || []).slice(0, 3).map(x => cleanText(x, 105))).filter(Boolean);
  const excerpt = cleanText(priorities.join(' | ') || brief.summary || 'Your brief is ready.', 330);
  return { date: brief.date, excerpt, text: `Farmer Daily ${brief.date}: ${excerpt} ${origin}/ Reply STOP to unsubscribe.` };
}
function publicDelivery(doc, now = Date.now()) { return { id: doc.id, channel: doc.channel, status: doc.status === 'sending' && now - Date.parse(doc.createdAt) > 120000 ? 'unknown' : doc.status, createdAt: doc.createdAt, updatedAt: doc.updatedAt, message: doc.message || '' }; }
async function write(container, owner, previous, value, guards = []) {
  const operations = guards.filter(Boolean).map(g => ({ operationType: 'Replace', id: g.id, resourceBody: g, ifMatch: g._etag }));
  operations.push(previous ? { operationType: 'Replace', id: previous.id, resourceBody: value, ifMatch: previous._etag } : { operationType: 'Create', resourceBody: value });
  try {
    const result = await container.items.batch(operations, owner); batchError(result);
    const stored = result.result.at(-1)?.resourceBody;
    return stored?._etag ? stored : await readDocument(container, value.id, owner);
  } catch (error) {
    if ([404, 409, 412].includes(Number(error.code))) throw new HttpError(409, 'Your messaging or farm settings changed. Refresh before trying again.');
    throw error;
  }
}
function createMessagingService({ getContainer = defaultContainer, env = process.env, now = Date.now, fetchImpl = globalThis.fetch, transport = provider, briefHandler } = {}) {
  const readSettings = owner => readDocument(getContainer(), idFor(owner), owner).then(doc => checked(doc, owner));
  function config() { return transport.configuration(env); }
  function sender(channel, cfg = config()) { return channel === 'sms' ? cfg.smsFrom : cfg.whatsappFrom?.replace(/^whatsapp:/, ''); }
  function ready(channel) { const cfg = config(); return Boolean(cfg.enabled && settingsKey(env) && (cfg.channels?.[channel]?.configured || channel === 'whatsapp' && cfg.channels?.whatsapp?.sandboxReady)); }
  function schedulerReady() { return env.MESSAGING_SCHEDULER_ENABLED === 'true' && /^[A-Za-z0-9_-]{43,128}$/.test(env.MESSAGING_DISPATCH_KEY || '') && config().enabled; }
  function approvalFor(owner, channel, item, brief, cfg, expiresAt) {
    const key = settingsKey(env);
    if (!key || !item?.verifiedAt || !item.secret || !brief?.brief || brief.deleted) return null;
    // An approval is for the reviewed brief and verified endpoint, not whatever
    // a different tab might save before this request reaches the server.
    const evidence = JSON.stringify(['farmer-daily:messaging:approval:v1', owner, channel,
      item.generation, item.recipientHash, brief.brief, cfg.origin, sender(channel, cfg),
      cfg.whatsappContentSid || null, cfg.sandboxEnabled, expiresAt]);
    return `${expiresAt}.${crypto.createHmac('sha256', key).update(evidence).digest('hex')}`;
  }
  function checkApproval(token, owner, channel, item, brief, cfg) {
    if (typeof token !== 'string' || !/^\d{13}\.[a-f0-9]{64}$/.test(token)) throw new HttpError(409, 'Reload messaging status and approve the current brief again');
    const expiresAt = Number(token.split('.')[0]), timestamp = now();
    const expected = approvalFor(owner, channel, item, brief, cfg, expiresAt);
    if (expiresAt <= timestamp || expiresAt > timestamp + 15 * 60000 || !expected || token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) throw new HttpError(409, 'The brief, recipient or approval changed. Reload status and review it again.');
  }
  async function guards(owner) {
    const [state, account] = await Promise.all([readDocument(getContainer(), `state-${owner}`, owner), readDocument(getContainer(), `account-${owner}`, owner)]);
    if (!state?.state?.profile || !account || account.identityProvider !== 'aad') throw new HttpError(409, 'Save your farm profile before using messaging');
    return [state, account];
  }
  async function view(owner, isAdmin = false) {
    const doc = await readSettings(owner), cfg = config(), key = settingsKey(env), timestamp = now();
    const [brief, deliveries] = await Promise.all([
      readDocument(getContainer(), `brief-${owner}-${dateKey(timestamp)}`, owner),
      Promise.all(CHANNELS.map(channel => readDocument(getContainer(), `message-${owner}-${channel}-${dateKey(timestamp)}`, owner)))
    ]);
    const preview = cfg.origin && brief && !brief.deleted ? briefText(brief.brief, cfg.origin, timestamp) : null;
    return {
      channels: CHANNELS.map(id => {
        const item = doc?.channels[id], pending = item?.pending;
        let verification = null;
        if (pending && Date.parse(pending.expiresAt) > timestamp && key) {
          try { verification = { command: `JOIN ${unseal(pending.secret, key, owner, id).code}`, expiresAt: pending.expiresAt, sender: sender(id) }; } catch { /* No secret material is returned on failure. */ }
        }
        return { id, configured: ready(id), mode: !ready(id) ? 'disabled' : id === 'whatsapp' && cfg.sandboxEnabled ? 'sandbox' : 'production', sender: sender(id) || null, verified: Boolean(item?.verifiedAt && item.secret), maskedPhone: item?.maskedPhone || null, dailyEnabled: Boolean(item?.dailyEnabled), briefTime: validTime(item?.briefTime) ? item.briefTime : '06:30', verification, status: item?.stoppedAt ? 'stopped' : item?.verifiedAt ? 'verified' : pending ? 'awaiting-verification' : 'not-connected', approvalToken: preview && ready(id) ? approvalFor(owner, id, item, brief, cfg, timestamp + 15 * 60000) : null };
      }),
      deliveries: deliveries.filter(Boolean).map(doc => publicDelivery(doc, timestamp)),
      preview,
      scheduler: { configured: schedulerReady(), approximate: true },
      ...(isAdmin ? { setupRequired: [...new Set([...(cfg.missing || []), ...(cfg.channels?.sms?.missing || []), ...(cfg.channels?.whatsapp?.missing || []), ...(!cfg.enabled ? ['MESSAGING_ENABLED'] : []), ...(!key ? ['MESSAGING_DATA_KEY'] : []), ...(!schedulerReady() ? ['External scheduler activation'] : [])])] } : {})
    };
  }
  async function beginVerification(owner, channel, phone, consent) {
    channelId(channel); phoneNumber(phone);
    if (consent !== true) throw new HttpError(400, 'Agree to verification and messaging privacy before continuing');
    if (!ready(channel)) throw new HttpError(503, 'Messaging provider setup is required. No verification message was sent.');
    const container = getContainer(), stateGuards = await guards(owner), previous = await readSettings(owner), next = structuredClone(previous || empty(owner));
    const count = next.verificationDate === dateKey(now()) ? next.verificationCount || 0 : 0;
    if (count >= 6) throw new HttpError(429, 'Verification limit reached. Try again tomorrow.');
    // A number change explicitly stops the previous subscription first.
    if (previous?.channels[channel]?.verifiedAt) throw new HttpError(409, 'Stop this channel before changing its verified number');
    const code = crypto.randomBytes(16).toString('hex'), generation = random(), key = settingsKey(env);
    next.verificationDate = dateKey(now()); next.verificationCount = count + 1;
    next.channels[channel] = { generation, maskedPhone: `•••• ${phone.slice(-4)}`, dailyEnabled: false, briefTime: previous?.channels[channel]?.briefTime || '06:30', consentAt: stamp(now()), consentVersion: CONSENT_VERSION, recipientHash: recipientKey(key, channel, phone), pending: { hash: hash(code), expiresAt: stamp(now() + 30 * 60000), secret: seal({ phone, code }, key, owner, channel) } };
    next.scheduleEnabled = CHANNELS.some(c => next.channels[c]?.dailyEnabled);
    await write(container, owner, previous, next, stateGuards);
  }
  async function savePreferences(owner, channel, dailyEnabled, briefTime, consent) {
    channelId(channel);
    if (typeof dailyEnabled !== 'boolean' || !validTime(briefTime)) throw new HttpError(400, 'Choose a valid daily delivery time');
    const current = await readSettings(owner), item = current?.channels[channel];
    if (!item?.verifiedAt || !item.secret) throw new HttpError(409, 'Verify your own phone number first');
    if (dailyEnabled && consent !== true) throw new HttpError(400, 'Agree to receive a daily brief before enabling delivery');
    const next = structuredClone(current); next.channels[channel] = { ...item, dailyEnabled, briefTime, generation: random(), consentAt: dailyEnabled ? stamp(now()) : item.consentAt, consentVersion: CONSENT_VERSION };
    next.scheduleEnabled = CHANNELS.some(c => next.channels[c]?.dailyEnabled);
    await write(getContainer(), owner, current, next, await guards(owner));
  }
  async function stop(owner, channel, expectedBindingGeneration) {
    channelId(channel);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readSettings(owner); if (!current?.channels[channel]) return;
      if (expectedBindingGeneration && current.channels[channel].bindingGeneration !== expectedBindingGeneration) return;
      const next = structuredClone(current), item = next.channels[channel];
      // Keep a non-reversible cleanup pointer until release succeeds. A storage
      // failure after the stop write must not strand an unreachable reservation.
      next.channels[channel] = { briefTime: item.briefTime || '06:30', dailyEnabled: false, stoppedAt: stamp(now()), generation: random(), recipientHash: item.recipientHash, bindingGeneration: item.bindingGeneration || item.generation };
      next.scheduleEnabled = CHANNELS.some(c => next.channels[c]?.dailyEnabled);
      try {
        const stopped = await write(getContainer(), owner, current, next);
        await releaseRecipient(getContainer(), owner, channel, item.recipientHash, item.bindingGeneration || item.generation);
        const clean = structuredClone(stopped);
        delete clean.channels[channel].recipientHash; delete clean.channels[channel].bindingGeneration;
        try { await write(getContainer(), owner, stopped, clean); } catch { /* A concurrent new verification wins; the cleanup pointer is otherwise harmless. */ }
        return;
      }
      catch (error) { if (error.status !== 409) throw error; }
    }
    throw new HttpError(409, 'Settings changed. Retry stopping delivery.');
  }
  async function queryOne(query, parameters) {
    const result = await getContainer().items.query({ query: query.replace(/^SELECT \*/, 'SELECT TOP 2 *'), parameters }, { maxItemCount: 2 }).fetchAll();
    if ((result.resources || []).length !== 1) return null;
    return result.resources[0];
  }
  async function inbound(params) {
    const channel = params.From?.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const phone = phoneNumber(params.From.replace(/^whatsapp:/, '')), key = settingsKey(env); if (!key) return;
    const recipientHash = recipientKey(key, channel, phone), text = String(params.Body || '').trim();
    const bindingId = `recipient-${channel}-${recipientHash}`;
    if (!/^(?:SM|MM)[0-9a-fA-F]{32}$/.test(params.MessageSid || '')) throw new HttpError(400, 'Invalid messaging receipt');
    const isStop = /^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout)$/i.test(text) || params.OptOutType === 'STOP';
    // START is not consent in this application. A fresh, expiring JOIN challenge
    // from the verified provider is required to resume after STOP.
    const code = /^JOIN ([a-f0-9]{32})$/i.exec(text)?.[1]?.toLowerCase();
    if (!isStop && !code) return;
    const container = getContainer(), receiptId = `inbound-${hash(params.MessageSid)}`;
    let receipt = await readDocument(container, receiptId, DIRECTORY);
    if (receipt?.status === 'completed') return;
    // A worker may have crashed after its claim but before applying STOP/JOIN.
    // Acknowledge only completed receipts; an active lease must remain retryable
    // rather than silently consuming the provider's last redelivery attempt.
    if (receipt?.status === 'processing' && receipt.leaseUntil > now()) throw new HttpError(503, 'Messaging receipt is still processing. Retry shortly.');
    if (!receipt) {
      let targetGeneration = null;
      if (isStop) {
        const binding = await readDocument(container, bindingId, DIRECTORY);
        const settings = binding && await readSettings(binding.owner);
        if (settings?.channels[channel]?.recipientHash === recipientHash && settings.channels[channel].bindingGeneration === binding.generation) targetGeneration = binding.generation;
      } else {
        const pending = await queryOne(`SELECT * FROM c WHERE c.type = @type AND c.channels.${channel}.pending.hash = @hash`, [{ name: '@type', value: 'messagingSettings' }, { name: '@hash', value: hash(code) }]);
        if (pending?.channels[channel]?.recipientHash === recipientHash) targetGeneration = pending.channels[channel].generation;
      }
      // Retain only an irreversible receipt ID and random generation. No phone,
      // message body, owner ID or challenge is retained in replay markers. A
      // delayed/replayed old STOP may never apply to a newly verified connection.
      receipt = { id: receiptId, userId: DIRECTORY, type: 'messagingInboundReceipt', operation: isStop ? 'stop' : 'join', channel, targetGeneration, status: 'processing', leaseUntil: now() + 120000 };
      try { receipt = (await container.items.create(receipt)).resource || await readDocument(container, receiptId, DIRECTORY); }
      catch (error) { if (Number(error.code) === 409) throw new HttpError(503, 'Messaging receipt changed. Retry shortly.'); throw error; }
    } else {
      try { receipt = (await replaceDocument(container, { ...receipt, status: 'processing', leaseUntil: now() + 120000 })).resource; }
      catch (error) { if (Number(error.code) === 412) throw new HttpError(503, 'Messaging receipt changed. Retry shortly.'); throw error; }
    }
    try {
      if (receipt.targetGeneration && receipt.channel === channel && receipt.operation === (isStop ? 'stop' : 'join')) {
        if (isStop) {
          const binding = await readDocument(container, bindingId, DIRECTORY);
          if (binding?.generation === receipt.targetGeneration) await stop(binding.owner, channel, receipt.targetGeneration);
        } else {
          const doc = await queryOne(`SELECT * FROM c WHERE c.type = @type AND c.channels.${channel}.pending.hash = @hash`, [{ name: '@type', value: 'messagingSettings' }, { name: '@hash', value: hash(code) }]);
          if (doc) {
            const current = checked(doc, doc.userId), item = current.channels[channel];
            if (item.generation === receipt.targetGeneration && Date.parse(item.pending.expiresAt) > now() && item.recipientHash === recipientHash && unseal(item.pending.secret, key, doc.userId, channel).phone === phone) {
              const stateGuards = await guards(doc.userId), binding = await readDocument(container, bindingId, DIRECTORY);
              if (!binding || binding.owner === doc.userId) {
                // Only the caller that reserves this generation may commit the
                // owner record. A parallel copy cannot commit while the first
                // request is rolling back an unsuccessful cross-partition claim.
                if (binding?.generation === item.generation) throw new HttpError(409, 'Verification is already in progress. Retry shortly.');
                const reserved = { id: bindingId, userId: DIRECTORY, type: 'messagingRecipient', owner: doc.userId, channel, generation: item.generation };
                let reservation;
                try { reservation = binding ? (await replaceDocument(container, { ...reserved, _etag: binding._etag })).resource : (await container.items.create(reserved)).resource; }
                catch (error) { if ([409, 412].includes(Number(error.code))) throw new HttpError(409, 'Verification changed. Retry shortly.'); throw error; }
                const next = structuredClone(current);
                next.channels[channel] = { ...item, bindingGeneration: item.generation, pending: undefined, verifiedAt: stamp(now()), lastInboundAt: stamp(now()), secret: seal({ phone }, key, doc.userId, channel) };
                try { await write(container, doc.userId, current, next, stateGuards); }
                catch (error) {
                  // A lost database response can follow a committed transaction.
                  // Preserve the binding if the verified owner write did commit.
                  const after = await readSettings(doc.userId);
                  if (!after?.channels[channel]?.verifiedAt || after.channels[channel].bindingGeneration !== item.generation) {
                    await releaseRecipient(container, doc.userId, channel, recipientHash, item.generation, reservation?._etag);
                    throw error;
                  }
                }
              }
            }
          }
        }
      }
      await replaceDocument(container, { ...receipt, status: 'completed', leaseUntil: 0 });
    } catch (error) {
      // Retry may finish the same operation only; never recapture the target from
      // newer consent after a partial write, process restart, or lost response.
      try { await replaceDocument(container, { ...receipt, status: 'pending', leaseUntil: 0 }); } catch { /* Existing replay guard remains. */ }
      throw error;
    }
  }
  async function budget() {
    const container = getContainer(), id = `budget-${dateKey(now())}`, configured = Number(env.MESSAGING_DAILY_LIMIT || 10);
    const limit = Number.isInteger(configured) && configured >= 1 ? Math.min(configured, 100) : 10;
    for (let tries = 0; tries < 5; tries++) {
      const previous = await readDocument(container, id, DIRECTORY);
      if ((previous?.count || 0) >= limit) throw new HttpError(429, 'The app messaging limit has been reached for today');
      const next = { ...(previous || {}), id, userId: DIRECTORY, type: 'messagingBudget', count: (previous?.count || 0) + 1 };
      try { if (previous) await replaceDocument(container, next); else await container.items.create(next); return; }
      catch (error) { if (![409, 412].includes(Number(error.code))) throw error; }
    }
    throw new HttpError(429, 'Messaging is busy. No new message was sent.');
  }
  async function requireNoStopReceipt(channel, bindingGeneration) {
    if (typeof bindingGeneration !== 'string' || !/^[a-f0-9]{64}$/.test(bindingGeneration)) throw new HttpError(409, 'Verify this number again before sending');
    // A durable STOP claim is already revocation, even if its worker crashed
    // before updating owner settings. Bound the existence check to one record;
    // multiple STOP receipts must never turn a positive match into a null result.
    const result = await getContainer().items.query({
      query: 'SELECT TOP 1 c.id FROM c WHERE c.type = @type AND c.operation = @operation AND c.targetGeneration = @targetGeneration AND c.channel = @channel',
      parameters: [{ name: '@type', value: 'messagingInboundReceipt' }, { name: '@operation', value: 'stop' }, { name: '@targetGeneration', value: bindingGeneration }, { name: '@channel', value: channel }]
    }, { partitionKey: DIRECTORY, maxItemCount: 1 }).fetchAll();
    if (!Array.isArray(result?.resources)) throw new HttpError(503, 'Messaging consent could not be confirmed. No message was submitted.');
    if (result.resources.length) throw new HttpError(409, 'A STOP request was received. Verify this channel again before sending.');
  }
  async function sendBrief(owner, channel, { scheduled = false, submitBefore = Infinity, approvalToken } = {}) {
    channelId(channel); if (!ready(channel)) throw new HttpError(503, 'Messaging provider setup is required. No message was sent.');
    const container = getContainer(), cfg = config(), date = dateKey(now()), id = `message-${owner}-${channel}-${date}`;
    if (await readDocument(container, id, owner)) throw new HttpError(409, 'Today’s delivery was already attempted. It will not be automatically resent.');
    let current = await readSettings(owner), item = current?.channels[channel];
    if (!item?.verifiedAt || !item.secret || scheduled && !item.dailyEnabled) throw new HttpError(409, 'Verify and enable your own number first');
    if (scheduled && channel === 'whatsapp' && cfg.sandboxEnabled) throw new HttpError(409, 'Sandbox WhatsApp is for manual tests, not recurring brief delivery');
    const generation = item.generation;
    if (scheduled) {
      const builder = briefHandler || (briefHandler = require('../brief').createBriefHandler({ getContainer, now, fetchImpl }));
      await builder.forOwner(owner);
    }
    const stateGuards = await guards(owner);
    const brief = await readDocument(container, `brief-${owner}-${date}`, owner);
    const preview = !brief?.deleted && briefText(brief?.brief, cfg.origin, now());
    if (!preview || dateKey(now()) !== date) throw new HttpError(409, 'Prepare today’s brief on Today before sending it');
    current = await readSettings(owner); item = current?.channels[channel];
    if (item?.generation !== generation || !item.secret || scheduled && !item.dailyEnabled) throw new HttpError(409, 'Delivery settings changed before sending');
    if (approvalToken !== undefined) checkApproval(approvalToken, owner, channel, item, brief, cfg);
    const phone = phoneNumber(unseal(item.secret, settingsKey(env), owner, channel).phone);
    const bindingId = `recipient-${channel}-${item.recipientHash}`;
    const binding = await readDocument(container, bindingId, DIRECTORY);
    if (!item.bindingGeneration || binding?.owner !== owner || binding.generation !== item.bindingGeneration) throw new HttpError(409, 'Verify this number again before sending');
    await requireNoStopReceipt(channel, item.bindingGeneration);
    if (Date.now() >= submitBefore) throw new HttpError(503, 'Brief preparation took too long. No message was submitted.');
    const dispatchId = random();
    let delivery = await write(container, owner, null, { id, userId: owner, type: 'messagingDelivery', channel, date, dispatchId, recipientHash: item.recipientHash, status: 'sending', createdAt: stamp(now()), updatedAt: stamp(now()) }, [...stateGuards, current, brief]);
    let submitted = false;
    try {
      await budget();
      const fresh = await readSettings(owner), freshGuards = await guards(owner);
      if (fresh?.channels[channel]?.generation !== generation || !fresh.channels[channel].secret || scheduled && !fresh.channels[channel].dailyEnabled) throw new HttpError(409, 'Delivery was stopped before sending');
      const freshBinding = await readDocument(container, bindingId, DIRECTORY);
      if (freshBinding?.owner !== owner || freshBinding.generation !== fresh.channels[channel].bindingGeneration) throw new HttpError(409, 'Recipient verification changed before sending');
      const freshBrief = await readDocument(container, brief.id, owner);
      if (!freshBrief || freshBrief.deleted || JSON.stringify(freshBrief.brief) !== JSON.stringify(brief.brief)) throw new HttpError(409, 'Your brief changed. No message was sent.');
      delivery = await write(container, owner, delivery, delivery, [...freshGuards, fresh, freshBrief]);
      await requireNoStopReceipt(channel, fresh.channels[channel].bindingGeneration);
      if (Date.now() >= submitBefore) throw new HttpError(503, 'The dispatch time limit was reached. No message was submitted.');
      submitted = true;
      const result = await transport.sendMessage(fetchImpl, cfg, { channel, to: phone, body: preview.text, purpose: channel === 'whatsapp' && cfg.sandboxEnabled ? 'test' : 'daily-brief', templateVariables: { '1': date, '2': preview.excerpt, '3': `${cfg.origin}/` }, lastVerifiedInboundAt: Date.parse(item.lastInboundAt), now: now(), dispatchId });
      // A signed status callback can arrive before the POST returns. Never
      // overwrite delivered/read/failed status with the earlier accepted state.
      const latest = await readDocument(container, id, owner);
      if (latest?.dispatchId === dispatchId && latest.status === 'sending') await write(container, owner, latest, { ...latest, messageSid: result.messageSid, status: 'accepted', updatedAt: stamp(now()), message: 'Provider accepted the request. Delivery is not yet confirmed.' });
      return;
    } catch (error) {
      const status = submitted && (!error.outcome || error.outcome === 'unknown') ? 'unknown' : 'failed';
      const latest = await readDocument(container, id, owner);
      if (latest?.dispatchId === dispatchId && latest.status === 'sending') {
        try { await write(container, owner, latest, { ...latest, status, updatedAt: stamp(now()), message: status === 'unknown' ? 'Provider outcome is uncertain. This attempt will not be retried automatically.' : 'No confirmed delivery. Review provider setup and delivery settings.' }); } catch { /* Deletion wins. */ }
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(status === 'unknown' ? 409 : 503, status === 'unknown' ? 'The provider result is uncertain. Check delivery status; this attempt will not be automatically retried.' : 'The provider could not accept this message. Check setup before the next daily attempt.');
    }
  }
  async function status(params, dispatchId) {
    const phone = phoneNumber(params.To.replace(/^whatsapp:/, '')), key = settingsKey(env);
    if (!key) return;
    const accepted = new Set(['accepted', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'undelivered']);
    const incoming = params.MessageStatus || params.SmsStatus;
    if (!accepted.has(incoming)) return;
    const order = { sending: 0, accepted: 1, queued: 1, unknown: 1, sent: 2, failed: 3, undelivered: 3, delivered: 4, read: 5 };
    for (let attempt = 0; attempt < 5; attempt++) {
      // Concurrent sent/delivered callbacks can read the same ETag. Re-read and
      // re-evaluate every identity/order guard so a lost race cannot discard a
      // final delivery receipt, revive deleted data, or regress a newer receipt.
      const delivery = await queryOne('SELECT * FROM c WHERE c.type = @type AND c.dispatchId = @dispatch', [{ name: '@type', value: 'messagingDelivery' }, { name: '@dispatch', value: dispatchId }]);
      if (!delivery) return;
      if (recipientKey(key, delivery.channel, phone) !== delivery.recipientHash || Boolean(params.To.startsWith('whatsapp:')) !== (delivery.channel === 'whatsapp') || delivery.messageSid && delivery.messageSid !== params.MessageSid) return;
      if ((order[incoming] || 0) < (order[delivery.status] || 0) || ['read', 'failed', 'undelivered'].includes(delivery.status)) return;
      try {
        await write(getContainer(), delivery.userId, delivery, { ...delivery, messageSid: params.MessageSid, status: incoming, updatedAt: stamp(now()), message: ['delivered', 'read'].includes(incoming) ? 'Provider confirmed delivery.' : ['failed', 'undelivered'].includes(incoming) ? 'Provider reported that delivery failed.' : 'Provider is processing this message.' });
        return;
      } catch (error) {
        if (error.status !== 409) throw error;
        if (attempt === 4) throw new HttpError(503, 'Messaging receipt could not be saved. Retry shortly.');
      }
    }
  }
  async function dispatch(cursor) {
    if (!schedulerReady()) throw new HttpError(503, 'Automatic messaging is not enabled');
    // A caller cursor is only a random revision of the server checkpoint; it can
    // neither name a farmer nor rewind/skew the stored scan position. An initial
    // request resumes the last checkpoint after runner page/time limits or a crash.
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^[a-f0-9]{64}$/.test(cursor))) throw new HttpError(400, 'Invalid schedule cursor');
    const container = getContainer(), checkpointId = 'messaging-schedule-checkpoint';
    const initial = () => ({ afterId: null, owner: null, index: 0 });
    const previous = await readDocument(container, checkpointId, DIRECTORY);
    if (previous && (previous.type !== 'messagingScheduleCheckpoint' || !/^[a-f0-9]{64}$/.test(previous.cursor || '') || !previous.position ||
      !(previous.position.afterId === null || /^messaging-[A-Za-z0-9_-]{1,128}$/.test(previous.position.afterId)) ||
      !(previous.position.owner === null && previous.position.index === 0 || /^[A-Za-z0-9_-]{1,128}$/.test(previous.position.owner || '') && previous.position.index === 1))) throw new HttpError(503, 'The messaging schedule checkpoint needs administrator review');
    if (cursor !== undefined && cursor !== previous?.cursor) throw new HttpError(409, 'The messaging schedule advanced. A fresh scheduled run will resume its saved position.');
    if (previous?.leaseUntil > now()) throw new HttpError(409, 'Another messaging dispatch is still in progress');
    let checkpoint = { ...(previous || {}), id: checkpointId, userId: DIRECTORY, type: 'messagingScheduleCheckpoint', schemaVersion: 1,
      date: dateKey(now()), position: previous?.date === dateKey(now()) ? previous.position : initial(), cursor: previous?.cursor || random(), lease: random(), leaseUntil: now() + 90000 };
    try { checkpoint = (previous ? await replaceDocument(container, checkpoint) : await container.items.create(checkpoint)).resource; }
    catch (error) { if ([409, 412].includes(Number(error.code))) throw new HttpError(409, 'Another messaging dispatch advanced the schedule'); throw error; }
    if (!checkpoint?._etag) throw new HttpError(503, 'The messaging schedule checkpoint could not be confirmed');
    const counts = { processed: 0, accepted: 0, failed: 0, skipped: 0, nextCursor: null };
    const submitBefore = Date.now() + 25000;
    async function finish(position, complete = false) {
      const next = { ...checkpoint, position, cursor: random(), lease: null, leaseUntil: 0 };
      try { await replaceDocument(container, next); }
      catch (error) { if (Number(error.code) === 412) throw new HttpError(409, 'A newer dispatch owns the saved schedule position'); throw error; }
      return { ...counts, nextCursor: complete ? null : next.cursor };
    }
    try {
      const position = checkpoint.position;
      let owner = position.owner;
      if (!owner) {
        const currentMinute = minuteOfDay(now()), formatTime = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        // Keyset pagination, not a row offset or reused Cosmos page, remains stable
        // when a preceding farmer stops delivery or deletes their farm. TOP 1 is
        // bounded even when Cosmos returns an empty intermediate physical page.
        const page = await container.items.query({
          query: 'SELECT TOP 1 c.userId FROM c WHERE c.type = @type AND c.scheduleEnabled = true AND c.id > @after AND ((c.channels.sms.dailyEnabled = true AND c.channels.sms.briefTime >= @from AND c.channels.sms.briefTime <= @through) OR (c.channels.whatsapp.dailyEnabled = true AND c.channels.whatsapp.briefTime >= @from AND c.channels.whatsapp.briefTime <= @through)) ORDER BY c.id',
          parameters: [{ name: '@type', value: 'messagingSettings' }, { name: '@after', value: position.afterId || '' }, { name: '@from', value: formatTime(Math.max(0, currentMinute - 120)) }, { name: '@through', value: formatTime(currentMinute) }]
        }, { maxItemCount: 1 }).fetchAll();
        owner = page.resources?.[0]?.userId;
        if (!owner) return await finish(initial(), true);
      }
      if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new HttpError(503, 'Invalid scheduled account');
      const doc = await readSettings(owner); counts.processed++;
      for (let index = position.owner ? position.index : 0; index < CHANNELS.length; index++) {
        const channel = CHANNELS[index], item = doc?.channels[channel];
        if (!item?.dailyEnabled || !item.verifiedAt || !validTime(item.briefTime)) { counts.skipped++; continue; }
        const [hour, minute] = item.briefTime.split(':').map(Number), currentMinute = minuteOfDay(now());
        if (currentMinute < hour * 60 + minute || currentMinute > hour * 60 + minute + 120) { counts.skipped++; continue; }
        if (await readDocument(container, `message-${owner}-${channel}-${dateKey(now())}`, owner)) { counts.skipped++; continue; }
        try { await sendBrief(owner, channel, { scheduled: true, submitBefore }); counts.accepted++; }
        catch { counts.failed++; }
        // Persist the exact owner for channel two, even if they disappear from
        // the opt-in query before the next HTTP request. At most one POST per call.
        const second = doc?.channels.whatsapp;
        const secondMinute = validTime(second?.briefTime) ? Number(second.briefTime.slice(0, 2)) * 60 + Number(second.briefTime.slice(3)) : -1;
        const resumeSecond = index === 0 && second?.dailyEnabled && second.verifiedAt && secondMinute >= 0 && minuteOfDay(now()) >= secondMinute && minuteOfDay(now()) <= secondMinute + 120;
        return await finish(resumeSecond ? { afterId: position.afterId, owner, index: 1 } : { afterId: idFor(owner), owner: null, index: 0 });
      }
      return await finish({ afterId: idFor(owner), owner: null, index: 0 });
    } catch (error) {
      // Never overwrite a newer lease/checkpoint. An unknown write outcome can
      // retain this lease briefly; an expired lease can be recovered by a later
      // initial request. Delivery attempt markers still prevent duplicate sends.
      try { await replaceDocument(container, { ...checkpoint, lease: null, leaseUntil: 0 }); } catch { /* A committed/newer checkpoint wins. */ }
      throw error;
    }
  }
  return { view, beginVerification, savePreferences, stop, sendBrief, inbound, status, dispatch, schedulerReady };
}
async function releaseRecipient(container, owner, channel, recipientHash, generation, expectedEtag) {
  if (!recipientHash || !generation) return;
  const id = `recipient-${channel}-${recipientHash}`, binding = await readDocument(container, id, DIRECTORY);
  if (binding?.owner === owner && binding.generation === generation && (!expectedEtag || binding._etag === expectedEtag)) {
    try { await container.item(id, DIRECTORY).delete({ accessCondition: { type: 'IfMatch', condition: binding._etag } }); }
    catch (error) { if (![404, 412].includes(Number(error.code))) throw error; }
  }
}
async function pruneMessaging(container, owner) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = checked(await readDocument(container, idFor(owner), owner), owner);
    if (!doc) break;
    for (const channel of CHANNELS) await releaseRecipient(container, owner, channel, doc.channels[channel]?.recipientHash, doc.channels[channel]?.bindingGeneration || doc.channels[channel]?.generation);
    try { await container.item(doc.id, owner).delete({ accessCondition: { type: 'IfMatch', condition: doc._etag } }); break; }
    catch (error) { if (Number(error.code) === 404) break; if (Number(error.code) !== 412) throw error; if (attempt === 4) throw new HttpError(409, 'Messaging changed during deletion. Retry deleting your data.'); }
  }
  // Reclaim reservations left by an interrupted cross-partition verification or
  // an earlier partial deletion, including when no settings document remains.
  const bindings = await container.items.query({ query: 'SELECT * FROM c WHERE c.type = @type AND c.owner = @bindingOwner', parameters: [{ name: '@type', value: 'messagingRecipient' }, { name: '@bindingOwner', value: owner }] }, { partitionKey: DIRECTORY }).fetchAll();
  for (const binding of bindings.resources || []) {
    if (binding.owner !== owner) continue;
    try { await container.item(binding.id, DIRECTORY).delete({ accessCondition: { type: 'IfMatch', condition: binding._etag } }); }
    catch (error) { if (![404, 412].includes(Number(error.code))) throw error; }
  }
  // Continue on repeat deletion even when settings were removed by the first
  // attempt. Never leave recipient hashes/dispatch IDs behind after a mid-cleanup
  // failure or an ETag race with a delivery-status callback.
  const { resources } = await container.items.query({ query: 'SELECT * FROM c WHERE c.userId = @owner AND c.type = @type', parameters: [{ name: '@owner', value: owner }, { name: '@type', value: 'messagingDelivery' }] }, { partitionKey: owner }).fetchAll();
  for (const candidate of resources || []) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const delivery = await readDocument(container, candidate.id, owner);
      if (!delivery) break;
      try {
        await replaceDocument(container, { id: delivery.id, userId: owner, _etag: delivery._etag, type: 'messagingDelivery', channel: delivery.channel, date: delivery.date, status: 'cancelled', createdAt: delivery.createdAt, message: 'Farm data deleted; the daily attempt marker is retained to prevent duplicates.' });
        break;
      } catch (error) { if (Number(error.code) === 404) break; if (Number(error.code) !== 412) throw error; if (attempt === 4) throw new HttpError(409, 'Delivery records changed during deletion. Retry deleting your data.'); }
    }
  }
}
async function exportMessaging(container, owner) {
  const doc = checked(await readDocument(container, idFor(owner), owner), owner);
  if (!doc) return null;
  return { channels: CHANNELS.map(channel => { const item = doc.channels[channel] || {}; return { channel, maskedPhone: item.maskedPhone || null, verifiedAt: item.verifiedAt || null, dailyEnabled: Boolean(item.dailyEnabled), briefTime: item.briefTime || null, consentAt: item.consentAt || null, consentVersion: item.consentVersion || null, stoppedAt: item.stoppedAt || null }; }) };
}
module.exports = { createMessagingService, pruneMessaging, exportMessaging, phoneNumber, briefText, minuteOfDay, recipientKey, seal, unseal, idFor, CONSENT_VERSION };

'use strict';
const { getContainer: defaultContainer, readDocument } = require('../shared/store');
const { createAccess, HttpError, header, respond, handleError } = require('../shared/access');
const providers = require('../shared/calendar-providers');
const shared = require('../shared/calendar-connections');
const { FLOW_MS, idFor, hash, objectHash, random, encrypt, decrypt, checkedDocument, emptyDocument, publicProposal, publicView, writeDocument, validateBody, text, cookieValue, cookie, matchesHash, taskSnapshot, newProposal } = shared;
const SAFE_ACTIONS = new Set(['disconnect', 'cancel', 'deleteProposal']);

function createCalendarConnectionsHandler({ getContainer = defaultContainer, now = Date.now, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const access = createAccess({ getContainer, now });
  return async function calendarConnections(context, req) {
    let clearCookieFor;
    try {
      if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
      const action = req.body?.action;
      const identity = await access.requireAccess(req, { premium: req.method === 'POST' && !SAFE_ACTIONS.has(action) });
      const owner = identity.principal.id;
      if (header(req, 'x-farmer-account-id') !== owner) throw new HttpError(409, 'Confirm your account by reloading Farmer Daily before continuing.');
      const container = getContainer();
      const read = async () => checkedDocument(await readDocument(container, idFor(owner), owner), owner);
      const current = await read();
      const saved = await readDocument(container, `state-${owner}`, owner);
      if (req.method === 'GET') return respond(context, 200, publicView(current, { env, isAdmin: identity.isAdmin, canConnect: identity.plan === 'premium' && Boolean(saved?.state?.profile) }));
      const body = req.body;
      const allowed = { begin: ['action', 'provider', 'allowCalendarCreation'], complete: ['action', 'provider', 'code', 'state'], disconnect: ['action', 'provider'], prepare: ['action', 'provider', 'taskId'], execute: ['action', 'proposalId', 'approved'], cancel: ['action', 'proposalId'], deleteProposal: ['action', 'proposalId'] };
      if (typeof action !== 'string' || !Object.hasOwn(allowed, action)) throw new HttpError(400, 'Unsupported calendar action');
      validateBody(body, allowed[action]);
      if (!SAFE_ACTIONS.has(action) && !saved?.state?.profile) throw new HttpError(409, 'Save your farm profile before connecting a calendar.');
      let document = current ? structuredClone(current) : emptyDocument(owner);
      const stamp = () => new Date(now()).toISOString();
      async function write(previous, next, guards = { state: saved, account: identity.account }) {
        next.updatedAt = stamp();
        return writeDocument(container, owner, previous, next, guards);
      }
      async function freshGuards() {
        const account = await access.requireAccess(req, { premium: true });
        const state = await readDocument(container, `state-${owner}`, owner);
        if (!state?.state?.profile) throw new HttpError(409, 'Your farm was removed. No new calendar action can start.');
        return { account: account.account, state };
      }
      if (action === 'disconnect') {
        providers.providerDefinition(body.provider); clearCookieFor = body.provider;
        if (current) {
          delete document.connections[body.provider]; delete document.pending[body.provider];
          for (const proposal of document.proposals) if (proposal.provider === body.provider && proposal.status === 'pending') { proposal.status = 'cancelled'; proposal.cancelledAt = stamp(); }
          await write(current, document, { account: identity.account });
        }
        return respond(context, 200, { disconnected: true, provider: body.provider, message: 'Saved credentials removed. Existing calendar events remain. An action already sent may still finish. You can also remove consent in your provider account settings.' });
      }
      if (action === 'cancel' || action === 'deleteProposal') {
        const id = text(body.proposalId, 100, 'proposal ID'), proposal = document.proposals.find(item => item.id === id);
        if (!proposal) throw new HttpError(404, 'Calendar proposal not found');
        if (action === 'cancel') {
          if (!['pending', 'cancelled'].includes(proposal.status)) throw new HttpError(409, 'This calendar action can no longer be cancelled. Check your calendar; cancelling does not remove existing events.');
          proposal.status = 'cancelled'; proposal.cancelledAt ||= stamp();
          await write(current, document, { account: identity.account });
          return respond(context, 200, { proposal: publicProposal(proposal) });
        }
        if (!['executed', 'cancelled', 'failed'].includes(proposal.status)) throw new HttpError(409, 'Only confirmed completed, cancelled or failed records can be removed. Uncertain actions are kept to prevent accidental duplicate events.');
        document.proposals = document.proposals.filter(item => item.id !== id);
        await write(current, document, { account: identity.account });
        return respond(context, 200, { removed: true, message: 'Saved history removed. Existing events in your calendar were not changed.' });
      }
      let provider = body.provider;
      if (action === 'execute') {
        const id = text(body.proposalId, 100, 'proposal ID'), proposal = document.proposals.find(item => item.id === id);
        if (!proposal) throw new HttpError(404, 'Calendar proposal not found');
        provider = proposal.provider;
      }
      const config = providers.configuration(provider, env);
      if (!config.configured) throw new HttpError(503, 'This calendar provider is not configured yet. An administrator must complete its secure setup.');
      if (action === 'begin') {
        if (body.allowCalendarCreation !== true) throw new HttpError(400, 'Confirm that Farmer Daily may create its own calendar before connecting.');
        if (document.connections[provider]) throw new HttpError(409, 'Disconnect this calendar before connecting another account. Existing events will remain.');
        if (document.pending[provider] && !['awaiting', 'failed'].includes(document.pending[provider].status)) throw new HttpError(409, 'A previous connection may already have created a calendar. Check your provider calendar, then disconnect this attempt before starting another.');
        const state = random(), verifier = random(), browser = random();
        document.pending[provider] = { generation: random(), status: 'awaiting', createdAt: stamp(), expiresAt: now() + FLOW_MS, stateHash: hash(state), browserHash: hash(browser), verifier: encrypt({ verifier }, config.key, owner, provider), calendarCreationApproved: true };
        await write(current, document);
        respond(context, 200, { authorizationUrl: providers.authorizationUrl(config, state, Buffer.from(hash(verifier), 'hex').toString('base64url')) });
        context.res.headers['Set-Cookie'] = cookie(provider, browser);
        return;
      }
      if (action === 'complete') {
        clearCookieFor = provider;
        const code = text(body.code, 12000, 'authorization code'), state = text(body.state, 200, 'authorization state'), pending = document.pending[provider];
        if (!pending || pending.status !== 'awaiting' || pending.expiresAt <= now() || !matchesHash(state, pending.stateHash) || !matchesHash(cookieValue(req, provider), pending.browserHash) || !pending.calendarCreationApproved) throw new HttpError(409, 'This connection attempt expired, was already used or belongs to another browser. Start again from Connected farm.');
        const verifier = decrypt(pending.verifier, config.key, owner, provider).verifier;
        pending.status = 'redeeming'; delete pending.verifier; delete pending.stateHash; delete pending.browserHash;
        let claimed = await write(current, document);
        let tokens, label;
        try {
          tokens = await providers.redeem(fetchImpl, config, code, verifier, now());
          label = await providers.identity(fetchImpl, config, tokens);
        } catch {
          const next = structuredClone(claimed); next.pending[provider].status = 'failed';
          await write(claimed, next, await freshGuards());
          throw new HttpError(409, 'The provider did not complete secure authorization. Nothing was copied. Start the connection again and approve the calendar permissions.');
        }
        let next = structuredClone(claimed);
        next.pending[provider].status = 'creating';
        next.pending[provider].tokenSecret = encrypt(tokens, config.key, owner, provider);
        claimed = await write(claimed, next, await freshGuards());
        let calendar;
        try { calendar = await providers.createCalendar(fetchImpl, config, tokens); }
        catch {
          next = structuredClone(claimed); next.pending[provider].status = 'uncertain';
          await write(claimed, next, await freshGuards());
          throw new HttpError(409, 'The provider did not confirm whether your Farmer Daily calendar was created. Check your calendar first. We will not automatically create another one. Disconnect this attempt before reconnecting.');
        }
        next = structuredClone(claimed);
        next.connections[provider] = { generation: pending.generation, status: 'connected', providerAccountId: label.id, accountLabel: label.label, calendarId: calendar.id, calendarName: calendar.name, connectedAt: stamp(), secret: encrypt(tokens, config.key, owner, provider), needsReconnect: false };
        delete next.pending[provider];
        await write(claimed, next, await freshGuards());
        return respond(context, 200, { connected: true, provider });
      }
      const connection = document.connections[provider];
      if (!connection || connection.status !== 'connected' || connection.needsReconnect || !connection.secret) throw new HttpError(409, 'Connect this calendar before preparing or copying a task.');
      if (action === 'prepare') {
        const snapshot = taskSnapshot(saved.state, body.taskId, connection, now());
        const duplicate = document.proposals.find(item => item.provider === provider && item.generation === connection.generation && item.taskHash === objectHash(snapshot.task) && ['pending', 'sending', 'unknown', 'executed'].includes(item.status));
        if (duplicate) throw new HttpError(409, 'This unchanged task already has a calendar proposal or copy. Review its saved result before preparing another.');
        if (document.proposals.length >= 50) throw new HttpError(409, 'Calendar history is full. Remove a completed or cancelled record before preparing another.');
        const proposal = newProposal(provider, snapshot, connection, now()); document.proposals.push(proposal);
        await write(current, document);
        return respond(context, 200, { proposal: publicProposal(proposal) });
      }
      if (action === 'execute') {
        if (body.approved !== true) throw new HttpError(400, 'Review the exact calendar event and explicitly approve it before copying.');
        const proposal = document.proposals.find(item => item.id === body.proposalId);
        if (proposal.status === 'executed') return respond(context, 200, { proposal: publicProposal(proposal), result: { ...proposal.result, alreadyExecuted: true } });
        if (proposal.status !== 'pending') throw new HttpError(409, 'This calendar action is not pending. If its outcome is uncertain, check your calendar; it will not be sent again automatically.');
        if (Date.parse(proposal.expiresAt) <= now() || Date.parse(proposal.createdAt) > now() || proposal.generation !== connection.generation) throw new HttpError(409, 'This proposal expired or its calendar changed. Cancel it and review a new proposal.');
        const snapshot = taskSnapshot(saved.state, proposal.preview.taskId, connection, now());
        if (objectHash(snapshot.task) !== proposal.taskHash || objectHash(snapshot.preview) !== objectHash(proposal.preview)) throw new HttpError(409, 'This task changed. Cancel the old proposal, then review a new one.');
        if (document.proposals.some(item => item.provider === provider && item.status === 'sending')) throw new HttpError(409, 'Another calendar copy is still in progress. Reload its status before continuing.');
        proposal.status = 'sending'; proposal.startedAt = stamp();
        let claimed = await write(current, document), sent = false;
        try {
          let tokens = decrypt(connection.secret, config.key, owner, provider);
          if (tokens.expiresAt <= now() + 60000) {
            tokens = await providers.refresh(fetchImpl, config, tokens, now());
            const next = structuredClone(claimed); next.connections[provider].secret = encrypt(tokens, config.key, owner, provider);
            claimed = await write(claimed, next, await freshGuards());
          }
          const guards = await freshGuards();
          const currentTask = taskSnapshot(guards.state.state, proposal.preview.taskId, connection, now());
          if (objectHash(currentTask.task) !== proposal.taskHash) throw new HttpError(409, 'This task changed before copying. Review a new proposal.');
          // A final conditional claim catches disconnect/deletion, approval
          // revocation and task edits that occurred during token refresh.
          claimed = await write(claimed, structuredClone(claimed), guards);
          sent = true;
          const result = await providers.createEvent(fetchImpl, config, connection, tokens, proposal);
          const next = structuredClone(claimed), completed = next.proposals.find(item => item.id === proposal.id);
          completed.status = 'executed'; completed.executedAt = stamp();
          completed.result = { ...result, message: 'One task was copied to your Farmer Daily calendar. This is a one-time copy, not automatic synchronization. No invitations or emails were sent.' };
          await write(claimed, next, await freshGuards());
          return respond(context, 200, { proposal: publicProposal(completed), result: completed.result });
        } catch (error) {
          // Never resend after any event request or ambiguous storage result.
          // A concurrent disconnect/delete wins; conditional writes cannot revive it.
          const next = structuredClone(claimed), failed = next.proposals.find(item => item.id === proposal.id);
          failed.status = sent ? 'unknown' : 'failed';
          failed.message = sent ? 'The provider outcome could not be confirmed. Check your calendar before taking another action. This copy will not be automatically retried.' : 'The task was not sent. Reload your farm and calendar connection before preparing another proposal.';
          if (!sent && error instanceof providers.ProviderError) next.connections[provider].needsReconnect = true;
          try { await write(claimed, next, await freshGuards()); } catch { /* Deletion, disconnect and revocation take precedence. */ }
          if (sent) throw new HttpError(409, 'The calendar result is uncertain. Check your provider calendar. Farmer Daily will not automatically retry or create a duplicate.');
          if (error instanceof HttpError) throw error;
          throw new HttpError(409, 'The task was not sent. Reconnect the calendar if its authorization expired, then prepare a new proposal.');
        }
      }
      throw new HttpError(400, 'Unsupported calendar action');
    } catch (error) { handleError(context, error); }
    finally { if (clearCookieFor && context.res) context.res.headers['Set-Cookie'] = cookie(clearCookieFor); }
  };
}

module.exports = createCalendarConnectionsHandler();
module.exports.createCalendarConnectionsHandler = createCalendarConnectionsHandler;

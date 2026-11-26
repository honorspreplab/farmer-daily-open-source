'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdminIdentity, principalFrom, publicAccount, createAccess } = require('../api/shared/access');

function configured(value, callback) {
  const previous = process.env.ADMIN_EMAILS;
  if (value === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = value;
  try { return callback(); }
  finally {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  }
}

const email = 'admin1@example.invalid';
function request(identity = {}, extras = {}) {
  return {
    method: 'GET',
    headers: { 'x-ms-client-principal': Buffer.from(JSON.stringify({
      userId: 'synthetic-admin', userDetails: email, identityProvider: 'aad',
      userRoles: ['authenticated'], ...identity
    })).toString('base64') },
    ...extras
  };
}

test('no administrator is trusted without an explicitly configured server allowlist', () => {
  for (const value of [undefined, '', ' ', ',', '*', '*@example.invalid', 'not-an-email',
    `${email},`, `${email},not-an-email`, `${email};admin2@example.invalid`, 'x'.repeat(8193)]) {
    configured(value, () => {
      assert.equal(isAdminIdentity(email, 'aad'), false);
      assert.equal(principalFrom(request()).isAdmin, false);
      assert.equal(publicAccount({ email, identityProvider: 'aad', plan: 'free' }).isAdmin, false);
    });
  }
});

test('configured administrators use normalized, exact addresses and trusted provider identities', () => {
  configured(' ADMIN1@EXAMPLE.INVALID , admin2@example.invalid ', () => {
    assert.equal(isAdminIdentity(` ${email.toUpperCase()} `, 'aad'), true);
    assert.equal(isAdminIdentity('admin2@example.invalid', 'aad'), true);
    for (const value of ['admin3@example.invalid', `${email}.attacker.invalid`, 'someone@example.invalid', undefined]) {
      assert.equal(isAdminIdentity(value, 'aad'), false);
    }
    for (const provider of ['google', 'github', undefined]) assert.equal(isAdminIdentity(email, provider), false);
    assert.equal(principalFrom(request({ identityProvider: 'google' })), null);
    assert.equal(principalFrom(request({ userRoles: ['anonymous'] })), null);
    assert.equal(principalFrom(request()).isAdmin, true);
  });
});

test('body, query, profile, and role claims cannot replace server administrator configuration', () => {
  configured(email, () => {
    const principal = principalFrom(request({ userDetails: 'farmer@example.invalid', userRoles: ['authenticated', 'admin'] }, {
      body: { email, isAdmin: true, profile: { email } }, query: { email, isAdmin: 'true' }
    }));
    assert.equal(principal.isAdmin, false);
    assert.equal(principalFrom({ method: 'GET', headers: {}, body: { email, isAdmin: true } }), null);
  });
});

test('an unset administrator allowlist denies admin access before any data-store operation', async () => {
  let reads = 0;
  const access = createAccess({ getContainer: () => { reads += 1; throw new Error('Must not access storage'); } });
  // principalFrom and the admin guard run synchronously before requireAccess yields.
  const pending = configured(undefined, () => access.requireAccess(request(), { admin: true }));
  await assert.rejects(pending, error => error.status === 403);
  assert.equal(reads, 0);
});

'use strict';

// Test fixture only. Production code never imports this module or enables a test bypass.
// Replace any inherited allowlist so local tests cannot depend on real admin identities.
const adminEmails = Object.freeze([
  'admin1@example.invalid',
  'admin2@example.invalid',
  'admin3@example.invalid'
]);
process.env.ADMIN_EMAILS = adminEmails.join(',');
module.exports = adminEmails;

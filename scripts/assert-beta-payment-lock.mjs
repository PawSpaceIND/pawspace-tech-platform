import assert from 'node:assert/strict';

// Run in the same environment as beta validation and stabilization commits.
// This script verifies declarations; provider-boundary execution is covered by
// tests/payment-beta-lock-matrix.test.mjs.
const required = {
 PAWSPACE_PAYMENT_ENV: 'sandbox',
 FORBID_PRODUCTION: 'true',
 PAWSPACE_PAYMENT_LIVE_APPROVED: 'false',
};
for (const [key, expected] of Object.entries(required)) {
 console.log(`${key}=${process.env[key] ?? '<unset>'}`);
 assert.equal(process.env[key], expected, `Beta payment lock requires ${key}=${expected}`);
}
console.log('Beta payment declarations locked.');

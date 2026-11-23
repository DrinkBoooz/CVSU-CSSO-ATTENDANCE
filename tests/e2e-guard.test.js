'use strict';

const assert = require('assert');
const { validateE2EEnv, PRODUCTION_SHEET_ID } = require('./e2e/run-live-e2e');

function run() {
  assert.throws(() => validateE2EEnv({}), /CSSO_STAGING_SHEET_ID/i);
  assert.throws(() => validateE2EEnv({ CSSO_STAGING_SHEET_ID: 'staging-123' }), /CSSO_STAGING_API_URL/i);
  assert.throws(() => validateE2EEnv({
    CSSO_STAGING_SHEET_ID: PRODUCTION_SHEET_ID,
    CSSO_STAGING_API_URL: 'https://example.com/exec',
    CSSO_E2E_PIN: '762272',
    CSSO_E2E_TOK1: 'AAA',
    CSSO_E2E_TOK2: 'BBB'
  }), /refusing to run against production/i);

  const ok = validateE2EEnv({
    CSSO_STAGING_SHEET_ID: 'staging-sheet-id',
    CSSO_STAGING_API_URL: 'https://script.google.com/macros/s/staging/exec',
    CSSO_E2E_PIN: '762272',
    CSSO_E2E_TOK1: 'AAA',
    CSSO_E2E_TOK2: 'BBB'
  });
  assert.strictEqual(ok.sheetId, 'staging-sheet-id');

  console.log('PASS: e2e-guard.test.js');
}

run();

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');

const PRODUCTION_SHEET_ID = '16NSuhDLinZQf9fpkrZYBu2ZyPM7Fq3dhutPZ78iDuWA';

function validateE2EEnv(env) {
  const sheetId = String(env.CSSO_STAGING_SHEET_ID || '').trim();
  const apiUrl = String(env.CSSO_STAGING_API_URL || '').trim();
  const pin = String(env.CSSO_E2E_PIN || '').trim();
  const tok1 = String(env.CSSO_E2E_TOK1 || '').trim();
  const tok2 = String(env.CSSO_E2E_TOK2 || '').trim();

  if (!sheetId) {
    throw new Error('CSSO_STAGING_SHEET_ID is required. Production spreadsheet is never used by default.');
  }
  if (sheetId === PRODUCTION_SHEET_ID) {
    throw new Error('Refusing to run against production spreadsheet ID (' + PRODUCTION_SHEET_ID + '). Use a staging copy.');
  }
  if (!apiUrl) {
    throw new Error('CSSO_STAGING_API_URL is required.');
  }
  if (!pin || !tok1 || !tok2) {
    throw new Error('CSSO_E2E_PIN, CSSO_E2E_TOK1, and CSSO_E2E_TOK2 env vars are required.');
  }
  return { sheetId, apiUrl, pin, tok1, tok2 };
}

function gsheets(args) {
  return execFileSync('gsheets', args, { encoding: 'utf8' }).trim();
}

function readConfigRows(sheetId) {
  const raw = JSON.parse(gsheets(['readonly', 'read', sheetId, 'Config!A1:C50', '--json']));
  return raw.values || raw;
}

function findConfigRowByKey(rows, key) {
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === key) {
      return { rowNum: i + 1, value: rows[i][1] !== undefined ? String(rows[i][1]) : '' };
    }
  }
  return null;
}

function writeConfigByKey(sheetId, key, value) {
  const rows = readConfigRows(sheetId);
  const found = findConfigRowByKey(rows, key);
  if (!found) {
    throw new Error(`Config key "${key}" not found in staging Config tab.`);
  }
  gsheets(['mutate', 'write', sheetId, `Config!B${found.rowNum}`, String(value)]);
  return found.value;
}

async function api(apiUrl, body) {
  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow'
  });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Non-JSON response (HTTP ${resp.status}): ${text.substring(0, 200)}`);
  }
}

async function run() {
  const cfg = validateE2EEnv(process.env);
  const rows = readConfigRows(cfg.sheetId);
  const origPin = (findConfigRowByKey(rows, 'USHER_PIN') || {}).value || cfg.pin;
  const origStage = (findConfigRowByKey(rows, 'LOCKED_STAGE') || {}).value || 'AUTO';
  const origEventId = (findConfigRowByKey(rows, 'EVENT_ID') || {}).value || 'DEFAULT';

  console.log('Running staging E2E against:', cfg.apiUrl);

  try {
    writeConfigByKey(cfg.sheetId, 'EVENT_ID', 'E2E-TEST');
    writeConfigByKey(cfg.sheetId, 'LOCKED_STAGE', 'AUTO');

    // T1: Wrong PIN
    const t1 = await api(cfg.apiUrl, { action: 'login', pin: '000000', usherName: '=E2E Gate' });
    assert.strictEqual(t1.ok, false, 'T1 expected ok=false');
    assert.strictEqual(t1.message, 'Incorrect Usher PIN.');
    console.log('PASS T1: Wrong PIN rejected');

    // T2: Valid PIN
    const t2 = await api(cfg.apiUrl, { action: 'login', pin: cfg.pin, usherName: '=E2E Gate' });
    assert.strictEqual(t2.ok, true, 'T2 expected ok=true');
    assert.ok(t2.sessionToken && t2.sessionToken.includes('.'));
    assert.strictEqual(t2.eventId, 'E2E-TEST');
    assert.strictEqual(t2.lockedStage, 'AUTO');
    const sessionToken = t2.sessionToken;
    console.log('PASS T2: Valid PIN issued session token');

    // T2b: State restore
    const t2b = await api(cfg.apiUrl, { action: 'state', sessionToken });
    assert.strictEqual(t2b.ok, true);
    assert.strictEqual(t2b.usherLabel, '=E2E Gate');
    console.log('PASS T2b: getScannerState restored session');

    // T3: Valid Check-In
    const t3 = await api(cfg.apiUrl, { action: 'scan', sessionToken, payload: `E2ETEST001|${cfg.tok1}`, stage: 'Check-In' });
    assert.strictEqual(t3.status, 'OK');
    console.log('PASS T3: Valid Check-In accepted');

    // T4: Duplicate Check-In
    const t4 = await api(cfg.apiUrl, { action: 'scan', sessionToken, payload: `E2ETEST001|${cfg.tok1}`, stage: 'Check-In' });
    assert.strictEqual(t4.status, 'DUPLICATE');
    console.log('PASS T4: Duplicate Check-In flagged');

    // T5: Forged token
    const t5 = await api(cfg.apiUrl, { action: 'scan', sessionToken, payload: 'E2ETEST001|AAAAAAAAAA', stage: 'Check-In' });
    assert.strictEqual(t5.status, 'REJECTED_FORGED');
    console.log('PASS T5: Forged token rejected');

    // T6: Malformed QR
    const t6 = await api(cfg.apiUrl, { action: 'scan', sessionToken, payload: 'garbage', stage: 'Check-In' });
    assert.strictEqual(t6.status, 'REJECTED_MALFORMED');
    console.log('PASS T6: Malformed QR rejected');

    // T7: Mid-Event & Check-Out
    assert.strictEqual((await api(cfg.apiUrl, { action: 'scan', sessionToken, payload: `E2ETEST001|${cfg.tok1}`, stage: 'Mid-Event' })).status, 'OK');
    assert.strictEqual((await api(cfg.apiUrl, { action: 'scan', sessionToken, payload: `E2ETEST001|${cfg.tok1}`, stage: 'Check-Out' })).status, 'OK');
    console.log('PASS T7: Mid-Event and Check-Out accepted');

    // T8: E2ETEST002 Check-In
    assert.strictEqual((await api(cfg.apiUrl, { action: 'scan', sessionToken, payload: `E2ETEST002|${cfg.tok2}`, stage: 'Check-In' })).status, 'OK');
    console.log('PASS T8: Second student Check-In accepted');

    // T9: PIN rotation revokes existing session
    writeConfigByKey(cfg.sheetId, 'USHER_PIN', '999888');
    const t9 = await api(cfg.apiUrl, { action: 'scan', sessionToken, payload: `E2ETEST002|${cfg.tok2}`, stage: 'Check-Out' });
    assert.strictEqual(t9.status, 'UNAUTHORIZED');
    writeConfigByKey(cfg.sheetId, 'USHER_PIN', cfg.pin);
    console.log('PASS T9: PIN rotation revoked old session');

    // T10: LOCKED_STAGE enforcement
    writeConfigByKey(cfg.sheetId, 'LOCKED_STAGE', 'Mid-Event');
    const t10a = await api(cfg.apiUrl, { action: 'scan', sessionToken, payload: `E2ETEST002|${cfg.tok2}`, stage: 'Check-Out' });
    assert.strictEqual(t10a.status, 'REJECTED_STAGE_LOCKED');
    const t10b = await api(cfg.apiUrl, { action: 'state', sessionToken });
    assert.strictEqual(t10b.lockedStage, 'Mid-Event');
    console.log('PASS T10: LOCKED_STAGE enforced');

    // Staging Attendance Log assertions
    const logJson = JSON.parse(gsheets(['readonly', 'read', cfg.sheetId, "'Attendance Log'!A1:H200", '--json']));
    const logRows = (logJson.values || logJson).slice(1).filter(r => r[7] === 'E2E-TEST');
    const counts = {};
    for (const r of logRows) {
      counts[r[6]] = (counts[r[6]] || 0) + 1;
      assert.strictEqual(r[5], '=E2E Gate');
    }
    assert.strictEqual(counts.ACCEPTED, 4);
    assert.strictEqual(counts.DUPLICATE, 1);
    assert.strictEqual(counts.REJECTED_FORGED, 1);
    assert.strictEqual(counts.REJECTED_MALFORMED, 1);
    assert.strictEqual(counts.REJECTED_STAGE_LOCKED, 1);
    assert.strictEqual(logRows.length, 8);
    console.log('PASS Sheet Assertions:', JSON.stringify(counts));
  } finally {
    // Always restore exact backed-up Config values by key name
    writeConfigByKey(cfg.sheetId, 'USHER_PIN', origPin);
    writeConfigByKey(cfg.sheetId, 'LOCKED_STAGE', origStage);
    writeConfigByKey(cfg.sheetId, 'EVENT_ID', origEventId);
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('STAGING E2E FAILED:', err);
    process.exit(1);
  });
}

module.exports = { PRODUCTION_SHEET_ID, validateE2EEnv, findConfigRowByKey };

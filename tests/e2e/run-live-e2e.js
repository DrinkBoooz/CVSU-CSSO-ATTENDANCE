'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');

const API_URL = process.env.CSSO_API_URL ||
  'https://script.google.com/macros/s/AKfycbwUMbXFKERYyNEWdGgDavVR4miCPD7OsDPBud_YsjSe3FbPdW-UiN26gclamX8UD_ou/exec';
const SHEET_ID = process.env.CSSO_SHEET_ID || '16NSuhDLinZQf9fpkrZYBu2ZyPM7Fq3dhutPZ78iDuWA';
const LIVE_PIN = process.env.CSSO_E2E_PIN;
const TOK1 = process.env.CSSO_E2E_TOK1;
const TOK2 = process.env.CSSO_E2E_TOK2;

if (!LIVE_PIN || !TOK1 || !TOK2) {
  console.error('Set CSSO_E2E_PIN, CSSO_E2E_TOK1, CSSO_E2E_TOK2 env vars before running.');
  process.exit(1);
}

function gsheets(args) {
  return execFileSync('gsheets', args, { encoding: 'utf8', shell: true }).trim();
}

async function api(body) {
  const resp = await fetch(API_URL, {
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
  console.log('Running live E2E against:', API_URL);

  // T1: Wrong PIN
  const t1 = await api({ action: 'login', pin: '000000', usherName: '=E2E Gate' });
  assert.strictEqual(t1.ok, false, 'T1 expected ok=false');
  assert.strictEqual(t1.message, 'Incorrect Usher PIN.');
  console.log('PASS T1: Wrong PIN rejected');

  // T2: Valid PIN
  const t2 = await api({ action: 'login', pin: LIVE_PIN, usherName: '=E2E Gate' });
  assert.strictEqual(t2.ok, true, 'T2 expected ok=true: ' + JSON.stringify(t2));
  assert.ok(t2.sessionToken && t2.sessionToken.includes('.'));
  assert.strictEqual(t2.eventId, 'E2E-TEST');
  assert.strictEqual(t2.lockedStage, 'AUTO');
  const sessionToken = t2.sessionToken;
  console.log('PASS T2: Valid PIN issued HMAC session token');

  // T2b: State restore
  const t2b = await api({ action: 'state', sessionToken });
  assert.strictEqual(t2b.ok, true);
  assert.strictEqual(t2b.usherLabel, '=E2E Gate');
  console.log('PASS T2b: getScannerState restored session');

  // T3: Valid Check-In
  const t3 = await api({ action: 'scan', sessionToken, payload: `E2ETEST001|${TOK1}`, stage: 'Check-In' });
  assert.strictEqual(t3.status, 'OK', 'T3: ' + JSON.stringify(t3));
  assert.strictEqual(t3.fullName, 'E2E Qualified Student');
  console.log('PASS T3: Valid Check-In accepted');

  // T4: Duplicate Check-In
  const t4 = await api({ action: 'scan', sessionToken, payload: `E2ETEST001|${TOK1}`, stage: 'Check-In' });
  assert.strictEqual(t4.status, 'DUPLICATE', 'T4: ' + JSON.stringify(t4));
  console.log('PASS T4: Duplicate Check-In flagged');

  // T5: Forged token
  const t5 = await api({ action: 'scan', sessionToken, payload: 'E2ETEST001|AAAAAAAAAA', stage: 'Check-In' });
  assert.strictEqual(t5.status, 'REJECTED_FORGED', 'T5: ' + JSON.stringify(t5));
  console.log('PASS T5: Forged token rejected');

  // T6: Malformed QR
  const t6 = await api({ action: 'scan', sessionToken, payload: 'garbage', stage: 'Check-In' });
  assert.strictEqual(t6.status, 'REJECTED_MALFORMED', 'T6: ' + JSON.stringify(t6));
  console.log('PASS T6: Malformed QR rejected');

  // T7: Mid-Event & Check-Out for E2ETEST001
  const t7a = await api({ action: 'scan', sessionToken, payload: `E2ETEST001|${TOK1}`, stage: 'Mid-Event' });
  assert.strictEqual(t7a.status, 'OK', 'T7a: ' + JSON.stringify(t7a));
  const t7b = await api({ action: 'scan', sessionToken, payload: `E2ETEST001|${TOK1}`, stage: 'Check-Out' });
  assert.strictEqual(t7b.status, 'OK', 'T7b: ' + JSON.stringify(t7b));
  console.log('PASS T7: Mid-Event and Check-Out accepted');

  // T8: E2ETEST002 Check-In
  const t8 = await api({ action: 'scan', sessionToken, payload: `E2ETEST002|${TOK2}`, stage: 'Check-In' });
  assert.strictEqual(t8.status, 'OK', 'T8: ' + JSON.stringify(t8));
  assert.strictEqual(t8.fullName, 'E2E Incomplete Student');
  console.log('PASS T8: Second student Check-In accepted');

  // T9: PIN rotation revokes existing session (UNAUTHORIZED, 0 rows logged)
  try {
    gsheets(['mutate', 'write', SHEET_ID, 'Config!B2', '999888']);
    const t9 = await api({ action: 'scan', sessionToken, payload: `E2ETEST002|${TOK2}`, stage: 'Check-Out' });
    assert.strictEqual(t9.status, 'UNAUTHORIZED', 'T9: ' + JSON.stringify(t9));
    console.log('PASS T9: PIN rotation immediately revoked old session (UNAUTHORIZED)');
  } finally {
    gsheets(['mutate', 'write', SHEET_ID, 'Config!B2', LIVE_PIN]);
  }

  // T10: LOCKED_STAGE server enforcement
  try {
    gsheets(['mutate', 'write', SHEET_ID, 'Config!B5', 'Mid-Event']);
    const t10a = await api({ action: 'scan', sessionToken, payload: `E2ETEST002|${TOK2}`, stage: 'Check-Out' });
    assert.strictEqual(t10a.status, 'REJECTED_STAGE_LOCKED', 'T10a: ' + JSON.stringify(t10a));
    const t10b = await api({ action: 'state', sessionToken });
    assert.strictEqual(t10b.lockedStage, 'Mid-Event', 'T10b: ' + JSON.stringify(t10b));
    console.log('PASS T10: LOCKED_STAGE enforced on server and reported in state');
  } finally {
    gsheets(['mutate', 'write', SHEET_ID, 'Config!B5', 'AUTO']);
  }

  // gsheets Assertions on Attendance Log
  const logJson = JSON.parse(gsheets(['readonly', 'read', SHEET_ID, "'Attendance Log'!A1:H100", '--json']));
  const rows = (logJson.values || logJson).slice(1).filter(r => r[7] === 'E2E-TEST');
  const counts = {};
  for (const r of rows) {
    counts[r[6]] = (counts[r[6]] || 0) + 1;
    assert.strictEqual(r[5], '=E2E Gate', `Formula injection check failed: got ${r[5]}`);
  }
  assert.strictEqual(counts.ACCEPTED, 4, 'Expected 4 ACCEPTED, got ' + JSON.stringify(counts));
  assert.strictEqual(counts.DUPLICATE, 1, 'Expected 1 DUPLICATE, got ' + JSON.stringify(counts));
  assert.strictEqual(counts.REJECTED_FORGED, 1, 'Expected 1 REJECTED_FORGED');
  assert.strictEqual(counts.REJECTED_MALFORMED, 1, 'Expected 1 REJECTED_MALFORMED');
  assert.strictEqual(counts.REJECTED_STAGE_LOCKED, 1, 'Expected 1 REJECTED_STAGE_LOCKED');
  assert.strictEqual(rows.length, 8, 'Expected 8 total E2E-TEST rows (0 from T9), got ' + rows.length);
  console.log('PASS Sheet Assertions:', JSON.stringify(counts));
}

run().catch(err => {
  console.error('LIVE E2E FAILED:', err);
  process.exit(1);
});

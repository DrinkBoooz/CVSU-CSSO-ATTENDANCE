'use strict';

const assert = require('assert');
const { loadCode } = require('./helpers/gas-mock');

function post(ctx, obj) {
  const out = ctx.doPost({ postData: { contents: JSON.stringify(obj) } });
  assert.strictEqual(out.getMimeType(), 'application/json');
  return JSON.parse(out.getContent());
}

function run() {
  const salt = 'abcd1234abcd1234abcd1234abcd1234';
  const { ctx, sheets } = loadCode({
    sheets: {
      Config: [
        ['Key', 'Value'],
        ['USHER_PIN', '554433'],
        ['SECRET_SALT', salt],
        ['EVENT_TITLE', 'CSSO External Scanner'],
        ['EVENT_ID', 'DEFAULT'],
        ['LOCKED_STAGE', 'AUTO']
      ],
      Roster: [
        ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status'],
        ['202310001', 'a@cvsu.edu.ph', 'Juan Dela Cruz', 'BSCS 4-2', '', '']
      ],
      'Attendance Log': [
        ['Timestamp', 'Stage', 'Student ID', 'Full Name', 'Section', 'Usher Label', 'Scan Status', 'Event ID']
      ]
    }
  });

  // 1. Login via doPost
  const login = post(ctx, { action: 'login', pin: '554433', usherName: 'Gate B' });
  assert.strictEqual(login.ok, true);
  assert.ok(login.sessionToken);
  assert.strictEqual(login.eventId, 'DEFAULT');

  // 2. State via doPost
  const state = post(ctx, { action: 'state', sessionToken: login.sessionToken });
  assert.strictEqual(state.ok, true);
  assert.strictEqual(state.usherLabel, 'Gate B');

  // 3. Scan via doPost
  const tok = ctx.createSignature_('202310001', salt);
  const scan = post(ctx, { action: 'scan', sessionToken: login.sessionToken, payload: `202310001|${tok}`, stage: 'Check-In' });
  assert.strictEqual(scan.status, 'OK');
  assert.strictEqual(sheets.get('Attendance Log').getLastRow(), 2);

  // 4. Unauthorized scan via doPost
  const unauth = post(ctx, { action: 'scan', sessionToken: 'bad', payload: `202310001|${tok}`, stage: 'Mid-Event' });
  assert.strictEqual(unauth.status, 'UNAUTHORIZED');
  assert.strictEqual(sheets.get('Attendance Log').getLastRow(), 2);

  // 5. Invalid JSON vs internal handler exception separation
  const unknown = post(ctx, { action: 'nope' });
  assert.strictEqual(unknown.status, 'ERROR');
  const badJson = JSON.parse(ctx.doPost({ postData: { contents: '{bad' } }).getContent());
  assert.strictEqual(badJson.status, 'INVALID_JSON');

  ctx.recordScan = () => { throw new Error('Simulated DB crash'); };
  const internalErr = post(ctx, { action: 'scan', sessionToken: login.sessionToken, payload: `202310001|${tok}`, stage: 'Mid-Event' });
  assert.strictEqual(internalErr.status, 'INTERNAL_ERROR');
  assert.ok(internalErr.requestId);

  console.log('PASS: dopost.test.js');
}

run();

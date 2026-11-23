'use strict';

const assert = require('assert');
const { loadCode } = require('./helpers/gas-mock');

function run() {
  const { ctx, sheets } = loadCode({
    sheets: {
      Config: [
        ['Key', 'Value'],
        ['USHER_PIN', '619482'],
        ['SECRET_SALT', 'fedcba9876543210fedcba9876543210'],
        ['EVENT_ID', 'EVT-2026']
      ],
      Roster: [
        ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status'],
        ['202310001', 'a@cvsu.edu.ph', 'Juan Dela Cruz', 'BSCS 4-2', 'TOK1', 'SENT'],
        ['202310002', 'b@cvsu.edu.ph', 'Maria Santos', 'BSCS 4-2', 'TOK2', 'SENT']
      ],
      'Attendance Log': [
        ['Timestamp', 'Stage', 'Student ID', 'Full Name', 'Section', 'Usher Label', 'Scan Status', 'Event ID'],
        [new Date('2026-11-23T08:00:00+08:00'), 'Check-In', '202310001', 'Juan Dela Cruz', 'BSCS 4-2', 'Gate A', 'ACCEPTED', 'EVT-2026'],
        [new Date('2026-11-23T10:00:00+08:00'), 'Mid-Event', '202310001', 'Juan Dela Cruz', 'BSCS 4-2', 'Gate A', 'ACCEPTED', 'EVT-2026'],
        [new Date('2026-11-23T12:00:00+08:00'), 'Check-Out', '202310001', 'Juan Dela Cruz', 'BSCS 4-2', 'Gate A', 'ACCEPTED', 'EVT-2026'],
        [new Date('2026-11-23T08:05:00+08:00'), 'Check-In', '202310002', 'Maria Santos', 'BSCS 4-2', 'Gate A', 'ACCEPTED', 'EVT-2026'],
        // Different event should be ignored
        [new Date('2026-11-22T10:00:00+08:00'), 'Mid-Event', '202310002', 'Maria Santos', 'BSCS 4-2', 'Gate A', 'ACCEPTED', 'OLD-EVT'],
        // Rejected scan should be ignored
        [new Date('2026-11-23T11:00:00+08:00'), 'Check-Out', '202310002', 'Maria Santos', 'BSCS 4-2', 'Gate A', 'REJECTED_FORGED', 'EVT-2026']
      ],
      'Verified Attendance': [
        ['Student ID', 'Full Name', 'Section', 'Check-In', 'Mid-Event', 'Check-Out', 'Qualification', 'Stage Count'],
        ['OLD1', 'Stale Row 1', 'X', '—', '—', '—', 'INCOMPLETE', 0],
        ['OLD2', 'Stale Row 2', 'X', '—', '—', '—', 'INCOMPLETE', 0],
        ['OLD3', 'Stale Row 3', 'X', '—', '—', '—', 'INCOMPLETE', 0]
      ]
    }
  });

  ctx.rebuildVerifiedAttendance_();

  const ver = sheets.get('Verified Attendance');
  // Row 1 header (including H1 Stage Count) preserved, no clearContents()
  assert.strictEqual(ver._stats.clearContentsCalls, 0);
  assert.strictEqual(ver._data[0][7], 'Stage Count');
  // Single batch setValues call
  assert.strictEqual(ver._stats.setValuesCalls, 1);

  // Row 2: 202310001 -> QUALIFIED, Stage Count 3
  assert.strictEqual(ver._data[1][0], '202310001');
  assert.strictEqual(ver._data[1][6], 'QUALIFIED');
  assert.strictEqual(ver._data[1][7], 3);

  // Row 3: 202310002 -> INCOMPLETE, Stage Count 1 (OLD-EVT & REJECTED ignored)
  assert.strictEqual(ver._data[2][0], '202310002');
  assert.strictEqual(ver._data[2][6], 'INCOMPLETE');
  assert.strictEqual(ver._data[2][7], 1);

  // Row 4 stale trailing row was cleared
  assert.strictEqual(ver._data[3][0], '');

  console.log('PASS: rebuild.test.js');
}

run();

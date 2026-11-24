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

  // 2. REQUIRE_MID_EVENT=FALSE: Check-In + Check-Out qualifies (Mid-Event optional) & stage order allows Check-In -> Check-Out
  {
    const env = loadCode({
      sheets: {
        Config: [
          ['Key', 'Value', 'Notes'],
          ['USHER_PIN', '619482', ''],
          ['SECRET_SALT', 'fedcba9876543210fedcba9876543210', ''],
          ['EVENT_ID', 'EVT-2026', ''],
          ['ENFORCE_STAGE_ORDER', 'TRUE', ''],
          ['REQUIRE_MID_EVENT', 'FALSE', '']
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status'],
          ['202310001', 'a@cvsu.edu.ph', 'Juan Dela Cruz', 'BSCS 4-2', '', 'READY_ON_PORTAL'],
          ['202310002', 'b@cvsu.edu.ph', 'Maria Santos', 'BSCS 4-2', '', 'READY_ON_PORTAL'],
          ['202310003', 'c@cvsu.edu.ph', 'Pedro Reyes', 'BSCS 4-2', '', 'READY_ON_PORTAL']
        ],
        'Attendance Log': [
          ['Timestamp', 'Stage', 'Student ID', 'Full Name', 'Section', 'Usher Label', 'Scan Status', 'Event ID']
        ],
        'Verified Attendance': [
          ['Student ID', 'Full Name', 'Section', 'Check-In', 'Mid-Event', 'Check-Out', 'Qualification', 'Stage Count']
        ]
      }
    });
    const login = env.ctx.verifyUsherPin('619482', 'Gate A');
    assert.strictEqual(login.ok, true);

    const snap = env.ctx.getScannerSnapshot(login.sessionToken);
    assert.strictEqual(snap.requireMidEvent, false);

    // Check-Out without Check-In is still rejected when ENFORCE_STAGE_ORDER=TRUE
    const sig1 = env.ctx.createV2Signature_('EVT-2026', '202310001', 'fedcba9876543210fedcba9876543210');
    const p1 = `v2|EVT-2026|202310001|${sig1}`;
    const earlyOut = env.ctx.recordScan(login.sessionToken, p1, 'Check-Out');
    assert.strictEqual(earlyOut.status, 'REJECTED_STAGE_ORDER');
    assert.ok(earlyOut.message.includes('Check-In before Check-Out'));

    // Check-In -> Check-Out directly (skipping Mid-Event) succeeds and qualifies
    assert.strictEqual(env.ctx.recordScan(login.sessionToken, p1, 'Check-In').status, 'OK');
    assert.strictEqual(env.ctx.recordScan(login.sessionToken, p1, 'Check-Out').status, 'OK');

    // Student 2: Check-In + Mid-Event (no Check-Out) -> INCOMPLETE
    assert.strictEqual(env.ctx.recordManualScan(login.sessionToken, '202310002', 'Check-In').status, 'OK');
    assert.strictEqual(env.ctx.recordManualScan(login.sessionToken, '202310002', 'Mid-Event').status, 'OK');

    // Student 3: All 3 stages (optional Mid-Event included) via batch -> QUALIFIED (Stage Count 3)
    const sig3 = env.ctx.createV2Signature_('EVT-2026', '202310003', 'fedcba9876543210fedcba9876543210');
    const p3 = `v2|EVT-2026|202310003|${sig3}`;
    const batch = env.ctx.recordScanBatch(login.sessionToken, [
      { clientId: 'b1', payload: p3, stage: 'Check-In' },
      { clientId: 'b2', payload: p3, stage: 'Mid-Event' },
      { clientId: 'b3', payload: p3, stage: 'Check-Out' }
    ]);
    assert.strictEqual(batch.results.every(r => r.status === 'OK'), true);

    env.ctx.rebuildVerifiedAttendance_();
    const v2 = env.sheets.get('Verified Attendance')._data;
    const row1 = v2.find(r => r[0] === '202310001');
    const row2 = v2.find(r => r[0] === '202310002');
    const row3 = v2.find(r => r[0] === '202310003');
    assert.strictEqual(row1[6], 'QUALIFIED');
    assert.strictEqual(row1[7], 2);
    assert.strictEqual(row2[6], 'INCOMPLETE');
    assert.strictEqual(row2[7], 2);
    assert.strictEqual(row3[6], 'QUALIFIED');
    assert.strictEqual(row3[7], 3);

    // applyAllSystemUpgrades preserves REQUIRE_MID_EVENT=FALSE
    env.ctx.applyAllSystemUpgrades();
    assert.strictEqual(env.ctx.getConfig_().REQUIRE_MID_EVENT, false);
  }

  // 3. Natural Section -> Full Name sorting, Section Summary bounded formulas, splitVerifiedAttendanceBySection & removeSectionTabs
  {
    const env = loadCode({
      sheets: {
        Config: [
          ['Key', 'Value', 'Notes'],
          ['USHER_PIN', '619482', ''],
          ['SECRET_SALT', 'fedcba9876543210fedcba9876543210', ''],
          ['EVENT_ID', 'EVT-2026', '']
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status'],
          ['202310004', 'd@cvsu.edu.ph', 'Zara Unassigned', '', '', 'READY_ON_PORTAL'],
          ['202310003', 'c@cvsu.edu.ph', 'Carlos Ten', 'BSCS 1-10', '', 'READY_ON_PORTAL'],
          ['202310001', 'a@cvsu.edu.ph', 'Zed Two', 'BSCS 1-2', '', 'READY_ON_PORTAL'],
          ['202310002', 'b@cvsu.edu.ph', 'Ana Two', 'BSCS 1-2', '', 'READY_ON_PORTAL']
        ],
        'Attendance Log': [
          ['Timestamp', 'Stage', 'Student ID', 'Full Name', 'Section', 'Usher Label', 'Scan Status', 'Event ID']
        ],
        'Verified Attendance': [
          ['Student ID', 'Full Name', 'Section', 'Check-In', 'Mid-Event', 'Check-Out', 'Qualification', 'Stage Count']
        ]
      }
    });

    env.ctx.applyAllSystemUpgrades();

    // Verified Attendance sorted naturally: BSCS 1-2 (Ana then Zed) -> BSCS 1-10 -> blank section last
    const verRows = env.sheets.get('Verified Attendance')._data.slice(1).map(r => `${r[2]}|${r[1]}`);
    assert.deepStrictEqual(verRows, [
      'BSCS 1-2|Ana Two',
      'BSCS 1-2|Zed Two',
      'BSCS 1-10|Carlos Ten',
      '|Zara Unassigned'
    ]);

    // Section Summary created with bounded 2:5000 native formulas & Filter dropdown
    const sumSheet = env.sheets.get('Section Summary');
    assert.ok(sumSheet, 'Section Summary tab must exist');
    assert.ok(String(sumSheet._data[1][0]).includes("'Verified Attendance'!C2:C5000"));
    assert.ok(String(sumSheet._data[1][2]).includes('"QUALIFIED"'));
    assert.strictEqual(sumSheet._data[0][6], 'Filter Section:');
    assert.ok(String(sumSheet._data[2][6]).includes('FILTER'));

    // Split Verified Attendance into per-section tabs
    const split = env.ctx.splitVerifiedAttendanceBySection();
    assert.strictEqual(split.ok, true);
    assert.deepStrictEqual(Array.from(split.tabs), ['Sec - BSCS 1-2', 'Sec - BSCS 1-10', 'Sec - Unassigned']);
    assert.strictEqual(env.sheets.get('Sec - BSCS 1-2')._data.length, 3); // header + 2 rows
    assert.strictEqual(env.sheets.get('Sec - BSCS 1-2')._data[1][1], 'Ana Two');
    assert.strictEqual(env.sheets.get('Sec - Unassigned')._data[1][1], 'Zara Unassigned');

    // Remove per-section tabs deletes ONLY Sec - * tabs
    const rem = env.ctx.removeSectionTabs();
    assert.strictEqual(rem.ok, true);
    assert.strictEqual(rem.removed, 3);
    assert.strictEqual(env.sheets.has('Sec - BSCS 1-2'), false);
    assert.strictEqual(env.sheets.has('Verified Attendance'), true);
    assert.strictEqual(env.sheets.has('Section Summary'), true);
    assert.strictEqual(env.sheets.has('List'), true);
  }

  console.log('PASS: rebuild.test.js');
}

run();

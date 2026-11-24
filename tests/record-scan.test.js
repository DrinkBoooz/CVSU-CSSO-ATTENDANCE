'use strict';

const assert = require('assert');
const { loadCode } = require('./helpers/gas-mock');

function makeFixture(extraConfig = []) {
  const salt = 'fedcba9876543210fedcba9876543210';
  const env = loadCode({
    sheets: {
      Config: [
        ['Key', 'Value'],
        ['USHER_PIN', '619482'],
        ['SECRET_SALT', salt],
        ['EVENT_TITLE', 'CSSO Day'],
        ['EVENT_ID', 'DEFAULT'],
        ['LOCKED_STAGE', 'AUTO'],
        ['ENFORCE_STAGE_ORDER', 'FALSE'],
        ...extraConfig
      ],
      Roster: [
        ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status', 'QR Preview'],
        ['202310001', 'a@cvsu.edu.ph', 'Juan Dela Cruz', 'BSCS 4-2', '', '', ''],
        ['202310002', 'b@cvsu.edu.ph', 'Maria Santos', 'BSCS 4-2', '', '', '']
      ],
      'Attendance Log': [
        ['Timestamp', 'Stage', 'Student ID', 'Full Name', 'Section', 'Usher Label', 'Scan Status', 'Event ID']
      ],
      'Verified Attendance': [
        ['Student ID', 'Full Name', 'Section', 'Check-In', 'Mid-Event', 'Check-Out', 'Qualification', 'Stage Count']
      ]
    }
  });
  const login = env.ctx.verifyUsherPin('619482', '=Gate A');
  assert.strictEqual(login.ok, true);
  const tok1 = env.ctx.createSignature_('202310001', salt);
  const tok2 = env.ctx.createSignature_('202310002', salt);
  return { ...env, salt, token: login.sessionToken, tok1, tok2 };
}

function run() {
  // 1. Unauthorized session writes ZERO rows
  {
    const { ctx, sheets, tok1 } = makeFixture();
    const res = ctx.recordScan('bogus.token', `202310001|${tok1}`, 'Check-In');
    assert.strictEqual(res.status, 'UNAUTHORIZED');
    assert.strictEqual(sheets.get('Attendance Log').getLastRow(), 1);
  }

  // 2. Valid scan writes 1 row with Event ID, sanitizes usher label, and does NOT rewrite Verified Attendance
  {
    const { ctx, sheets, token, tok1, salt } = makeFixture();
    const res = ctx.recordScan(token, `202310001|${tok1}`, 'Check-In');
    assert.strictEqual(res.status, 'OK');
    assert.strictEqual(res.eventId, 'DEFAULT');

    const log = sheets.get('Attendance Log');
    assert.strictEqual(log.getLastRow(), 2);
    const row = log._data[1];
    assert.strictEqual(row[1], 'Check-In');
    assert.strictEqual(row[2], '202310001');
    assert.strictEqual(row[5], "'=Gate A"); // formula injection neutralized
    assert.strictEqual(row[6], 'ACCEPTED');
    assert.strictEqual(row[7], 'DEFAULT');

    // Verified Attendance was NOT touched on scan hot path
    const ver = sheets.get('Verified Attendance');
    assert.strictEqual(ver._stats.setValuesCalls, 0);
    assert.strictEqual(ver._stats.clearContentsCalls, 0);

    // Duplicate same stage & same Event ID -> DUPLICATE (logged)
    const dup = ctx.recordScan(token, `202310001|${tok1}`, 'Check-In');
    assert.strictEqual(dup.status, 'DUPLICATE');
    assert.strictEqual(log.getLastRow(), 3);
    assert.strictEqual(log._data[2][6], 'DUPLICATE');

    // Switch EVENT_ID -> v2 pass for EVT-02 is ACCEPTED (not duplicate), while v1 is rejected
    sheets.get('Config')._data[4][1] = 'EVT-02';
    const v2Evt2 = `v2|EVT-02|202310001|${ctx.createV2Signature_('EVT-02', '202310001', salt)}`;
    const nextEvt = ctx.recordScan(token, v2Evt2, 'Check-In');
    assert.strictEqual(nextEvt.status, 'OK');
    assert.strictEqual(log._data[3][7], 'EVT-02');
  }

  // 3. Forged, malformed, not-in-roster are rejected and logged
  {
    const { ctx, sheets, token, salt } = makeFixture();
    const log = sheets.get('Attendance Log');

    const r1 = ctx.recordScan(token, '202310001|AAAAAAAAAA', 'Check-In');
    assert.strictEqual(r1.status, 'REJECTED_FORGED');

    const r2 = ctx.recordScan(token, 'not-a-valid-qr', 'Check-In');
    assert.strictEqual(r2.status, 'REJECTED_MALFORMED');

    const ghostTok = ctx.createSignature_('999999999', salt);
    const r3 = ctx.recordScan(token, `999999999|${ghostTok}`, 'Check-In');
    assert.strictEqual(r3.status, 'REJECTED_NOT_IN_ROSTER');

    assert.strictEqual(log._data[1][6], 'REJECTED_FORGED');
    assert.strictEqual(log._data[2][6], 'REJECTED_MALFORMED');
    assert.strictEqual(log._data[3][6], 'REJECTED_NOT_IN_ROSTER');
  }

  // 4. LOCKED_STAGE enforcement
  {
    const { ctx, sheets, token, tok1, salt } = makeFixture();
    sheets.get('Config')._data[5][1] = 'Mid-Event';
    const res = ctx.recordScan(token, `202310001|${tok1}`, 'Check-Out');
    assert.strictEqual(res.status, 'REJECTED_STAGE_LOCKED');
    assert.strictEqual(sheets.get('Attendance Log')._data[1][6], 'REJECTED_STAGE_LOCKED');
  }

  // 5. ENFORCE_STAGE_ORDER enforcement
  {
    const { ctx, sheets, token, tok1, salt } = makeFixture();
    sheets.get('Config')._data[6][1] = 'TRUE';
    const rMid = ctx.recordScan(token, `202310001|${tok1}`, 'Mid-Event');
    assert.strictEqual(rMid.status, 'REJECTED_STAGE_ORDER');
    assert.strictEqual(ctx.recordScan(token, `202310001|${tok1}`, 'Check-In').status, 'OK');
    assert.strictEqual(ctx.recordScan(token, `202310001|${tok1}`, 'Mid-Event').status, 'OK');
    assert.strictEqual(ctx.recordScan(token, `202310001|${tok1}`, 'Check-Out').status, 'OK');
  }

  // 6. Walk-in participant added after cache warm is accepted immediately via cache-miss live lookup
  {
    const { ctx, sheets, token, tok1, salt } = makeFixture();
    assert.strictEqual(ctx.recordScan(token, `202310001|${tok1}`, 'Check-In').status, 'OK');

    // Add walk-in directly to Roster without invalidating cache
    const walkInId = '202699999';
    const walkInTok = ctx.createSignature_(walkInId, salt);
    sheets.get('Roster')._data.push([walkInId, 'walkin@cvsu.edu.ph', 'Walk In Student', 'BSCS 1-1', walkInTok, '', '']);

    const walkInScan = ctx.recordScan(token, `${walkInId}|${walkInTok}`, 'Check-In');
    assert.strictEqual(walkInScan.status, 'OK');
    assert.strictEqual(walkInScan.fullName, 'Walk In Student');
  }

  // 7. onSheetEdit invalidates Roster cache when Roster is edited
  {
    const { ctx, sheets, cache, token, tok1 } = makeFixture();
    assert.strictEqual(ctx.recordScan(token, `202310001|${tok1}`, 'Check-In').status, 'OK');
    const shardKey = `roster_v2_s${ctx.rosterShardIdx_('202310001')}`;
    assert.ok(cache.get(shardKey) !== null);
    ctx.onSheetEdit({ range: { getSheet: () => sheets.get('Roster') } });
    assert.strictEqual(cache.get(shardKey), null);
  }

  // 8. Cache eviction on dedupe index falls back to authoritative Attendance Log
  {
    const { ctx, cache, token, tok1 } = makeFixture();
    assert.strictEqual(ctx.recordScan(token, `202310001|${tok1}`, 'Check-In').status, 'OK');
    // Evict dedupe cache completely
    cache._store.clear();
    // Second scan for same stage MUST still be flagged DUPLICATE from Attendance Log
    assert.strictEqual(ctx.recordScan(token, `202310001|${tok1}`, 'Check-In').status, 'DUPLICATE');
  }

  // 9. Lock contention: tryLock() === false returns busy, writes 0 rows, does not mutate cache, does not call releaseLock()
  {
    const { ctx, sheets, cache, lock, lockStats, token, tok1 } = makeFixture();
    lock._setHeld(true);
    const beforeTry = lockStats.tryLockCalls;
    const beforeRel = lockStats.releaseLockCalls;

    const busy = ctx.recordScan(token, `202310001|${tok1}`, 'Check-In');
    assert.strictEqual(busy.status, 'ERROR');
    assert.match(busy.message, /Scanner busy/i);
    assert.strictEqual(lockStats.tryLockCalls, beforeTry + 1);
    assert.strictEqual(lockStats.releaseLockCalls, beforeRel); // releaseLock NOT called when not acquired
    assert.strictEqual(sheets.get('Attendance Log').getLastRow(), 1);
    assert.strictEqual(cache.get('evt_seen_DEFAULT_202310001'), null);

    // Release lock -> normal scan acquires & releases lock cleanly
    lock._setHeld(false);
    const ok = ctx.recordScan(token, `202310001|${tok1}`, 'Check-In');
    assert.strictEqual(ok.status, 'OK');
    assert.strictEqual(lockStats.releaseLockCalls, beforeRel + 1);
    assert.strictEqual(lock._isHeld(), false);

    // Exception inside lock still calls releaseLock() via finally
    const origAppendRow = sheets.get('Attendance Log').appendRow.bind(sheets.get('Attendance Log'));
    sheets.get('Attendance Log').appendRow = () => { throw new Error('Simulated sheet failure'); };
    assert.throws(() => ctx.recordScan(token, `202310001|${tok1}`, 'Mid-Event'), /Simulated sheet failure/);
    assert.strictEqual(lockStats.releaseLockCalls, beforeRel + 2);
    assert.strictEqual(lock._isHeld(), false);
    sheets.get('Attendance Log').appendRow = origAppendRow;
  }

  console.log('PASS: record-scan.test.js');
}

run();

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { loadCode } = require('./helpers/gas-mock');

function v1Sig(id, salt) {
  return crypto.createHash('sha256').update(`${id}|${salt}`).digest('hex').substring(0, 10).toUpperCase();
}

function v2Sig(eventId, studentId, salt) {
  return crypto.createHmac('sha256', salt).update(`v2|${eventId}|${studentId}`).digest('hex').toUpperCase();
}

function makeEnv(extra = {}) {
  const salt = extra.salt || '0123456789abcdef0123456789abcdef';
  const pin = extra.pin || '619482';
  const eventId = extra.eventId || 'DEFAULT';
  const env = loadCode({
    failPropWrite: Boolean(extra.failPropWrite),
    scriptProperties: extra.scriptProperties || {},
    sheets: {
      Config: [
        ['Key', 'Value', 'Notes'],
        ['USHER_PIN', pin, 'PIN'],
        ['SECRET_SALT', salt, 'Salt'],
        ['EVENT_TITLE', 'CSSO Event', 'Title'],
        ['EVENT_ID', eventId, 'Event'],
        ['LOCKED_STAGE', 'AUTO', 'Stage']
      ],
      Roster: [
        ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status', 'QR Preview', 'Last Sent Token', 'Last Sent ID', 'Attempt #', 'Dispatched At', 'Last Error'],
        ['202310001', 'a@cvsu.edu.ph', 'Juan Dela Cruz', 'BSCS 4-2', v1Sig('202310001', salt), 'SENT', '', v1Sig('202310001', salt), '202310001', 1, '', ''],
        ['202310002', 'b@cvsu.edu.ph', 'Maria Santos', 'BSCS 4-2', v1Sig('202310002', salt), 'SENT', '', v1Sig('202310002', salt), '202310002', 1, '', '']
      ],
      'Attendance Log': [
        ['Timestamp', 'Stage', 'Student ID', 'Full Name', 'Section', 'Usher Label', 'Scan Status', 'Event ID']
      ],
      'Verified Attendance': [
        ['Student ID', 'Full Name', 'Section', 'Check-In', 'Mid-Event', 'Check-Out', 'Qualification', 'Stage Count']
      ]
    }
  });
  const login = env.ctx.verifyUsherPin(pin, 'Gate A');
  assert.strictEqual(login.ok, true);
  return { ...env, salt, pin, sessionToken: login.sessionToken };
}

function run() {
  // 1. Exact v1 fixed vector + v2 canonical payload + malformed separator & no silent field normalization
  {
    const { ctx, sessionToken, salt } = makeEnv({ eventId: 'DEFAULT', scriptProperties: { V1_COMPAT_EVENT_ID: 'DEFAULT' } });

    // Fixed v1 vector accepted on DEFAULT
    const fixedV1 = v1Sig('202310001', salt);
    assert.strictEqual(ctx.recordScan(sessionToken, `202310001|${fixedV1}`, 'Check-In').status, 'OK');

    // v2 canonical payload accepted
    const sig2 = v2Sig('DEFAULT', '202310002', salt);
    assert.strictEqual(ctx.recordScan(sessionToken, `v2|DEFAULT|202310002|${sig2}`, 'Check-In').status, 'OK');

    // Malformed separators / field with '|' rejected
    assert.throws(() => ctx.createV2Signature_('EVT|BAD', '202310001', salt));
    assert.throws(() => ctx.createV2Signature_('EVT', '2023|10001', salt));
    assert.strictEqual(ctx.recordScan(sessionToken, `v2|DEFAULT|202310002|EXTRA|${sig2}`, 'Mid-Event').status, 'REJECTED_MALFORMED');

    // No silent trimming or case-normalization of signed fields
    assert.strictEqual(ctx.recordScan(sessionToken, `v2|DEFAULT| 202310002 |${sig2}`, 'Mid-Event').status, 'REJECTED_MALFORMED');
    assert.strictEqual(ctx.recordScan(sessionToken, `v2|default|202310002|${sig2}`, 'Mid-Event').status, 'REJECTED_WRONG_EVENT');

    // Cross-event replay rejected
    const otherEvtSig = v2Sig('OTHER-2026', '202310002', salt);
    assert.strictEqual(ctx.recordScan(sessionToken, `v2|OTHER-2026|202310002|${otherEvtSig}`, 'Mid-Event').status, 'REJECTED_WRONG_EVENT');
  }

  // 2. ScriptProperties migration (verify-then-clear), failed migration, and rollback restore
  {
    const envFail = makeEnv({ failPropWrite: true });
    assert.throws(() => envFail.ctx.migrateSecretsToProperties());
    assert.strictEqual(envFail.sheets.get('Config')._data[1][1], envFail.pin);
    assert.strictEqual(envFail.sheets.get('Config')._data[2][1], envFail.salt);

    const env = makeEnv();
    const mig = env.ctx.migrateSecretsToProperties();
    assert.strictEqual(mig.ok, true);
    assert.strictEqual(env.scriptProps.get('USHER_PIN'), env.pin);
    assert.strictEqual(env.scriptProps.get('SECRET_SALT'), env.salt);
    assert.strictEqual(env.scriptProps.get('V1_COMPAT_EVENT_ID'), 'DEFAULT');
    // Plaintext cells cleared after read-back verification
    assert.strictEqual(env.sheets.get('Config')._data[1][1], '');
    assert.strictEqual(env.sheets.get('Config')._data[2][1], '');

    // Rollback restoration
    const rest = env.ctx.restoreSecretsToConfigFromProperties();
    assert.strictEqual(rest.ok, true);
    assert.strictEqual(env.sheets.get('Config')._data[1][1], env.pin);
    assert.strictEqual(env.sheets.get('Config')._data[2][1], env.salt);
  }

  // 3. Secret rotation + LEGACY_SECRET_SALT dual verify (v1 & v2) + second rotation refusal + retirement
  {
    const env = makeEnv({
      eventId: 'DEFAULT',
      scriptProperties: { V1_COMPAT_EVENT_ID: 'DEFAULT', SECRET_SALT: '0123456789abcdef0123456789abcdef', USHER_PIN: '619482' }
    });
    const oldSalt = env.salt;
    const newSalt = 'fedcba9876543210fedcba9876543210';

    const oldV1 = v1Sig('202310001', oldSalt);
    const oldV2 = v2Sig('DEFAULT', '202310002', oldSalt);

    // Rotate once -> succeeds, stores oldSalt in LEGACY_SECRET_SALT
    env.ctx.rotateSecretSalt(newSalt);
    assert.strictEqual(env.scriptProps.get('SECRET_SALT'), newSalt);
    assert.strictEqual(env.scriptProps.get('LEGACY_SECRET_SALT'), oldSalt);

    // Second rotation while LEGACY_SECRET_SALT is populated -> REFUSED, original legacy key preserved
    assert.throws(() => env.ctx.rotateSecretSalt('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), /LEGACY_SECRET_SALT/i);
    assert.strictEqual(env.scriptProps.get('LEGACY_SECRET_SALT'), oldSalt);

    // Need fresh session token under new salt
    const sess2 = env.ctx.verifyUsherPin('619482', 'Gate A').sessionToken;

    // Both old v1 and old same-event v2 verify via LEGACY_SECRET_SALT
    assert.strictEqual(env.ctx.recordScan(sess2, `202310001|${oldV1}`, 'Check-In').status, 'OK');
    assert.strictEqual(env.ctx.recordScan(sess2, `v2|DEFAULT|202310002|${oldV2}`, 'Check-In').status, 'OK');

    // Cross-event v2 under LEGACY_SECRET_SALT still rejected
    const wrongV2Old = v2Sig('OTHER-EVT', '202310002', oldSalt);
    assert.strictEqual(env.ctx.recordScan(sess2, `v2|OTHER-EVT|202310002|${wrongV2Old}`, 'Mid-Event').status, 'REJECTED_WRONG_EVENT');

    // Retire legacy key -> old v1 and old v2 now rejected, new v2 accepted
    env.ctx.retireLegacySecretSalt();
    assert.strictEqual(env.ctx.recordScan(sess2, `202310001|${oldV1}`, 'Mid-Event').status, 'REJECTED_FORGED');
    assert.strictEqual(env.ctx.recordScan(sess2, `v2|DEFAULT|202310002|${oldV2}`, 'Mid-Event').status, 'REJECTED_FORGED');
    const newV2 = v2Sig('DEFAULT', '202310002', newSalt);
    assert.strictEqual(env.ctx.recordScan(sess2, `v2|DEFAULT|202310002|${newV2}`, 'Mid-Event').status, 'OK');
  }

  // 4. TARGET_EVENT_ID pre-issuance + readiness/reconciliation + resumable 7-step transition at EVERY boundary
  {
    const env = makeEnv({
      eventId: 'DEFAULT',
      scriptProperties: { V1_COMPAT_EVENT_ID: 'DEFAULT', SECRET_SALT: '0123456789abcdef0123456789abcdef', USHER_PIN: '619482' }
    });
    const { ctx, sheets, scriptProps, sessionToken, salt, gmailSentEmails } = env;

    // Reject DEFAULT or current active ID as TARGET_EVENT_ID
    assert.throws(() => ctx.setTargetEventId('DEFAULT'), /DEFAULT/i);
    assert.throws(() => ctx.setTargetEventId('BAD|ID'), /delimiter/i);

    ctx.setTargetEventId('CSSO-2026-ASSEMBLY');
    assert.strictEqual(scriptProps.get('TARGET_EVENT_ID'), 'CSSO-2026-ASSEMBLY');

    // Step 2 boundary: transition fails closed before target-event v2 issuance & reconciliation
    assert.throws(() => ctx.transitionToTargetEvent(), /readiness|issuance|acknowledge/i);
    assert.strictEqual(ctx.getConfig_().EVENT_ID, 'DEFAULT');
    assert.strictEqual(ctx.getConfig_().V1_COMPAT_RETIRED, false);

    // Issue target-event v2 passes via sendPasses_ (mode='TARGET') without changing active Config.EVENT_ID
    const issued = ctx.issueTargetEventV2Passes();
    assert.strictEqual(issued.ok, true);
    assert.strictEqual(issued.sent, 2);
    assert.strictEqual(ctx.getConfig_().EVENT_ID, 'DEFAULT');

    const roster = sheets.get('Roster');
    assert.strictEqual(roster._data[1][12], 'v2'); // Pass Protocol
    assert.strictEqual(roster._data[1][13], 'CSSO-2026-ASSEMBLY'); // Pass Event ID
    assert.ok(gmailSentEmails[0].body.includes(`v2|CSSO-2026-ASSEMBLY|202310001|${roster._data[1][4]}`));

    // Before activation: target v2 rejected, existing v1 still accepted
    const targetPayload1 = `v2|CSSO-2026-ASSEMBLY|202310001|${roster._data[1][4]}`;
    const targetPayload2 = `v2|CSSO-2026-ASSEMBLY|202310002|${roster._data[2][4]}`;
    assert.strictEqual(ctx.recordScan(sessionToken, targetPayload1, 'Check-In').status, 'REJECTED_WRONG_EVENT');
    assert.strictEqual(ctx.recordScan(sessionToken, `202310001|${v1Sig('202310001', salt)}`, 'Check-In').status, 'OK');

    // Reconciliation report lists DISPATCHED as unconfirmed until operator acknowledges
    const report = ctx.reconcileTargetEventDistribution();
    assert.strictEqual(report.readyToAcknowledge, true);
    assert.strictEqual(report.unresolvedRecipients.length, 2); // DISPATCHED != inbox delivery
    assert.throws(() => ctx.transitionToTargetEvent(), /acknowledge/i);

    // Acknowledge distribution, then mutate each issuance/distribution field -> invalidates acknowledgement
    const validReport = ctx.reconcileTargetEventDistribution();
    ctx.acknowledgeTargetDistribution(validReport.digest);
    const ackProp = scriptProps.get('TRANSITION_RECON_ACK');

    // Unchanged roster & dispatch state retains valid acknowledgement
    assert.strictEqual(ctx.reconcileTargetEventDistribution().digest, validReport.digest);
    assert.strictEqual(ackProp, `CSSO-2026-ASSEMBLY|${validReport.digest}`);

    // Test invalidation on Token, Pass Status, Pass Protocol, Pass Event ID, Attempt #, Dispatched At, Last Error
    const fieldMutations = [
      [4, 'TAMPERED'],
      [5, 'MAIL_API_ERROR'],
      [12, 'v1'],
      [13, 'OTHER-EVENT'],
      [9, 99],
      [10, '2026-11-23T19:00:00.000Z'],
      [11, 'Transient error']
    ];
    for (const [colIdx, badVal] of fieldMutations) {
      const orig = roster._data[1][colIdx];
      roster._data[1][colIdx] = badVal;
      const changed = ctx.reconcileTargetEventDistribution();
      assert.notStrictEqual(changed.digest, validReport.digest, `Digest did not change for col ${colIdx}`);
      assert.throws(() => ctx.transitionToTargetEvent(), /readiness|issuance|acknowledge/i);
      roster._data[1][colIdx] = orig;
    }

    // Re-verify unchanged state still matches original acknowledgement
    assert.strictEqual(ctx.reconcileTargetEventDistribution().digest, validReport.digest);

    // Interrupt after Step 5 (Config.EVENT_ID updated, EVENT_TRANSITION_PENDING still TRUE) -> resume verifies & clears pending
    scriptProps.set('EVENT_TRANSITION_PENDING', 'TRUE');
    scriptProps.set('V1_COMPAT_RETIRED', 'TRUE');
    sheets.get('Config')._data[4][1] = 'CSSO-2026-ASSEMBLY';
    const res = ctx.transitionToTargetEvent();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(ctx.getConfig_().EVENT_ID, 'CSSO-2026-ASSEMBLY');
    assert.strictEqual(scriptProps.get('V1_COMPAT_RETIRED'), 'TRUE');
    assert.strictEqual(scriptProps.get('EVENT_TRANSITION_PENDING') || null, null);

    // Step 7 idempotency: re-running transitionToTargetEvent() after completion succeeds deterministically without TRANSITION_RECON_ACK
    assert.strictEqual(scriptProps.get('TRANSITION_RECON_ACK') || null, null);
    const idemp = ctx.transitionToTargetEvent();
    assert.strictEqual(idemp.ok, true);
    assert.strictEqual(idemp.alreadyCompleted, true);
    assert.strictEqual(idemp.activeEventId, 'CSSO-2026-ASSEMBLY');
    assert.strictEqual(idemp.v1Retired, true);

    // After activation: target v2 accepted, old DEFAULT v2 & v1 rejected
    assert.strictEqual(ctx.recordScan(sessionToken, targetPayload2, 'Check-In').status, 'OK');
    assert.strictEqual(ctx.recordScan(sessionToken, `v2|DEFAULT|202310002|${v2Sig('DEFAULT', '202310002', salt)}`, 'Mid-Event').status, 'REJECTED_WRONG_EVENT');

    // Ordinary issuance after retirement uses v2 for active event, never v1
    roster._data.push(['202699999', 'new@cvsu.edu.ph', 'New Student', 'BSCS 1-1', '', '', '', '', '', '', '', '', '', '']);
    ctx.generateAndEmailQRPasses();
    assert.strictEqual(roster._data[3][12], 'v2');
    assert.strictEqual(roster._data[3][13], 'CSSO-2026-ASSEMBLY');
    assert.strictEqual(roster._data[3][4], v2Sig('CSSO-2026-ASSEMBLY', '202699999', salt));

    // Attempted reactivation by restoring Config.EVENT_ID = DEFAULT -> v1 STILL permanently rejected
    sheets.get('Config')._data[4][1] = 'DEFAULT';
    assert.strictEqual(ctx.recordScan(sessionToken, `202310002|${v1Sig('202310002', salt)}`, 'Mid-Event').status, 'REJECTED_V1_RETIRED');

    // Isolated Step 3 boundary: EVENT_TRANSITION_PENDING=TRUE, V1_COMPAT_RETIRED unset, Config.EVENT_ID=DEFAULT
    {
      const env3 = makeEnv({ eventId: 'DEFAULT', scriptProperties: { V1_COMPAT_EVENT_ID: 'DEFAULT', TARGET_EVENT_ID: 'CSSO-STEP3', SECRET_SALT: salt, USHER_PIN: '619482' } });
      env3.ctx.issueTargetEventV2Passes();
      env3.ctx.acknowledgeTargetDistribution(env3.ctx.reconcileTargetEventDistribution().digest);
      env3.scriptProps.set('EVENT_TRANSITION_PENDING', 'TRUE');
      assert.strictEqual(env3.ctx.getConfig_().V1_COMPAT_RETIRED, false);
      const r3 = env3.ctx.transitionToTargetEvent();
      assert.strictEqual(r3.ok, true);
      assert.strictEqual(env3.ctx.getConfig_().EVENT_ID, 'CSSO-STEP3');
      assert.strictEqual(env3.scriptProps.get('V1_COMPAT_RETIRED'), 'TRUE');
      assert.strictEqual(env3.scriptProps.get('EVENT_TRANSITION_PENDING') || null, null);
    }

    // Isolated Step 4 boundary: EVENT_TRANSITION_PENDING=TRUE, V1_COMPAT_RETIRED=TRUE, Config.EVENT_ID=DEFAULT
    {
      const env4 = makeEnv({ eventId: 'DEFAULT', scriptProperties: { V1_COMPAT_EVENT_ID: 'DEFAULT', TARGET_EVENT_ID: 'CSSO-STEP4', SECRET_SALT: salt, USHER_PIN: '619482' } });
      env4.ctx.issueTargetEventV2Passes();
      env4.ctx.acknowledgeTargetDistribution(env4.ctx.reconcileTargetEventDistribution().digest);
      env4.scriptProps.set('EVENT_TRANSITION_PENDING', 'TRUE');
      env4.scriptProps.set('V1_COMPAT_RETIRED', 'TRUE');
      assert.strictEqual(env4.ctx.recordScan(env4.sessionToken, `202310001|${v1Sig('202310001', salt)}`, 'Check-In').status, 'REJECTED_V1_RETIRED');
      const r4 = env4.ctx.transitionToTargetEvent();
      assert.strictEqual(r4.ok, true);
      assert.strictEqual(env4.ctx.getConfig_().EVENT_ID, 'CSSO-STEP4');
      assert.strictEqual(env4.scriptProps.get('EVENT_TRANSITION_PENDING') || null, null);
    }

    // Row-shift protection during target-event issuance
    {
      const envShift = makeEnv({
        eventId: 'DEFAULT',
        scriptProperties: {
          V1_COMPAT_EVENT_ID: 'DEFAULT',
          TARGET_EVENT_ID: 'CSSO-2026-ASSEMBLY',
          SECRET_SALT: '0123456789abcdef0123456789abcdef',
          USHER_PIN: '619482'
        }
      });
      const origSleep = envShift.ctx.Utilities.sleep;
      envShift.ctx.Utilities.sleep = () => {
        envShift.sheets.get('Roster')._data[1][0] = '999999999';
      };
      envShift.ctx.issueTargetEventV2Passes();
      envShift.ctx.Utilities.sleep = origSleep;
      assert.ok(!envShift.sheets.get('Roster')._data[1][12]);
      assert.ok(envShift.uiAlerts.some(a => /shifted|mismatch/i.test(String(a.body))));
    }

    // Step 1 boundary: missing TARGET_EVENT_ID fails closed without changing Config or retiring v1
    {
      const env1 = makeEnv({ eventId: 'DEFAULT', scriptProperties: { V1_COMPAT_EVENT_ID: 'DEFAULT', SECRET_SALT: salt, USHER_PIN: '619482' } });
      assert.throws(() => env1.ctx.transitionToTargetEvent(), /TARGET_EVENT_ID/i);
      assert.strictEqual(env1.ctx.getConfig_().V1_COMPAT_RETIRED, false);
    }

    // Step 6 boundary: if self-verification fails, EVENT_TRANSITION_PENDING stays TRUE until resolved
    {
      const env6 = makeEnv({
        eventId: 'DEFAULT',
        scriptProperties: { V1_COMPAT_EVENT_ID: 'DEFAULT', TARGET_EVENT_ID: 'CSSO-2026-FAIL', SECRET_SALT: salt, USHER_PIN: '619482' }
      });
      env6.ctx.issueTargetEventV2Passes();
      env6.ctx.acknowledgeTargetDistribution(env6.ctx.reconcileTargetEventDistribution().digest);
      const origVerify = env6.ctx.verifyV2Signature_;
      env6.ctx.verifyV2Signature_ = () => false;
      assert.throws(() => env6.ctx.transitionToTargetEvent(), /verification failed/i);
      assert.strictEqual(env6.scriptProps.get('EVENT_TRANSITION_PENDING'), 'TRUE');
      assert.strictEqual(env6.scriptProps.get('V1_COMPAT_RETIRED'), 'TRUE');
      // Resume after fixing verification -> clears pending cleanly
      env6.ctx.verifyV2Signature_ = origVerify;
      assert.strictEqual(env6.ctx.transitionToTargetEvent().ok, true);
      assert.strictEqual(env6.scriptProps.get('EVENT_TRANSITION_PENDING') || null, null);
    }
  }

  console.log('PASS: crypto-migration.test.js');
}

run();

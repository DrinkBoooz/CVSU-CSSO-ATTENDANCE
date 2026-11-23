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

  // 4. TARGET_EVENT_ID pre-issuance + resumable 7-step EVENT_TRANSITION_PENDING + irreversible V1_COMPAT_RETIRED
  {
    const env = makeEnv({
      eventId: 'DEFAULT',
      scriptProperties: { V1_COMPAT_EVENT_ID: 'DEFAULT', SECRET_SALT: '0123456789abcdef0123456789abcdef', USHER_PIN: '619482' }
    });
    const { ctx, sheets, scriptProps, sessionToken, salt } = env;

    // Reject DEFAULT or current active ID as TARGET_EVENT_ID
    assert.throws(() => ctx.setTargetEventId('DEFAULT'), /DEFAULT/i);
    assert.throws(() => ctx.setTargetEventId('BAD|ID'), /delimiter/i);

    ctx.setTargetEventId('CSSO-2026-ASSEMBLY');
    assert.strictEqual(scriptProps.get('TARGET_EVENT_ID'), 'CSSO-2026-ASSEMBLY');

    // Issue target-event v2 passes without changing active Config.EVENT_ID
    const targetV2_1 = v2Sig('CSSO-2026-ASSEMBLY', '202310001', salt);
    const targetV2_2 = v2Sig('CSSO-2026-ASSEMBLY', '202310002', salt);
    assert.strictEqual(ctx.getConfig_().EVENT_ID, 'DEFAULT');

    // Before activation: target v2 rejected, existing v1 still accepted
    assert.strictEqual(ctx.recordScan(sessionToken, `v2|CSSO-2026-ASSEMBLY|202310001|${targetV2_1}`, 'Check-In').status, 'REJECTED_WRONG_EVENT');
    assert.strictEqual(ctx.recordScan(sessionToken, `202310001|${v1Sig('202310001', salt)}`, 'Check-In').status, 'OK');

    // Simulate interruption right after Step 4 (V1_COMPAT_RETIRED = TRUE, before Config.EVENT_ID updated)
    scriptProps.set('EVENT_TRANSITION_PENDING', 'TRUE');
    scriptProps.set('V1_COMPAT_RETIRED', 'TRUE');

    // While retired, v1 is rejected even though Config.EVENT_ID is still DEFAULT
    assert.strictEqual(ctx.recordScan(sessionToken, `202310002|${v1Sig('202310002', salt)}`, 'Check-In').status, 'REJECTED_V1_RETIRED');

    // Resume transition -> completes Steps 5-7 cleanly
    const res = ctx.transitionToTargetEvent();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(ctx.getConfig_().EVENT_ID, 'CSSO-2026-ASSEMBLY');
    assert.strictEqual(scriptProps.get('V1_COMPAT_RETIRED'), 'TRUE');
    assert.strictEqual(scriptProps.get('EVENT_TRANSITION_PENDING') || null, null);

    // After activation: target v2 accepted, old DEFAULT v2 & v1 rejected
    assert.strictEqual(ctx.recordScan(sessionToken, `v2|CSSO-2026-ASSEMBLY|202310002|${targetV2_2}`, 'Check-In').status, 'OK');
    assert.strictEqual(ctx.recordScan(sessionToken, `v2|DEFAULT|202310002|${v2Sig('DEFAULT', '202310002', salt)}`, 'Mid-Event').status, 'REJECTED_WRONG_EVENT');

    // Attempted reactivation by restoring Config.EVENT_ID = DEFAULT -> v1 STILL permanently rejected
    sheets.get('Config')._data[4][1] = 'DEFAULT';
    assert.strictEqual(ctx.recordScan(sessionToken, `202310002|${v1Sig('202310002', salt)}`, 'Mid-Event').status, 'REJECTED_V1_RETIRED');
  }

  console.log('PASS: crypto-migration.test.js');
}

run();

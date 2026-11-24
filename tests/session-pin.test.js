'use strict';

const assert = require('assert');
const { loadCode } = require('./helpers/gas-mock');

function run() {
  const salt = '0123456789abcdef0123456789abcdef';

  // 1. Weak PIN (< 6 digits) refused
  {
    const { ctx } = loadCode({
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '4829'],
          ['SECRET_SALT', salt]
        ]
      }
    });
    const res = ctx.verifyUsherPin('4829', 'Gate A');
    assert.strictEqual(res.ok, false);
    assert.match(res.message, /not configured|6-digit/i);
  }

  // 2. Valid PIN issues HMAC-signed session token, getScannerState validates it
  {
    const { ctx, sheets } = loadCode({
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '742915'],
          ['SECRET_SALT', salt],
          ['EVENT_TITLE', 'CSSO Assembly'],
          ['EVENT_ID', 'ASSY-2026'],
          ['LOCKED_STAGE', 'Mid-Event']
        ]
      }
    });

    const bad = ctx.verifyUsherPin('000000', 'Gate A');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.message, 'Incorrect Usher PIN.');

    const ok = ctx.verifyUsherPin('742915', 'Gate A - Marco');
    assert.strictEqual(ok.ok, true);
    assert.ok(ok.sessionToken && ok.sessionToken.includes('.'));
    assert.strictEqual(ok.eventTitle, 'CSSO Assembly');
    assert.strictEqual(ok.eventId, 'ASSY-2026');
    assert.strictEqual(ok.lockedStage, 'Mid-Event');

    const state = ctx.getScannerState(ok.sessionToken);
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.eventId, 'ASSY-2026');
    assert.strictEqual(state.lockedStage, 'Mid-Event');

    // Tampered token rejected
    const tampered = ctx.getScannerState(ok.sessionToken + 'X');
    assert.strictEqual(tampered.ok, false);
    assert.strictEqual(tampered.status, 'UNAUTHORIZED');

    // Rotating USHER_PIN in Config instantly revokes old session tokens
    sheets.get('Config')._data[1][1] = '999888';
    const revoked = ctx.getScannerState(ok.sessionToken);
    assert.strictEqual(revoked.ok, false);
    assert.strictEqual(revoked.status, 'UNAUTHORIZED');
  }

  // 3. Repeated wrong PINs apply bounded delay + warning without global gate DoS lockout
  {
    const { ctx, sleeps } = loadCode({
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '742915'],
          ['SECRET_SALT', salt]
        ]
      }
    });
    for (let i = 0; i < 20; i++) {
      const r = ctx.verifyUsherPin('111111', 'Attacker');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.message, 'Incorrect Usher PIN.');
    }
    assert.strictEqual(sleeps.length, 20);
    assert.strictEqual(sleeps[0], 1500);
    assert.strictEqual(sleeps[9], 3000);
    assert.strictEqual(sleeps[19], 5000);
    // Legitimate usher with valid PIN is NOT globally locked out and gets 0ms delay
    const legit = ctx.verifyUsherPin('742915', 'Legit');
    assert.strictEqual(legit.ok, true);
    assert.strictEqual(sleeps.length, 20);
  }

  // 4. Non-secret Config caching (when secrets migrated): never caches secrets, invalidates on Config edit
  {
    const { ctx, sheets, cache } = loadCode({
      scriptProperties: { USHER_PIN: '742915', SECRET_SALT: salt },
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['EVENT_TITLE', 'Cached Event'],
          ['EVENT_ID', '02-2027-CSSO-GA'],
          ['LOCKED_STAGE', 'AUTO']
        ]
      }
    });
    const c1 = ctx.getConfig_();
    assert.strictEqual(c1.EVENT_ID, '02-2027-CSSO-GA');
    assert.strictEqual(c1.USHER_PIN, '742915');
    const cachedRaw = cache.get('config_public_v1');
    assert.ok(cachedRaw, 'public Config should be cached when secrets are migrated');
    assert.strictEqual(cachedRaw.includes('742915'), false, 'USHER_PIN must never be cached');
    assert.strictEqual(cachedRaw.includes(salt), false, 'SECRET_SALT must never be cached');

    // Direct sheet edit + onSheetEdit invalidates Config cache immediately
    sheets.get('Config')._data[3][1] = 'Check-In';
    ctx.onSheetEdit({ range: { getSheet: () => sheets.get('Config'), getRow: () => 4 } });
    assert.strictEqual(cache.get('config_public_v1'), null);
    assert.strictEqual(ctx.getConfig_().LOCKED_STAGE, 'Check-In');
  }

  console.log('PASS: session-pin.test.js');
}

run();

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

  // 3. Throttling after 15 failed attempts in 2 minutes
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
    for (let i = 0; i < 15; i++) {
      const r = ctx.verifyUsherPin('111111', 'Attacker');
      assert.strictEqual(r.ok, false);
    }
    assert.ok(sleeps.length >= 15);
    const throttled = ctx.verifyUsherPin('742915', 'Legit');
    assert.strictEqual(throttled.ok, false);
    assert.match(throttled.message, /too many/i);
  }

  console.log('PASS: session-pin.test.js');
}

run();

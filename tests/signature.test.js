'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { loadCode } = require('./helpers/gas-mock');

function run() {
  const { ctx } = loadCode({
    sheets: {
      Config: [
        ['Key', 'Value'],
        ['USHER_PIN', '839201'],
        ['SECRET_SALT', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'],
        ['EVENT_TITLE', 'CSSO Test Event']
      ]
    }
  });

  // createSignature_ matches first 10 uppercase hex chars of SHA-256(ID|salt)
  const salt = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  const expected = crypto.createHash('sha256').update(`202310001|${salt}`).digest('hex').substring(0, 10).toUpperCase();
  assert.strictEqual(ctx.createSignature_('202310001', salt), expected);
  assert.strictEqual(ctx.createSignature_('  202310001 ', salt), expected);

  // normalizeId_ strips spaces/punctuation and uppercases
  assert.strictEqual(ctx.normalizeId_(' 2023-10001 '), '202310001');
  assert.strictEqual(ctx.normalizeId_('csso_01a'), 'CSSO01A');
  assert.strictEqual(ctx.normalizeId_(''), '');

  // safeCell_ prefixes formula-triggering characters
  assert.strictEqual(ctx.safeCell_('=IMPORTXML("x","y")'), "'=IMPORTXML(\"x\",\"y\")");
  assert.strictEqual(ctx.safeCell_('+1234'), "'+1234");
  assert.strictEqual(ctx.safeCell_('-SUM(A1)'), "'-SUM(A1)");
  assert.strictEqual(ctx.safeCell_('@evil'), "'@evil");
  assert.strictEqual(ctx.safeCell_('Gate A - Marco'), 'Gate A - Marco');

  // requireSecureConfig_ rejects placeholder salt and < 6 digit PIN
  assert.throws(() => ctx.requireSecureConfig_({
    USHER_PIN: '839201',
    SECRET_SALT: 'REPLACE_WITH_A_STRONG_RANDOM_SECRET_2026'
  }), /SECRET_SALT/i);

  assert.throws(() => ctx.requireSecureConfig_({
    USHER_PIN: '4829',
    SECRET_SALT: salt
  }), /USHER_PIN/i);

  assert.doesNotThrow(() => ctx.requireSecureConfig_({
    USHER_PIN: '839201',
    SECRET_SALT: salt
  }));

  console.log('PASS: signature.test.js');
}

run();

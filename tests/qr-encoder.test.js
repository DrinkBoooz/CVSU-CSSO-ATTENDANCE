'use strict';

const assert = require('assert');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const { loadCode } = require('./helpers/gas-mock');

function decodeQrFromBlob(blob) {
  const signedBytes = blob.getBytes();
  const buf = Buffer.from(signedBytes.map(b => b & 0xff));

  // Verify PNG magic signature
  assert.strictEqual(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'Invalid PNG signature');
  assert.strictEqual(blob.getContentType(), 'image/png');

  const png = PNG.sync.read(buf);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(decoded && decoded.data, 'Independent jsQR decoder failed to decode generated PNG');
  return decoded.data;
}

function run() {
  const { ctx } = loadCode({});

  const payloads = [
    '202310001|554A00119D',
    'v2|CSSO-2026-ASSEMBLY|202310001|0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF'
  ];

  for (const p of payloads) {
    const blob = ctx.generateQrPngBlob_(p, 'Pass_Test.png');
    const decoded = decodeQrFromBlob(blob);
    assert.strictEqual(decoded, p, 'Decoded QR payload must match input byte-for-byte');
  }

  assert.throws(() => ctx.generateQrPngBlob_(''), /empty/i);
  console.log('PASS: qr-encoder.test.js');
}

run();

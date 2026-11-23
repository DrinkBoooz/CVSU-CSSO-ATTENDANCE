'use strict';

const assert = require('assert');
const { loadCode } = require('./helpers/gas-mock');

function run() {
  const salt = '11223344556677881122334455667788';

  // 1. Batch write via GmailApp, per-row error handling, DISPATCHED status, HTML + plain-text fallback
  {
    const { ctx, sheets, gmailSentEmails } = loadCode({
      emailQuota: 10,
      failEmails: ['bad@cvsu.edu.ph'],
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '619482'],
          ['SECRET_SALT', salt],
          ['EVENT_TITLE', 'CSSO <2026>']
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status', 'QR Preview', 'Last Sent Token', 'Last Sent ID', 'Attempt #', 'Dispatched At', 'Last Error'],
          ['202310001', 'ok1@cvsu.edu.ph', 'Juan <script>x</script>', 'BSCS 4-2', '', '', '', '', '', '', '', ''],
          ['202310002', 'bad@cvsu.edu.ph', 'Bad Email', 'BSCS 4-2', '', '', '', '', '', '', '', ''],
          ['202310003', 'ok3@cvsu.edu.ph', 'Already Sent', 'BSCS 4-2', 'EXISTING01', 'SENT', '', '', '', '', '', ''],
          ['202310004', 'ok4@cvsu.edu.ph', 'Maria Santos', 'BSCS 4-1', '', '', '', '', '', '', '', ''],
          ['202310005', 'not-an-email', 'Bad Format', 'BSCS 4-1', '', '', '', '', '', '', '', '']
        ]
      }
    });

    ctx.generateAndEmailQRPasses();

    const roster = sheets.get('Roster');
    assert.strictEqual(roster._stats.setValueCalls, 0);
    assert.ok(roster._stats.setValuesCalls >= 1);

    assert.strictEqual(gmailSentEmails.length, 2);
    assert.strictEqual(roster._data[1][5], 'DISPATCHED');
    assert.strictEqual(roster._data[2][5], 'MAIL_API_ERROR');
    assert.strictEqual(roster._data[3][5], 'SENT'); // legacy SENT skipped in bulk
    assert.strictEqual(roster._data[4][5], 'DISPATCHED');
    assert.strictEqual(roster._data[5][5], 'INVALID_EMAIL');

    // Attempt counter & Last Sent Token / ID tracked
    assert.strictEqual(roster._data[1][9], 1);
    assert.ok(roster._data[1][10]); // Dispatched At timestamp
    assert.strictEqual(roster._data[1][7], roster._data[1][4]);
    assert.strictEqual(roster._data[1][8], '202310001');

    // HTML escaped, plain-text body present, & QR inline image attached
    const tok1 = roster._data[1][4];
    assert.ok(!gmailSentEmails[0].htmlBody.includes('<script>'));
    assert.ok(gmailSentEmails[0].htmlBody.includes('&lt;script&gt;'));
    assert.ok(gmailSentEmails[0].htmlBody.includes(`202310001|${tok1}`));
    assert.ok(gmailSentEmails[0].body.includes(`202310001|${tok1}`));
    assert.ok(gmailSentEmails[0].inlineImages.qrpass);
  }

  // 2. sendQRPassesToSelectedRows requires confirmation (aborts on NO, sends on YES)
  {
    const { ctx, sheets, gmailSentEmails } = loadCode({
      emailQuota: 10,
      activeSheet: 'Roster',
      uiConfirmResponse: 'NO',
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '619482'],
          ['SECRET_SALT', salt],
          ['EVENT_TITLE', 'CSSO Event']
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status'],
          ['202310001', 'a@cvsu.edu.ph', 'Row 2', 'BSCS 4-2', '', 'SENT'],
          ['202310002', 'b@cvsu.edu.ph', 'Row 3', 'BSCS 4-2', '', '']
        ]
      }
    });
    sheets.get('Roster').setActiveRange(2, 1);
    const cancelled = ctx.sendQRPassesToSelectedRows();
    assert.strictEqual(cancelled.reason, 'CANCELLED');
    assert.strictEqual(gmailSentEmails.length, 0);
  }

  {
    const { ctx, sheets, gmailSentEmails } = loadCode({
      emailQuota: 10,
      activeSheet: 'Roster',
      uiConfirmResponse: 'YES',
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '619482'],
          ['SECRET_SALT', salt],
          ['EVENT_TITLE', 'CSSO Event']
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status'],
          ['202310001', 'a@cvsu.edu.ph', 'Row 2', 'BSCS 4-2', '', ''],
          ['202310002', 'b@cvsu.edu.ph', 'Row 3', 'BSCS 4-2', '', '']
        ]
      }
    });

    sheets.get('Roster').setActiveRange(3, 1);
    ctx.sendQRPassesToSelectedRows();
    assert.strictEqual(gmailSentEmails.length, 1);
    assert.strictEqual(gmailSentEmails[0].to, 'b@cvsu.edu.ph');
    assert.strictEqual(sheets.get('Roster')._data[1][5], '');
    assert.strictEqual(sheets.get('Roster')._data[2][5], 'DISPATCHED');
  }

  // 3. QR generation failure marks QR_GEN_FAILED without calling GmailApp
  {
    const { ctx, sheets, gmailSentEmails } = loadCode({
      emailQuota: 10,
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '619482'],
          ['SECRET_SALT', salt]
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status'],
          ['202310001', 'a@cvsu.edu.ph', 'Row 2', 'BSCS 4-2', '', '']
        ]
      }
    });
    ctx.generateQrPngBlob_ = () => { throw new Error('Encoder failure'); };
    ctx.generateAndEmailQRPasses();
    assert.strictEqual(gmailSentEmails.length, 0);
    assert.strictEqual(sheets.get('Roster')._data[1][5], 'QR_GEN_FAILED');
  }

  // 4. Row-shift guard prevents overwriting shifted student rows
  {
    const { ctx, sheets, uiAlerts } = loadCode({
      emailQuota: 10,
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '619482'],
          ['SECRET_SALT', salt]
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status'],
          ['202310001', 'a@cvsu.edu.ph', 'Row 2', 'BSCS 4-2', '', '']
        ]
      }
    });
    const origSleep = ctx.Utilities.sleep;
    ctx.Utilities.sleep = () => {
      // Simulate another editor inserting a row at top of Roster mid-run
      sheets.get('Roster')._data[1][0] = '999999999';
    };
    ctx.generateAndEmailQRPasses();
    ctx.Utilities.sleep = origSleep;
    assert.strictEqual(sheets.get('Roster')._data[1][5], ''); // shifted row NOT overwritten
    assert.ok(uiAlerts.some(a => /mismatch|shifted/i.test(String(a.body))));
  }

  // 5. Quota limit stops cleanly; lock prevents concurrent run
  {
    const { ctx, gmailSentEmails, lock, uiAlerts } = loadCode({
      emailQuota: 1,
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '619482'],
          ['SECRET_SALT', salt]
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status'],
          ['202310001', 'a@cvsu.edu.ph', 'A', 'S', '', ''],
          ['202310002', 'b@cvsu.edu.ph', 'B', 'S', '', '']
        ]
      }
    });

    ctx.generateAndEmailQRPasses();
    assert.strictEqual(gmailSentEmails.length, 1);

    lock._setHeld(true);
    ctx.generateAndEmailQRPasses();
    assert.ok(uiAlerts.some(a => /already running|busy/i.test(String(a.title) + ' ' + String(a.body))));
  }

  console.log('PASS: email.test.js');
}

run();

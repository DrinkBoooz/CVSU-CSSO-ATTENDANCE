'use strict';

const assert = require('assert');
const { loadCode } = require('./helpers/gas-mock');

function run() {
  const salt = '11223344556677881122334455667788';

  // 1. Batch write, per-row error handling, HTML escaping, plain-text fallback code
  {
    const { ctx, sheets, sentEmails } = loadCode({
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
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status', 'QR Preview'],
          ['202310001', 'ok1@cvsu.edu.ph', 'Juan <script>x</script>', 'BSCS 4-2', '', '', ''],
          ['202310002', 'bad@cvsu.edu.ph', 'Bad Email', 'BSCS 4-2', '', '', ''],
          ['202310003', 'ok3@cvsu.edu.ph', 'Already Sent', 'BSCS 4-2', 'EXISTING01', 'SENT', ''],
          ['202310004', 'ok4@cvsu.edu.ph', 'Maria Santos', 'BSCS 4-1', '', '', '']
        ]
      }
    });

    ctx.generateAndEmailQRPasses();

    const roster = sheets.get('Roster');
    // Zero per-row setValue calls; single batch setValues call
    assert.strictEqual(roster._stats.setValueCalls, 0);
    assert.strictEqual(roster._stats.setValuesCalls, 1);

    assert.strictEqual(sentEmails.length, 2);
    assert.strictEqual(roster._data[1][5], 'SENT');
    assert.match(roster._data[2][5], /^ERROR:/);
    assert.strictEqual(roster._data[3][5], 'SENT');
    assert.strictEqual(roster._data[4][5], 'SENT');

    // HTML escaped & plain-text ID|TOKEN included in email body
    const tok1 = roster._data[1][4];
    assert.ok(!sentEmails[0].htmlBody.includes('<script>'));
    assert.ok(sentEmails[0].htmlBody.includes('&lt;script&gt;'));
    assert.ok(sentEmails[0].htmlBody.includes(`202310001|${tok1}`));
  }

  // 2. sendQRPassesToSelectedRows only emails selected rows
  {
    const { ctx, sheets, sentEmails } = loadCode({
      emailQuota: 10,
      activeSheet: 'Roster',
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

    sheets.get('Roster').setActiveRange(3, 1); // select only Row 3 (202310002)
    ctx.sendQRPassesToSelectedRows();
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].to, 'b@cvsu.edu.ph');
    assert.strictEqual(sheets.get('Roster')._data[1][5], '');
    assert.strictEqual(sheets.get('Roster')._data[2][5], 'SENT');
  }

  // 3. Quota limit stops cleanly; lock prevents concurrent run
  {
    const { ctx, sentEmails, lock, uiAlerts } = loadCode({
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
    assert.strictEqual(sentEmails.length, 1);

    // Concurrent lock held -> refused
    lock._setHeld(true);
    ctx.generateAndEmailQRPasses();
    assert.ok(uiAlerts.some(a => /already running|busy/i.test(String(a.title) + ' ' + String(a.body))));
  }

  console.log('PASS: email.test.js');
}

run();

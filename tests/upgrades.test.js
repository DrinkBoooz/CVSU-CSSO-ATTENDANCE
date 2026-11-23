'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { loadCode } = require('./helpers/gas-mock');

function run() {
  const salt = 'fedcba9876543210fedcba9876543210';

  // 1. applyAllSystemUpgrades: headers, @ format, token backfill, preserves custom conditional rules, installs triggers
  {
    const env = loadCode({
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '619482'],
          ['SECRET_SALT', salt],
          ['EVENT_TITLE', 'CSSO Day']
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status', 'QR Preview'],
          ['002310001', 'a@cvsu.edu.ph', 'Juan Dela Cruz', 'BSCS 4-2', '', '', '']
        ],
        'Attendance Log': [
          ['Timestamp', 'Stage', 'Student ID', 'Full Name', 'Section', 'Usher Label', 'Scan Status']
        ],
        'Verified Attendance': [
          ['Student ID', 'Full Name', 'Section', 'Check-In', 'Mid-Event', 'Check-Out', 'Qualification']
        ]
      }
    });

    // Add a custom user conditional format rule on Attendance Log Col A (col 1) that MUST be preserved
    const logSheet = env.sheets.get('Attendance Log');
    const customRule = env.ctx.SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('CUSTOM')
      .setBackground('#eeeeee')
      .setRanges([logSheet.getRange(2, 1, 10, 1)])
      .build();
    logSheet.setConditionalFormatRules([customRule]);

    env.ctx.applyAllSystemUpgrades();

    // Event ID & Stage Count headers repaired
    assert.strictEqual(logSheet._data[0][7], 'Event ID');
    assert.strictEqual(env.sheets.get('Verified Attendance')._data[0][7], 'Stage Count');

    // Token backfilled without writing third-party quickchart URL to Col G
    const roster = env.sheets.get('Roster');
    assert.strictEqual(roster._data[1][4], env.ctx.createSignature_('002310001', salt));
    assert.strictEqual(roster._data[1][6], '');

    // Custom rule on Col A preserved alongside Col G rules
    const keptCustom = logSheet.getConditionalFormatRules().some(
      r => r.getRanges().some(rng => rng.getColumn() === 1)
    );
    assert.strictEqual(keptCustom, true);

    // Alert shown
    assert.strictEqual(env.uiAlerts.length, 1);
    assert.match(env.uiAlerts[0].title, /System Upgrades Complete/);
  }

  // 2. auditRosterIntegrity_: detects duplicate normalized IDs, invalid emails, missing names, and token drift
  {
    const tokValid = crypto.createHash('sha256').update(`2023-10001|${salt}`).digest('hex').substring(0, 10).toUpperCase();
    const env = loadCode({
      sheets: {
        Config: [
          ['Key', 'Value'],
          ['USHER_PIN', '619482'],
          ['SECRET_SALT', salt]
        ],
        Roster: [
          ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status', 'QR Preview', 'Last Sent Token', 'Last Sent ID'],
          ['2023-10001', 'a@cvsu.edu.ph', 'Juan Dela Cruz', 'BSCS 4-2', tokValid, 'SENT', '', tokValid, '2023-10001'],
          ['202310001', 'bad-email', '', 'BSCS 4-2', 'OLDTOKEN00', 'SENT', '', 'OLDTOKEN00', '202310000']
        ]
      }
    });

    const audit = env.ctx.auditRosterIntegrity_(env.ss);
    assert.strictEqual(audit.duplicateIds.length, 1);
    assert.strictEqual(audit.duplicateIds[0].normId, '202310001');
    assert.strictEqual(audit.invalidEmails.length, 1);
    assert.strictEqual(audit.missingNames.length, 1);
    assert.strictEqual(audit.tokenDrift.length, 1);
    assert.strictEqual(audit.tokenDrift[0].reason, 'TOKEN_DRIFT_ID_CHANGED');
  }

  console.log('PASS: upgrades.test.js');
}

run();

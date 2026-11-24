'use strict';

const assert = require('assert');
const { loadCode } = require('./helpers/gas-mock');

function attachFormMock(env, opts = {}) {
  const formId = opts.formId || 'mock-form-123';
  const publishedUrl = opts.publishedUrl || `https://docs.google.com/forms/d/e/${formId}/viewform`;
  const editUrl = opts.editUrl || `https://docs.google.com/forms/d/${formId}/edit`;
  const textItems = [];

  const makeTextItem = (title = '') => {
    let itemTitle = title;
    const item = {
      getTitle: () => itemTitle,
      setTitle(t) { itemTitle = t; return item; },
      asTextItem() { return item; },
      setHelpText() { return item; },
      setRequired() { return item; },
      setValidation() { return item; }
    };
    return item;
  };

  let confirmationMessage = '';

  const mockForm = {
    getId: () => formId,
    setTitle() { return mockForm; },
    setDescription() { return mockForm; },
    setCollectEmail() { return mockForm; },
    setLimitOneResponsePerUser() { return mockForm; },
    setAllowResponseEdits() { return mockForm; },
    setRequireLogin() { return mockForm; },
    setConfirmationMessage(msg) { confirmationMessage = String(msg || ''); return mockForm; },
    getItems: () => textItems,
    addTextItem() {
      const it = makeTextItem();
      textItems.push(it);
      return it;
    },
    setDestination() {},
    getPublishedUrl: () => publishedUrl,
    getEditUrl: () => editUrl
  };

  env.ctx.FormApp = {
    ItemType: { TEXT: 'TEXT' },
    DestinationType: { SPREADSHEET: 'SPREADSHEET' },
    createTextValidation() {
      const v = {
        setHelpText() { return v; },
        requireTextMatchesPattern() { return v; },
        build() { return { type: 'regex' }; }
      };
      return v;
    },
    create: () => mockForm,
    openById(id) {
      if (id !== formId) throw new Error('Missing form ' + id);
      return mockForm;
    }
  };

  env.ss.getId = () => 'mock-ss-id';
  const origNewTrigger = env.ctx.ScriptApp.newTrigger;
  env.ctx.ScriptApp.newTrigger = (fn) => {
    const base = origNewTrigger(fn);
    const origForSs = base.forSpreadsheet;
    base.forSpreadsheet = (target) => {
      const inner = origForSs(target);
      inner.onFormSubmit = () => ({
        create() {
          const t = { getHandlerFunction: () => fn, eventType: 'ON_FORM_SUBMIT' };
          env.triggers.push(t);
          return t;
        }
      });
      return inner;
    };
    return base;
  };

  return {
    formId,
    publishedUrl,
    editUrl,
    getConfirmationMessage: () => confirmationMessage
  };
}

function makeFixture() {
  const salt = 'fedcba9876543210fedcba9876543210';
  const env = loadCode({
    sheets: {
      Config: [
        ['Key', 'Value', 'Notes'],
        ['USHER_PIN', '619482', ''],
        ['SECRET_SALT', salt, ''],
        ['EVENT_TITLE', 'CSSO Day', ''],
        ['EVENT_ID', 'CSSO-2026', ''],
        ['LOCKED_STAGE', 'AUTO', ''],
        ['ENFORCE_STAGE_ORDER', 'FALSE', '']
      ],
      Roster: [
        ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status', 'QR Preview', 'QR URL', 'Last Sent At', 'Attempts', 'Last Target', 'Last Error', 'Protocol', 'Event ID'],
        ['202310001', 'juan@cvsu.edu.ph', 'Juan Dela Cruz', 'BSCS 4-2', '', 'READY_ON_PORTAL', 'EXISTING_PREVIEW', '', '', 2, '', '', 'v2', 'CSSO-2026']
      ],
      'Attendance Log': [
        ['Timestamp', 'Stage', 'Student ID', 'Full Name', 'Section', 'Usher Label', 'Scan Status', 'Event ID']
      ],
      'Verified Attendance': [
        ['Student ID', 'Full Name', 'Section', 'Check-In', 'Mid-Event', 'Check-Out', 'Qualification', 'Stage Count']
      ]
    }
  });
  env.ctx.Utilities.base64Encode = (bytes) =>
    Buffer.from(bytes.map(b => b & 0xff)).toString('base64');
  return env;
}

function run() {
  // 1. onRegistrationFormSubmit enforces strict 1 submission per student (ID or Email)
  {
    const env = makeFixture();
    const { ctx, sheets } = env;
    const roster = sheets.get('Roster');

    // Duplicate by Student ID (different email attempting takeover) -> ignored
    ctx.onRegistrationFormSubmit({
      namedValues: {
        'Student ID': ['2023-10001'],
        'Email Address': ['attacker@gmail.com'],
        'Full Name': ['Spoofed Name'],
        'Section': ['BSCS 1-1']
      }
    });
    assert.strictEqual(roster.getLastRow(), 2);
    assert.strictEqual(roster._data[1][1], 'juan@cvsu.edu.ph');
    assert.strictEqual(roster._data[1][2], 'Juan Dela Cruz');
    assert.strictEqual(roster._data[1][6], 'EXISTING_PREVIEW');

    // Duplicate by Email (different Student ID from same email) -> ignored
    ctx.onRegistrationFormSubmit({
      namedValues: {
        'Student ID': ['202399999'],
        'Email Address': ['JUAN@CVSU.EDU.PH'],
        'Full Name': ['Another Attempt'],
        'Section': ['BSCS 1-1']
      }
    });
    assert.strictEqual(roster.getLastRow(), 2);

    // Brand new student -> appended cleanly
    ctx.onRegistrationFormSubmit({
      namedValues: {
        'Student ID': ['202310002'],
        'Email Address': ['maria@cvsu.edu.ph'],
        'Full Name': ['Maria Santos'],
        'Section': ['BSCS 4-2']
      }
    });
    assert.strictEqual(roster.getLastRow(), 3);
    assert.strictEqual(roster._data[2][0], '202310002');
    assert.strictEqual(roster._data[2][1], 'maria@cvsu.edu.ph');
    assert.strictEqual(roster._data[2][5], 'READY_ON_PORTAL');
    assert.strictEqual(roster._data[2][12], 'v2');
    assert.strictEqual(roster._data[2][13], 'CSSO-2026');
  }

  // 2. lookupStudentPass recovers from stale shard cache when admin fixes student's email in Roster
  {
    const env = makeFixture();
    const { ctx, sheets, cache } = env;

    // Warm shard cache with original email (juan@cvsu.edu.ph)
    const first = ctx.lookupStudentPass('202310001', 'juan@cvsu.edu.ph');
    assert.strictEqual(first.ok, true);

    // Admin directly fixes email in Roster sheet without cache invalidation firing
    sheets.get('Roster')._data[1][1] = 'juan.fixed@cvsu.edu.ph';

    // Lookup with corrected email must auto-refresh shard once, succeed, and leave no failure counter
    const recovered = ctx.lookupStudentPass('202310001', 'juan.fixed@cvsu.edu.ph');
    assert.strictEqual(recovered.ok, true);
    assert.strictEqual(recovered.studentId, '202310001');
    assert.strictEqual(cache.get('lookup_fail_202310001'), null);
  }

  // 3. setupRegistrationFormAndTrigger & applyAllSystemUpgrades store both Form URL and Edit URL in Config
  {
    const env = makeFixture();
    const formInfo = attachFormMock(env);
    const res = env.ctx.setupRegistrationFormAndTrigger();
    assert.strictEqual(res.ok, true);

    const configMap = () => new Map(
      env.sheets.get('Config')._data.slice(1).map(r => [String(r[0]), String(r[1])])
    );
    assert.strictEqual(configMap().get('REGISTRATION_FORM_URL'), formInfo.publishedUrl);
    assert.strictEqual(configMap().get('REGISTRATION_FORM_EDIT_URL'), formInfo.editUrl);

    // Remove Config rows and confirm applyAllSystemUpgrades restores REGISTRATION_FORM_EDIT_URL automatically
    env.sheets.get('Config')._data = env.sheets.get('Config')._data.filter(
      r => r[0] !== 'REGISTRATION_FORM_URL' && r[0] !== 'REGISTRATION_FORM_EDIT_URL'
    );
    env.ctx.applyAllSystemUpgrades();
    assert.strictEqual(configMap().get('REGISTRATION_FORM_URL'), formInfo.publishedUrl);
    assert.strictEqual(configMap().get('REGISTRATION_FORM_EDIT_URL'), formInfo.editUrl);
  }

  // 4. clearAttendanceLogsAndVerified clears Attendance Log & Verified Attendance while keeping Roster & Config
  {
    const env = makeFixture();
    const { ctx, sheets, cache } = env;
    sheets.get('Attendance Log').appendRow([new Date(), 'Check-In', '202310001', 'Juan Dela Cruz', 'BSCS 4-2', 'Gate A', 'ACCEPTED', 'CSSO-2026']);
    sheets.get('Verified Attendance').appendRow(['202310001', 'Juan Dela Cruz', 'BSCS 4-2', '08:00:00', '—', '—', 'INCOMPLETE', 1]);
    const seenKey = ctx.eventIndexCacheKey_('CSSO-2026');
    ctx.putEventSeenIndex_('CSSO-2026', { '202310001': 1 });
    assert.ok(cache.get(seenKey) !== null);

    const ui = ctx.SpreadsheetApp.getUi();
    ui.ButtonSet.OK_CANCEL = 'OK_CANCEL';
    let promptResponse = 'WRONG';
    ui.prompt = () => ({
      getSelectedButton: () => ui.Button.OK,
      getResponseText: () => promptResponse
    });

    // Wrong confirmation phrase -> cancelled, rows intact
    const cancelled = ctx.clearAttendanceLogsAndVerified();
    assert.strictEqual(cancelled.ok, false);
    assert.strictEqual(cancelled.reason, 'CANCELLED');
    assert.strictEqual(sheets.get('Attendance Log').getLastRow(), 2);
    assert.strictEqual(sheets.get('Verified Attendance').getLastRow(), 2);

    // Exact confirmation phrase CLEAR LOGS -> clears logs & verified, keeps Roster & Config
    promptResponse = 'CLEAR LOGS';
    const cleared = ctx.clearAttendanceLogsAndVerified();
    assert.strictEqual(cleared.ok, true);
    assert.strictEqual(cleared.cleared['Attendance Log'], 1);
    assert.strictEqual(cleared.cleared['Verified Attendance'], 1);
    assert.strictEqual(sheets.get('Attendance Log').getLastRow(), 1);
    assert.strictEqual(sheets.get('Verified Attendance').getLastRow(), 1);
    assert.strictEqual(sheets.get('Roster').getLastRow(), 2);
    assert.ok(sheets.get('Config').getLastRow() >= 7);
    assert.strictEqual(cache.get(seenKey), null);
  }

  // 5. onRegistrationFormSubmit handles lowercase "Email address", localized headers, and e.values fallback
  {
    const env = makeFixture();
    const { ctx, sheets } = env;
    const roster = sheets.get('Roster');

    // Google Forms standard header "Email address" (lowercase 'a')
    ctx.onRegistrationFormSubmit({
      namedValues: {
        'Student ID': ['202310003'],
        'Email address': ['lower@cvsu.edu.ph'],
        'Full Name': ['Lower Case'],
        'Section': ['BSCS 3-1']
      }
    });
    assert.strictEqual(roster.getLastRow(), 3);
    assert.strictEqual(roster._data[2][0], '202310003');
    assert.strictEqual(roster._data[2][1], 'lower@cvsu.edu.ph');

    // Unknown localized email header -> falls back to scanning e.values for an email
    ctx.onRegistrationFormSubmit({
      namedValues: {
        'Student ID': ['202310004'],
        'Direksyon ng Email': [''],
        'Full Name': ['Locale Fallback'],
        'Section': ['BSCS 3-2']
      },
      values: ['2026-11-24 13:00:00', 'fallback@cvsu.edu.ph', '202310004', 'Locale Fallback', 'BSCS 3-2']
    });
    assert.strictEqual(roster.getLastRow(), 4);
    assert.strictEqual(roster._data[3][0], '202310004');
    assert.strictEqual(roster._data[3][1], 'fallback@cvsu.edu.ph');
  }

  // 6. setupRegistrationFormAndTrigger embeds ?api= in confirmation URL when WEB_APP_URL is configured
  {
    const env = makeFixture();
    const stagingApi = 'https://script.google.com/macros/s/AKfycbxLriHe2_WYcfJKfomxmFurzQt78Bd-q4A40D7SngVwqArNYb-FxDmhSNJBbrm6CDgD/exec';
    env.sheets.get('Config').appendRow(['WEB_APP_URL', stagingApi, 'Staging Web App']);
    const formInfo = attachFormMock(env);

    const res = env.ctx.setupRegistrationFormAndTrigger();
    assert.strictEqual(res.ok, true);
    const expectedUrl = `https://drinkboooz.github.io/CVSU-CSSO-ATTENDANCE/pass.html?api=${encodeURIComponent(stagingApi)}`;
    assert.strictEqual(res.portalUrl, expectedUrl);
    assert.ok(formInfo.getConfirmationMessage().includes(expectedUrl));
  }

  console.log('PASS: form-portal.test.js');
}

run();

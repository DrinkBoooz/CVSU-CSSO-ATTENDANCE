const PLACEHOLDER_SALT = 'REPLACE_WITH_A_STRONG_RANDOM_SECRET_2026';
const VALID_STAGES = ['Check-In', 'Mid-Event', 'Check-Out'];
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const PIN_FAIL_KEY = 'pin_fail_count';
const PIN_FAIL_WINDOW_SEC = 120; // 2 minutes
const PIN_FAIL_MAX = 15;
const ROSTER_CACHE_KEY = 'roster_map_v1';
const ROSTER_CACHE_TTL_SEC = 300; // 5 minutes
const EMAIL_TIME_BUDGET_MS = 270000; // 4.5 minutes

/**
 * Reads key-value configuration from the Config tab.
 */
function getConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Config');
  const map = {
    USHER_PIN: '',
    SECRET_SALT: '',
    EVENT_TITLE: 'Event QR Attendance Scanner',
    EVENT_ID: 'DEFAULT',
    LOCKED_STAGE: 'AUTO',
    ENFORCE_STAGE_ORDER: false
  };
  if (sheet && sheet.getLastRow() > 0) {
    const rows = sheet.getDataRange().getValues();
    rows.forEach(([k, v]) => {
      const key = String(k || '').trim();
      const val = String(v === undefined || v === null ? '' : v).trim();
      if (key && key !== 'Key' && val !== '') {
        if (key === 'ENFORCE_STAGE_ORDER') {
          map[key] = val.toUpperCase() === 'TRUE';
        } else {
          map[key] = val;
        }
      }
    });
  }
  return map;
}

/**
 * Ensures SECRET_SALT and USHER_PIN meet minimum security requirements.
 */
function requireSecureConfig_(cfg) {
  if (!cfg.SECRET_SALT || cfg.SECRET_SALT === PLACEHOLDER_SALT || cfg.SECRET_SALT.length < 16) {
    throw new Error('SECRET_SALT is missing or using the placeholder value in Config.');
  }
  if (!/^\d{6,}$/.test(String(cfg.USHER_PIN || ''))) {
    throw new Error('USHER_PIN must be configured as a 6+ digit numeric PIN in Config.');
  }
}

/**
 * Prevents spreadsheet formula injection when writing user-controlled strings.
 */
function safeCell_(val) {
  if (typeof val === 'string' && /^[=+\-@]/.test(val)) {
    return "'" + val;
  }
  return val;
}

/**
 * Escapes HTML special characters for email templates.
 */
function escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Computes uppercase hex prefix of SHA-256 digest.
 */
function sha256HexPrefix_(input, length) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(input)
  );
  return raw
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('')
    .substring(0, length)
    .toUpperCase();
}

function createSignature_(studentId, salt) {
  return sha256HexPrefix_(`${String(studentId).trim().toUpperCase()}|${salt}`, 10);
}

function normalizeId_(id) {
  return String(id || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Creates a stateless HMAC-style signed session token tied to SECRET_SALT and USHER_PIN.
 * Rotating USHER_PIN in Config immediately invalidates all previously issued tokens.
 */
function createSessionToken_(usherLabel, cfg) {
  const cleanUsher = String(usherLabel || 'Usher').replace(/\|/g, ' ').trim().substring(0, 40) || 'Usher';
  const expMs = Date.now() + SESSION_TTL_MS;
  const payloadB64 = Utilities.base64EncodeWebSafe(`${cleanUsher}|${expMs}`);
  const sig = sha256HexPrefix_(`${payloadB64}|${cfg.SECRET_SALT}|${cfg.USHER_PIN}`, 16);
  return { token: `${payloadB64}.${sig}`, usherLabel: cleanUsher, expMs };
}

/**
 * Verifies a signed session token against current Config.
 */
function verifySessionToken_(sessionToken, cfg) {
  try {
    requireSecureConfig_(cfg);
  } catch (e) {
    return { ok: false, message: e.message };
  }
  const parts = String(sessionToken || '').trim().split('.');
  if (parts.length !== 2) return { ok: false };
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return { ok: false };

  const expectedSig = sha256HexPrefix_(`${payloadB64}|${cfg.SECRET_SALT}|${cfg.USHER_PIN}`, 16);
  if (sig !== expectedSig) return { ok: false };

  let decoded = '';
  try {
    decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadB64)).getDataAsString();
  } catch (e) {
    return { ok: false };
  }
  const sepIdx = decoded.lastIndexOf('|');
  if (sepIdx < 0) return { ok: false };
  const usherLabel = decoded.substring(0, sepIdx) || 'Usher';
  const expMs = Number(decoded.substring(sepIdx + 1));
  if (!expMs || Date.now() > expMs) return { ok: false };

  return { ok: true, usherLabel, expMs };
}

/**
 * Adds custom spreadsheet menu on open.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Attendance Scanner')
    .addItem('🚀 Implement New Features / Apply All Upgrades', 'applyAllSystemUpgrades')
    .addSeparator()
    .addItem('Generate & Email QR Passes (All Pending)', 'generateAndEmailQRPasses')
    .addItem('Send QR Pass to Selected Row(s)', 'sendQRPassesToSelectedRows')
    .addItem('Rebuild Verified Attendance', 'rebuildVerifiedAttendance')
    .addToUi();
}

/**
 * Serves the Usher QR Scanner Web App (fallback UI).
 */
function doGet() {
  const cfg = getConfig_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(cfg.EVENT_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * JSON API endpoint for the externally hosted HTTPS QR Scanner (docs/index.html).
 * Accepts text/plain JSON payloads to avoid CORS preflight requests.
 */
function doPost(e) {
  const jsonOut = obj => ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);

  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
    const body = JSON.parse(raw);
    const action = String(body.action || '').trim();

    if (action === 'login') {
      return jsonOut(verifyUsherPin(body.pin, body.usherName));
    }
    if (action === 'state') {
      return jsonOut(getScannerState(body.sessionToken));
    }
    if (action === 'scan') {
      return jsonOut(recordScan(body.sessionToken, body.payload, body.stage));
    }
    return jsonOut({ ok: false, status: 'ERROR', message: 'Unknown API action.' });
  } catch (err) {
    return jsonOut({ ok: false, status: 'ERROR', message: 'Invalid request payload.' });
  }
}

/**
 * Authenticates an usher PIN and returns a signed 6-hour session token.
 */
function verifyUsherPin(pinInput, usherName) {
  const cfg = getConfig_();
  try {
    requireSecureConfig_(cfg);
  } catch (e) {
    return { ok: false, message: 'Scanner is not configured securely: ' + e.message };
  }

  const cache = CacheService.getScriptCache();
  const failCount = Number(cache.get(PIN_FAIL_KEY) || '0');
  if (failCount >= PIN_FAIL_MAX) {
    return { ok: false, message: 'Too many failed PIN attempts. Wait 2 minutes and try again.' };
  }

  const cleanPin = String(pinInput || '').trim();
  if (cleanPin && cleanPin === cfg.USHER_PIN) {
    const sess = createSessionToken_(usherName, cfg);
    return {
      ok: true,
      sessionToken: sess.token,
      usherLabel: sess.usherLabel,
      eventTitle: cfg.EVENT_TITLE,
      eventId: cfg.EVENT_ID,
      lockedStage: cfg.LOCKED_STAGE
    };
  }

  cache.put(PIN_FAIL_KEY, String(failCount + 1), PIN_FAIL_WINDOW_SEC);
  Utilities.sleep(1500);
  return { ok: false, message: 'Incorrect Usher PIN.' };
}

/**
 * Validates an existing session token on page reload and returns current Config state.
 */
function getScannerState(sessionToken) {
  const cfg = getConfig_();
  const sess = verifySessionToken_(sessionToken, cfg);
  if (!sess.ok) {
    return { ok: false, status: 'UNAUTHORIZED', message: 'Session expired or invalid. Please log in again.' };
  }
  return {
    ok: true,
    usherLabel: sess.usherLabel,
    eventTitle: cfg.EVENT_TITLE,
    eventId: cfg.EVENT_ID,
    lockedStage: cfg.LOCKED_STAGE
  };
}

/**
 * Returns a normalized Student ID -> student record map, cached for 5 minutes.
 * Pass forceRefresh=true on cache miss to guarantee newly added walk-in rows are seen immediately.
 */
function getRosterMap_(ss, forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const cached = cache.get(ROSTER_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // fall through to sheet read
      }
    }
  }

  const rosterSheet = ss.getSheetByName('Roster');
  if (!rosterSheet) return null;

  const map = {};
  const lastRow = rosterSheet.getLastRow();
  if (lastRow > 1) {
    const rows = rosterSheet.getRange(2, 1, lastRow - 1, 4).getValues();
    for (let i = 0; i < rows.length; i++) {
      const rId = String(rows[i][0] || '').trim().toUpperCase();
      const normId = normalizeId_(rId);
      if (!normId || map[normId]) continue; // preserve first entry on duplicate normalized ID
      map[normId] = {
        studentId: rId,
        fullName: String(rows[i][2] || '').trim(),
        section: String(rows[i][3] || '').trim()
      };
    }
  }

  try {
    const serialized = JSON.stringify(map);
    if (serialized.length <= 90000) {
      cache.put(ROSTER_CACHE_KEY, serialized, ROSTER_CACHE_TTL_SEC);
    }
  } catch (e) {
    // ignore cache write failure
  }
  return map;
}

function invalidateRosterCache_() {
  try {
    CacheService.getScriptCache().remove(ROSTER_CACHE_KEY);
  } catch (e) {
    // ignore
  }
}

/**
 * Installable onEdit trigger handler: invalidates Roster cache when Roster is edited.
 */
function onSheetEdit(e) {
  try {
    const sheet = e && e.range && e.range.getSheet ? e.range.getSheet() : null;
    if (sheet && sheet.getName() === 'Roster') {
      invalidateRosterCache_();
    }
  } catch (err) {
    // ignore trigger errors
  }
}

/**
 * Called by the Web App on every QR or manual pass scan.
 * Enforces server-side session token, LOCKED_STAGE, signature, Roster membership,
 * EVENT_ID duplicate prevention, and optional stage ordering.
 */
function recordScan(sessionToken, payloadStr, stage) {
  const cfg = getConfig_();
  const sess = verifySessionToken_(sessionToken, cfg);
  if (!sess.ok) {
    return { status: 'UNAUTHORIZED', message: 'Session expired or invalid. Please log in again.' };
  }

  const cleanStage = String(stage || '').trim();
  if (!VALID_STAGES.includes(cleanStage)) {
    return { status: 'ERROR', message: 'Invalid checkpoint stage selected.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { status: 'ERROR', message: 'Scanner busy. Scan again in 1 second.' };
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const logSheet = ss.getSheetByName('Attendance Log');
    const rosterMap = getRosterMap_(ss);
    if (!rosterMap || !logSheet) {
      return { status: 'ERROR', message: 'Missing Roster or Attendance Log sheet.' };
    }

    const now = new Date();
    const logAttempt = (studentId, fullName, section, status) => {
      const nextRow = logSheet.getLastRow() + 1;
      logSheet.getRange(nextRow, 1, 1, 8).setValues([[
        now,
        cleanStage,
        safeCell_(studentId || ''),
        safeCell_(fullName || ''),
        safeCell_(section || ''),
        safeCell_(sess.usherLabel),
        status,
        safeCell_(cfg.EVENT_ID)
      ]]);
    };

    // Enforce LOCKED_STAGE
    if (cfg.LOCKED_STAGE && cfg.LOCKED_STAGE !== 'AUTO' && cleanStage !== cfg.LOCKED_STAGE) {
      const rawHint = String(payloadStr || '').trim().split('|')[0].trim().toUpperCase();
      logAttempt(rawHint, '', '', 'REJECTED_STAGE_LOCKED');
      return {
        status: 'REJECTED_STAGE_LOCKED',
        message: `Scanner is locked to ${cfg.LOCKED_STAGE}.`
      };
    }

    // Parse ID|TOKEN payload
    const parts = String(payloadStr || '').trim().split('|');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      logAttempt(String(payloadStr || '').trim().substring(0, 40), '', '', 'REJECTED_MALFORMED');
      return { status: 'REJECTED_MALFORMED', message: 'Malformed QR payload.' };
    }

    const rawId = parts[0].trim().toUpperCase();
    const scannedToken = parts[1].trim().toUpperCase();
    const normId = normalizeId_(rawId);

    const expectedToken = createSignature_(rawId, cfg.SECRET_SALT);
    if (scannedToken !== expectedToken) {
      logAttempt(rawId, '', '', 'REJECTED_FORGED');
      return { status: 'REJECTED_FORGED', message: 'Forged or tampered QR token.' };
    }

    let studentRecord = rosterMap[normId];
    if (!studentRecord) {
      const freshRoster = getRosterMap_(ss, true);
      studentRecord = freshRoster ? freshRoster[normId] : null;
    }
    if (!studentRecord) {
      logAttempt(rawId, '', '', 'REJECTED_NOT_IN_ROSTER');
      return { status: 'REJECTED_NOT_IN_ROSTER', message: `Student ID ${rawId} not found in Roster.` };
    }

    // Scan Attendance Log (cols B..H) for active EVENT_ID
    const lastLogRow = logSheet.getLastRow();
    const seenStages = {};
    if (lastLogRow > 1) {
      const logRows = logSheet.getRange(2, 2, lastLogRow - 1, 7).getValues();
      for (let r = 0; r < logRows.length; r++) {
        const loggedStage = String(logRows[r][0] || '').trim();
        const loggedNormId = normalizeId_(logRows[r][1]);
        const loggedStatus = String(logRows[r][5] || '').trim();
        const loggedEventId = String(logRows[r][6] || '').trim() || 'DEFAULT';
        if (loggedStatus === 'ACCEPTED' && loggedNormId === normId && loggedEventId === cfg.EVENT_ID) {
          seenStages[loggedStage] = true;
        }
      }
    }

    if (seenStages[cleanStage]) {
      logAttempt(studentRecord.studentId, studentRecord.fullName, studentRecord.section, 'DUPLICATE');
      return {
        status: 'DUPLICATE',
        fullName: studentRecord.fullName,
        section: studentRecord.section,
        studentId: studentRecord.studentId,
        message: `Already scanned for ${cleanStage}.`
      };
    }

    if (cfg.ENFORCE_STAGE_ORDER) {
      if (cleanStage === 'Mid-Event' && !seenStages['Check-In']) {
        logAttempt(studentRecord.studentId, studentRecord.fullName, studentRecord.section, 'REJECTED_STAGE_ORDER');
        return {
          status: 'REJECTED_STAGE_ORDER',
          fullName: studentRecord.fullName,
          studentId: studentRecord.studentId,
          message: 'Must complete Check-In before Mid-Event.'
        };
      }
      if (cleanStage === 'Check-Out' && !seenStages['Mid-Event']) {
        logAttempt(studentRecord.studentId, studentRecord.fullName, studentRecord.section, 'REJECTED_STAGE_ORDER');
        return {
          status: 'REJECTED_STAGE_ORDER',
          fullName: studentRecord.fullName,
          studentId: studentRecord.studentId,
          message: 'Must complete Mid-Event before Check-Out.'
        };
      }
    }

    logAttempt(studentRecord.studentId, studentRecord.fullName, studentRecord.section, 'ACCEPTED');

    return {
      status: 'OK',
      fullName: studentRecord.fullName,
      section: studentRecord.section,
      studentId: studentRecord.studentId,
      stage: cleanStage,
      eventId: cfg.EVENT_ID,
      time: Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm:ss')
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Generates and emails signed QR passes for all pending Roster rows (Pass Status != 'SENT').
 */
function generateAndEmailQRPasses() {
  return sendPasses_(null, true);
}

/**
 * Generates and emails signed QR passes only for the currently selected Roster row(s).
 */
function sendQRPassesToSelectedRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = ss.getActiveSheet();
  if (!activeSheet || activeSheet.getName() !== 'Roster') {
    SpreadsheetApp.getUi().alert('Please select one or more student rows in the "Roster" tab first.');
    return;
  }
  const range = activeSheet.getActiveRange();
  if (!range) {
    SpreadsheetApp.getUi().alert('No cells selected in Roster.');
    return;
  }
  const startRow = range.getRow();
  const endRow = range.getLastRow();
  const indices = [];
  for (let r = startRow; r <= endRow; r++) {
    if (r >= 2) indices.push(r - 1); // 0-based index into getDataRange()
  }
  if (indices.length === 0) {
    SpreadsheetApp.getUi().alert('Select student rows (row 2 or below), not the header row.');
    return;
  }
  return sendPasses_(indices, false);
}

/**
 * Shared quota-safe, lock-protected, batch-writing email sender.
 */
function sendPasses_(targetRowIndices, requireConfirm) {
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    ui.alert('Email Sender Busy', 'QR pass emailing is already running. Please wait for it to finish.', ui.ButtonSet.OK);
    return { ok: false, reason: 'LOCKED' };
  }

  const startMs = Date.now();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rosterSheet = ss.getSheetByName('Roster');
    if (!rosterSheet) throw new Error('Missing "Roster" tab.');

    const cfg = getConfig_();
    requireSecureConfig_(cfg);

    const lastRow = rosterSheet.getLastRow();
    if (lastRow <= 1) {
      ui.alert('Roster is empty.');
      return { ok: true, sent: 0 };
    }

    const data = rosterSheet.getRange(1, 1, lastRow, 6).getValues();
    const candidateIndices = targetRowIndices
      ? targetRowIndices.filter(i => i >= 1 && i < data.length)
      : Array.from({ length: data.length - 1 }, (_, k) => k + 1);

    const pendingIndices = candidateIndices.filter(i => {
      const [rawId, email, , , , passStatus] = data[i];
      const studentId = String(rawId || '').trim();
      const cleanEmail = String(email || '').trim();
      const status = String(passStatus || '').trim();
      if (!studentId || !cleanEmail) return false;
      return targetRowIndices ? true : status !== 'SENT';
    });

    if (pendingIndices.length === 0) {
      ui.alert('No pending passes to email.');
      return { ok: true, sent: 0 };
    }

    const initialQuota = MailApp.getRemainingDailyQuota();
    if (requireConfirm) {
      const resp = ui.alert(
        'Confirm QR Pass Emailing',
        `Ready to email ${pendingIndices.length} pending participant(s).\nRemaining daily email quota: ${initialQuota}.\n\nProceed?`,
        ui.ButtonSet.YES_NO
      );
      if (resp !== ui.Button.YES) return { ok: false, reason: 'CANCELLED' };
    }

    const efUpdates = [];
    for (let i = 1; i < data.length; i++) {
      efUpdates.push([data[i][4], data[i][5]]);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let sent = 0;
    let errors = 0;
    let stoppedReason = '';

    try {
      for (const i of pendingIndices) {
        if (MailApp.getRemainingDailyQuota() <= 0) {
          stoppedReason = 'Daily email quota reached.';
          break;
        }
        if (Date.now() - startMs > EMAIL_TIME_BUDGET_MS) {
          stoppedReason = 'Time budget reached (4.5 min). Re-run to continue.';
          break;
        }

        const [rawId, email, fullName, section, existingToken] = data[i];
        const studentId = String(rawId || '').trim().toUpperCase();
        const cleanEmail = String(email || '').trim();
        const token = String(existingToken || '').trim() || createSignature_(studentId, cfg.SECRET_SALT);
        efUpdates[i - 1][0] = token;

        if (!emailRegex.test(cleanEmail)) {
          efUpdates[i - 1][1] = 'ERROR: Invalid email format';
          errors++;
          continue;
        }

        try {
          const payload = `${studentId}|${token}`;
          const qrUrl = `https://quickchart.io/qr?size=300&margin=2&text=${encodeURIComponent(payload)}`;
          const qrBlob = UrlFetchApp.fetch(qrUrl).getBlob().setName(`Pass_${studentId}.png`);

          MailApp.sendEmail({
            to: cleanEmail,
            subject: `${cfg.EVENT_TITLE} - Your QR Attendance Pass`,
            htmlBody: `
              <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; border: 1px solid #d0d7de; border-radius: 10px; padding: 20px; text-align: center;">
                <h2 style="margin: 0 0 8px 0;">${escapeHtml_(cfg.EVENT_TITLE)}</h2>
                <p style="margin: 4px 0; font-size: 16px;"><strong>${escapeHtml_(fullName || 'Participant')}</strong></p>
                <p style="margin: 4px 0 14px 0; color: #555;">ID: ${escapeHtml_(studentId)}${section ? ' | ' + escapeHtml_(section) : ''}</p>
                <img src="cid:qrpass" alt="QR Pass" style="width: 240px; height: 240px;" />
                <p style="margin: 10px 0 4px 0; font-size: 13px; color: #111;">
                  Manual Pass Code: <code style="background:#f3f4f6; padding:3px 6px; border-radius:4px;">${escapeHtml_(payload)}</code>
                </p>
                <p style="margin-top: 10px; font-size: 12px; color: #444; line-height: 1.4;">
                  Save a screenshot of this pass and bring your physical School ID.<br>
                  You must be scanned at <strong>Check-In</strong>, <strong>Mid-Event</strong>, and <strong>Check-Out</strong> to qualify.
                </p>
              </div>
            `,
            inlineImages: { qrpass: qrBlob }
          });

          efUpdates[i - 1][1] = 'SENT';
          sent++;
          Utilities.sleep(150);
        } catch (err) {
          efUpdates[i - 1][1] = 'ERROR: ' + String(err && err.message ? err.message : err).substring(0, 120);
          errors++;
        }
      }
    } finally {
      if (efUpdates.length > 0) {
        rosterSheet.getRange(2, 5, efUpdates.length, 2).setValues(efUpdates);
      }
      invalidateRosterCache_();
    }

    const summary = `Sent: ${sent}\nErrors: ${errors}` + (stoppedReason ? `\nNote: ${stoppedReason}` : '');
    ui.alert('QR Pass Email Summary', summary, ui.ButtonSet.OK);
    return { ok: true, sent, errors, stoppedReason };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Manual menu entry point to rebuild Verified Attendance.
 */
function rebuildVerifiedAttendance() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    SpreadsheetApp.getUi().alert('Rebuild Busy', 'Another scan or rebuild is in progress. Please try again in a moment.', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  try {
    rebuildVerifiedAttendance_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Time-based trigger entry point (every 5 minutes) to rebuild Verified Attendance.
 */
function rebuildVerifiedAttendanceTrigger() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    rebuildVerifiedAttendance_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Rebuilds Verified Attendance (Cols A-H) filtered to the active EVENT_ID.
 * Preserves Row 1 headers and formatting; clears stale trailing rows.
 */
function rebuildVerifiedAttendance_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rosterSheet = ss.getSheetByName('Roster');
  const logSheet = ss.getSheetByName('Attendance Log');
  const verSheet = ss.getSheetByName('Verified Attendance');
  if (!rosterSheet || !logSheet || !verSheet) return;

  const cfg = getConfig_();
  const summary = {};

  const rosterLastRow = rosterSheet.getLastRow();
  if (rosterLastRow > 1) {
    const rosterData = rosterSheet.getRange(2, 1, rosterLastRow - 1, 4).getValues();
    for (let i = 0; i < rosterData.length; i++) {
      const rId = String(rosterData[i][0] || '').trim().toUpperCase();
      const normId = normalizeId_(rId);
      if (!normId) continue;
      summary[normId] = {
        studentId: rId,
        fullName: String(rosterData[i][2] || '').trim(),
        section: String(rosterData[i][3] || '').trim(),
        stages: {}
      };
    }
  }

  const logLastRow = logSheet.getLastRow();
  if (logLastRow > 1) {
    const logData = logSheet.getRange(2, 1, logLastRow - 1, 8).getValues();
    for (let r = 0; r < logData.length; r++) {
      const [ts, stage, rawId, name, sec, , status, eventId] = logData[r];
      if (String(status || '').trim() !== 'ACCEPTED') continue;
      const rowEventId = String(eventId || '').trim() || 'DEFAULT';
      if (rowEventId !== cfg.EVENT_ID) continue;

      const normId = normalizeId_(rawId);
      if (!normId) continue;

      if (!summary[normId]) {
        summary[normId] = {
          studentId: String(rawId || '').trim().toUpperCase(),
          fullName: String(name || '').trim(),
          section: String(sec || '').trim(),
          stages: {}
        };
      }

      const st = String(stage || '').trim();
      if (VALID_STAGES.includes(st) && !summary[normId].stages[st]) {
        summary[normId].stages[st] = Utilities.formatDate(
          new Date(ts),
          Session.getScriptTimeZone(),
          'HH:mm:ss'
        );
      }
    }
  }

  const outRows = [];
  Object.keys(summary).sort().forEach(k => {
    const item = summary[k];
    const ci = item.stages['Check-In'] || '—';
    const me = item.stages['Mid-Event'] || '—';
    const co = item.stages['Check-Out'] || '—';
    const count = (ci !== '—' ? 1 : 0) + (me !== '—' ? 1 : 0) + (co !== '—' ? 1 : 0);
    const qualified = count === 3 ? 'QUALIFIED' : 'INCOMPLETE';
    outRows.push([
      safeCell_(item.studentId),
      safeCell_(item.fullName),
      safeCell_(item.section),
      ci,
      me,
      co,
      qualified,
      count
    ]);
  });

  const existingLastRow = verSheet.getLastRow();
  if (existingLastRow > 1) {
    verSheet.getRange(2, 1, existingLastRow - 1, 8).clearContent();
  }
  if (outRows.length > 0) {
    verSheet.getRange(2, 1, outRows.length, 8).setValues(outRows);
  }
}

/**
 * Master System Upgrades Action (agents.md Section 7).
 * Applies all schema, validation, formatting, token backfill, trigger, and rebuild updates in one click.
 */
function applyAllSystemUpgrades() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const report = [];

  const runStep = (name, fn) => {
    try {
      const detail = fn();
      report.push(`✅ ${name}${detail ? ': ' + detail : ''}`);
    } catch (err) {
      report.push(`❌ ${name}: ${err && err.message ? err.message : err}`);
    }
  };

  runStep('Config Keys & Validation', () => ensureConfigKeys_(ss));
  runStep('Sheets & Canonical Headers', () => ensureSheetsAndHeaders_(ss));
  runStep('Plain-Text ID Formatting', () => formatIdColumnsAsText_(ss));
  runStep('Backfill Missing Roster Tokens', () => backfillRosterTokens_(ss));
  runStep('Roster Integrity Audit', () => {
    const a = auditRosterIntegrity_(ss);
    return `Duplicates=${a.duplicateIds.length}, InvalidEmails=${a.invalidEmails.length}, MissingNames=${a.missingNames.length}, TokenDrift=${a.tokenDrift.length}`;
  });
  runStep('Conditional Formatting', () => applyConditionalFormatting_(ss));
  runStep('Installable Triggers (5-Min + onEdit)', () => ensureInstallableTriggers_());
  runStep('Rebuild Verified Attendance', () => {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error('Lock busy');
    try {
      rebuildVerifiedAttendance_();
    } finally {
      lock.releaseLock();
    }
    return 'Synced to active EVENT_ID';
  });
  runStep('Security Audit', () => {
    const cfg = getConfig_();
    requireSecureConfig_(cfg);
    return `PIN & Salt valid (EVENT_ID=${cfg.EVENT_ID}, LOCKED_STAGE=${cfg.LOCKED_STAGE})`;
  });

  SpreadsheetApp.getUi().alert('System Upgrades Complete', report.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

function ensureConfigKeys_(ss) {
  let sheet = ss.getSheetByName('Config');
  if (!sheet) {
    sheet = ss.insertSheet('Config');
    sheet.getRange(1, 1, 1, 3).setValues([['Key', 'Value', 'Notes']]);
  }
  const rows = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [];
  const existingKeys = new Set(rows.map(r => String(r[0] || '').trim()));
  const defaults = [
    ['EVENT_ID', 'DEFAULT', 'Unique identifier for the active event (scopes duplicates and Verified Attendance)'],
    ['LOCKED_STAGE', 'AUTO', 'Set to Check-In, Mid-Event, Check-Out, or AUTO'],
    ['ENFORCE_STAGE_ORDER', 'FALSE', 'If TRUE, requires Check-In before Mid-Event and Mid-Event before Check-Out']
  ];
  const toAdd = defaults.filter(([k]) => !existingKeys.has(k));
  if (toAdd.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
  }

  // Apply dropdown validation to LOCKED_STAGE value cell
  const updatedRows = sheet.getDataRange().getValues();
  for (let i = 0; i < updatedRows.length; i++) {
    if (String(updatedRows[i][0] || '').trim() === 'LOCKED_STAGE') {
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(['AUTO', 'Check-In', 'Mid-Event', 'Check-Out'], true)
        .setAllowInvalid(false)
        .build();
      sheet.getRange(i + 1, 2).setDataValidation(rule);
      break;
    }
  }
  return toAdd.length ? `Added ${toAdd.map(r => r[0]).join(', ')}` : 'All keys present';
}

function ensureSheetsAndHeaders_(ss) {
  const specs = [
    { name: 'Config', headers: ['Key', 'Value', 'Notes'] },
    { name: 'Roster', headers: ['Student ID', 'Email', 'Full Name', 'Section', 'Token', 'Pass Status', 'QR Preview'] },
    { name: 'Attendance Log', headers: ['Timestamp', 'Stage', 'Student ID', 'Full Name', 'Section', 'Usher Label', 'Scan Status', 'Event ID'] },
    { name: 'Verified Attendance', headers: ['Student ID', 'Full Name', 'Section', 'Check-In', 'Mid-Event', 'Check-Out', 'Qualification', 'Stage Count'] }
  ];
  let updated = 0;
  specs.forEach(spec => {
    let sheet = ss.getSheetByName(spec.name);
    if (!sheet) sheet = ss.insertSheet(spec.name);
    const current = sheet.getRange(1, 1, 1, spec.headers.length).getValues()[0];
    let dirty = false;
    const merged = spec.headers.map((h, idx) => {
      if (String(current[idx] || '').trim() === '') {
        dirty = true;
        return h;
      }
      return current[idx];
    });
    if (dirty) {
      sheet.getRange(1, 1, 1, spec.headers.length).setValues([merged]);
      updated++;
    }
  });
  return updated ? `Repaired headers on ${updated} tab(s)` : 'All headers intact';
}

function formatIdColumnsAsText_(ss) {
  const targets = [
    { name: 'Roster', col: 1 },
    { name: 'Attendance Log', col: 3 },
    { name: 'Verified Attendance', col: 1 }
  ];
  targets.forEach(t => {
    const s = ss.getSheetByName(t.name);
    if (s) s.getRange(2, t.col, Math.max(1, s.getMaxRows() - 1), 1).setNumberFormat('@');
  });
  return 'Applied @ format to ID columns';
}

/**
 * Audits Roster for duplicate normalized IDs, invalid emails, missing names, and token drift.
 * Distinguishes Student ID edits (TOKEN_DRIFT_ID_CHANGED) from secret rotation (TOKEN_DRIFT_SECRET_ROTATED).
 */
function auditRosterIntegrity_(ss) {
  const result = { duplicateIds: [], invalidEmails: [], missingNames: [], tokenDrift: [] };
  const rosterSheet = ss.getSheetByName('Roster');
  if (!rosterSheet || rosterSheet.getLastRow() <= 1) return result;

  const cfg = getConfig_();
  const hasSalt = cfg.SECRET_SALT && cfg.SECRET_SALT !== PLACEHOLDER_SALT && cfg.SECRET_SALT.length >= 16;
  const lastRow = rosterSheet.getLastRow();
  const numCols = Math.max(6, Math.min(9, rosterSheet.getLastColumn()));
  const rows = rosterSheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  const seenIds = {};
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const rawId = String(rows[i][0] || '').trim().toUpperCase();
    const email = String(rows[i][1] || '').trim();
    const fullName = String(rows[i][2] || '').trim();
    const token = String(rows[i][4] || '').trim().toUpperCase();
    const lastSentToken = numCols >= 8 ? String(rows[i][7] || '').trim().toUpperCase() : '';
    const lastSentId = numCols >= 9 ? String(rows[i][8] || '').trim().toUpperCase() : '';
    const normId = normalizeId_(rawId);

    if (normId) {
      if (seenIds[normId]) {
        result.duplicateIds.push({ row: rowNum, firstRow: seenIds[normId], studentId: rawId, normId });
      } else {
        seenIds[normId] = rowNum;
      }
    }

    if (email && !emailRegex.test(email)) {
      result.invalidEmails.push({ row: rowNum, studentId: rawId, email });
    }
    if (rawId && !fullName) {
      result.missingNames.push({ row: rowNum, studentId: rawId });
    }

    if (hasSalt && rawId) {
      const expected = createSignature_(rawId, cfg.SECRET_SALT);
      const cmpToken = lastSentToken || token;
      if (cmpToken && cmpToken !== expected) {
        const reason = (lastSentId && normalizeId_(lastSentId) !== normId)
          ? 'TOKEN_DRIFT_ID_CHANGED'
          : 'TOKEN_DRIFT_SECRET_ROTATED';
        result.tokenDrift.push({ row: rowNum, studentId: rawId, reason });
      }
    }
  }
  return result;
}

function backfillRosterTokens_(ss) {
  const rosterSheet = ss.getSheetByName('Roster');
  if (!rosterSheet || rosterSheet.getLastRow() <= 1) return 'No roster rows';
  const cfg = getConfig_();
  requireSecureConfig_(cfg);

  const count = rosterSheet.getLastRow() - 1;
  const idsAndTokens = rosterSheet.getRange(2, 1, count, 5).getValues();
  const tokenCol = [];
  let filled = 0;
  for (let i = 0; i < idsAndTokens.length; i++) {
    const studentId = String(idsAndTokens[i][0] || '').trim().toUpperCase();
    const existing = String(idsAndTokens[i][4] || '').trim();
    const expected = studentId ? createSignature_(studentId, cfg.SECRET_SALT) : '';
    if (studentId && existing !== expected) {
      tokenCol.push([expected]);
      filled++;
    } else {
      tokenCol.push([existing]);
    }
  }
  if (filled > 0) {
    rosterSheet.getRange(2, 5, count, 1).setValues(tokenCol);
  }
  invalidateRosterCache_();
  return `Updated ${filled} token(s)`;
}

function applyConditionalFormatting_(ss) {
  const replaceColRules = (sheet, colNum, newRules) => {
    if (!sheet) return;
    const preserved = sheet.getConditionalFormatRules().filter(rule => {
      const ranges = rule.getRanges ? rule.getRanges() : [];
      return !ranges.some(r => r.getColumn && r.getColumn() === colNum);
    });
    sheet.setConditionalFormatRules(preserved.concat(newRules));
  };

  const logSheet = ss.getSheetByName('Attendance Log');
  if (logSheet) {
    const range = logSheet.getRange(2, 7, Math.max(1, logSheet.getMaxRows() - 1), 1);
    const rules = [
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('ACCEPTED').setBackground('#d1fae5').setFontColor('#065f46').setRanges([range]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('DUPLICATE').setBackground('#fef3c7').setFontColor('#92400e').setRanges([range]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('REJECTED').setBackground('#fee2e2').setFontColor('#991b1b').setRanges([range]).build()
    ];
    replaceColRules(logSheet, 7, rules);
  }

  const verSheet = ss.getSheetByName('Verified Attendance');
  if (verSheet) {
    const range = verSheet.getRange(2, 7, Math.max(1, verSheet.getMaxRows() - 1), 1);
    const rules = [
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('QUALIFIED').setBackground('#d1fae5').setFontColor('#065f46').setRanges([range]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('INCOMPLETE').setBackground('#fef3c7').setFontColor('#92400e').setRanges([range]).build()
    ];
    replaceColRules(verSheet, 7, rules);
  }
  return 'Updated Log & Verified Attendance rules (preserved custom rules)';
}

function ensureInstallableTriggers_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const existing = ScriptApp.getProjectTriggers();
  const rebuildTriggers = existing.filter(t => t.getHandlerFunction() === 'rebuildVerifiedAttendanceTrigger');
  if (rebuildTriggers.length !== 1) {
    rebuildTriggers.forEach(t => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger('rebuildVerifiedAttendanceTrigger')
      .timeBased()
      .everyMinutes(5)
      .create();
  }
  const editTriggers = existing.filter(t => t.getHandlerFunction() === 'onSheetEdit');
  if (editTriggers.length !== 1) {
    editTriggers.forEach(t => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger('onSheetEdit')
      .forSpreadsheet(ss)
      .onEdit()
      .create();
  }
  return '5-minute + onEdit triggers active';
}

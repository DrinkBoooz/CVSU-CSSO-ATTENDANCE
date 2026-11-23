const DEFAULT_PIN = '4829';
const DEFAULT_SALT = 'REPLACE_WITH_A_STRONG_RANDOM_SECRET_2026';

function getConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Config');
  const map = {
    USHER_PIN: DEFAULT_PIN,
    SECRET_SALT: DEFAULT_SALT,
    EVENT_TITLE: 'Event QR Attendance Scanner'
  };
  if (sheet) {
    const rows = sheet.getDataRange().getValues();
    rows.forEach(([k, v]) => {
      if (k && String(v).trim() !== '') {
        map[String(k).trim()] = String(v).trim();
      }
    });
  }
  return map;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Attendance Scanner')
    .addItem('Generate & Email QR Passes', 'generateAndEmailQRPasses')
    .addItem('Rebuild Verified Attendance', 'rebuildVerifiedAttendance')
    .addToUi();
}

function doGet() {
  const cfg = getConfig_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(cfg.EVENT_TITLE)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

function verifyUsherPin(pinInput) {
  const cfg = getConfig_();
  const cleanPin = String(pinInput || '').trim();
  if (cleanPin && cleanPin === cfg.USHER_PIN) {
    return { ok: true, eventTitle: cfg.EVENT_TITLE };
  }
  return { ok: false, message: 'Incorrect Usher PIN.' };
}

function createSignature_(studentId, salt) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA256,
    `${String(studentId).trim().toUpperCase()}|${salt}`
  );
  return raw
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('')
    .substring(0, 10)
    .toUpperCase();
}

function normalizeId_(id) {
  return String(id || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Generates signed QR passes for Roster entries where Pass Status != 'SENT'.
 * Roster columns: A=Student ID, B=Email, C=Full Name, D=Section, E=Token, F=Pass Status
 */
function generateAndEmailQRPasses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rosterSheet = ss.getSheetByName('Roster');
  if (!rosterSheet) throw new Error('Missing "Roster" tab.');

  const cfg = getConfig_();
  const data = rosterSheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const [rawId, email, fullName, section, existingToken, passStatus] = data[i];
    const studentId = String(rawId || '').trim().toUpperCase();
    const cleanEmail = String(email || '').trim();
    if (!studentId || !cleanEmail || String(passStatus).trim() === 'SENT') continue;

    const token = String(existingToken || '').trim() || createSignature_(studentId, cfg.SECRET_SALT);
    rosterSheet.getRange(i + 1, 5).setValue(token);

    const payload = `${studentId}|${token}`;
    const qrUrl = `https://quickchart.io/qr?size=300&margin=2&text=${encodeURIComponent(payload)}`;
    const qrBlob = UrlFetchApp.fetch(qrUrl).getBlob().setName(`Pass_${studentId}.png`);

    MailApp.sendEmail({
      to: cleanEmail,
      subject: `${cfg.EVENT_TITLE} - Your QR Attendance Pass`,
      htmlBody: `
        <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; border: 1px solid #d0d7de; border-radius: 10px; padding: 20px; text-align: center;">
          <h2 style="margin: 0 0 8px 0;">${cfg.EVENT_TITLE}</h2>
          <p style="margin: 4px 0; font-size: 16px;"><strong>${fullName || 'Participant'}</strong></p>
          <p style="margin: 4px 0 14px 0; color: #555;">ID: ${studentId} ${section ? '| ' + section : ''}</p>
          <img src="cid:qrpass" alt="QR Pass" style="width: 240px; height: 240px;" />
          <p style="margin-top: 14px; font-size: 12px; color: #444; line-height: 1.4;">
            Save a screenshot of this pass and bring your physical School ID.<br>
            You must be scanned at <strong>Check-In</strong>, <strong>Mid-Event</strong>, and <strong>Check-Out</strong> to qualify.
          </p>
        </div>
      `,
      inlineImages: { qrpass: qrBlob }
    });

    rosterSheet.getRange(i + 1, 6).setValue('SENT');
    Utilities.sleep(200);
  }
}

/**
 * Called by the Web App on every QR scan.
 * Enforces valid signature, Roster membership, and 1 scan per student per stage.
 */
function recordScan(payloadStr, stage, usherLabel) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { status: 'ERROR', message: 'Scanner busy. Scan again in 1 second.' };
  }

  try {
    const validStages = ['Check-In', 'Mid-Event', 'Check-Out'];
    const cleanStage = String(stage || '').trim();
    if (!validStages.includes(cleanStage)) {
      return { status: 'ERROR', message: 'Invalid checkpoint stage selected.' };
    }

    const parts = String(payloadStr || '').trim().split('|');
    if (parts.length !== 2) {
      return { status: 'INVALID', message: 'Malformed QR payload.' };
    }

    const rawId = parts[0].trim().toUpperCase();
    const scannedToken = parts[1].trim().toUpperCase();
    const normId = normalizeId_(rawId);

    const cfg = getConfig_();
    const expectedToken = createSignature_(rawId, cfg.SECRET_SALT);
    if (!scannedToken || scannedToken !== expectedToken) {
      return { status: 'INVALID', message: 'Forged or tampered QR token.' };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rosterSheet = ss.getSheetByName('Roster');
    const logSheet = ss.getSheetByName('Attendance Log');
    if (!rosterSheet || !logSheet) {
      return { status: 'ERROR', message: 'Missing Roster or Attendance Log sheet.' };
    }

    // Lookup student in Roster
    const rosterData = rosterSheet.getDataRange().getValues();
    let studentRecord = null;
    for (let i = 1; i < rosterData.length; i++) {
      const rId = String(rosterData[i][0] || '').trim().toUpperCase();
      if (normalizeId_(rId) === normId) {
        studentRecord = {
          studentId: rId,
          fullName: String(rosterData[i][2] || '').trim(),
          section: String(rosterData[i][3] || '').trim()
        };
        break;
      }
    }

    if (!studentRecord) {
      return { status: 'INVALID', message: `Student ID ${rawId} not found in Roster.` };
    }

    // Check if already scanned for this stage
    const logData = logSheet.getDataRange().getValues();
    for (let r = 1; r < logData.length; r++) {
      const loggedStage = String(logData[r][1] || '').trim();
      const loggedNormId = normalizeId_(logData[r][2]);
      const loggedStatus = String(logData[r][6] || '').trim();
      if (loggedStage === cleanStage && loggedNormId === normId && loggedStatus === 'ACCEPTED') {
        return {
          status: 'DUPLICATE',
          fullName: studentRecord.fullName,
          section: studentRecord.section,
          studentId: studentRecord.studentId,
          message: `Already scanned for ${cleanStage}.`
        };
      }
    }

    const now = new Date();
    const cleanUsher = String(usherLabel || 'Usher').trim().substring(0, 40);
    logSheet.appendRow([
      now,
      cleanStage,
      studentRecord.studentId,
      studentRecord.fullName,
      studentRecord.section,
      cleanUsher,
      'ACCEPTED'
    ]);

    rebuildVerifiedAttendance_();

    return {
      status: 'OK',
      fullName: studentRecord.fullName,
      section: studentRecord.section,
      studentId: studentRecord.studentId,
      stage: cleanStage,
      time: Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm:ss')
    };
  } finally {
    lock.releaseLock();
  }
}

function rebuildVerifiedAttendance() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    rebuildVerifiedAttendance_();
  } finally {
    lock.releaseLock();
  }
}

function rebuildVerifiedAttendance_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rosterSheet = ss.getSheetByName('Roster');
  const logSheet = ss.getSheetByName('Attendance Log');
  const verSheet = ss.getSheetByName('Verified Attendance');
  if (!rosterSheet || !logSheet || !verSheet) return;

  const rosterData = rosterSheet.getDataRange().getValues();
  const summary = {}; // normId -> object

  for (let i = 1; i < rosterData.length; i++) {
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

  const logData = logSheet.getDataRange().getValues();
  for (let r = 1; r < logData.length; r++) {
    const [ts, stage, rawId, name, sec, , status] = logData[r];
    if (String(status).trim() !== 'ACCEPTED') continue;
    const normId = normalizeId_(rawId);
    if (!normId) continue;

    if (!summary[normId]) {
      summary[normId] = {
        studentId: String(rawId).trim().toUpperCase(),
        fullName: String(name || '').trim(),
        section: String(sec || '').trim(),
        stages: {}
      };
    }

    const st = String(stage || '').trim();
    if (!summary[normId].stages[st]) {
      summary[normId].stages[st] = Utilities.formatDate(
        new Date(ts),
        Session.getScriptTimeZone(),
        'HH:mm:ss'
      );
    }
  }

  const out = [['Student ID', 'Full Name', 'Section', 'Check-In', 'Mid-Event', 'Check-Out', 'Qualification']];
  Object.keys(summary).sort().forEach(k => {
    const item = summary[k];
    const ci = item.stages['Check-In'] || '—';
    const me = item.stages['Mid-Event'] || '—';
    const co = item.stages['Check-Out'] || '—';
    const qualified = (ci !== '—' && me !== '—' && co !== '—') ? 'QUALIFIED' : 'INCOMPLETE';
    out.push([item.studentId, item.fullName, item.section, ci, me, co, qualified]);
  });

  verSheet.clearContents();
  verSheet.getRange(1, 1, out.length, 7).setValues(out);
}
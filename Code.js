const PLACEHOLDER_SALT = "REPLACE_WITH_A_STRONG_RANDOM_SECRET_2026";
const VALID_STAGES = ["Check-In", "Mid-Event", "Check-Out"];
const STAGE_BITS = { "Check-In": 1, "Mid-Event": 2, "Check-Out": 4 };
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const PIN_FAIL_KEY = "pin_fail_count";
const PIN_FAIL_WINDOW_SEC = 120; // 2 minutes
const PIN_FAIL_WARN_THRESHOLD = 15;
const ROSTER_CACHE_KEY = "roster_map_v1";
const ROSTER_SHARD_COUNT = 16;
const ROSTER_SHARD_PREFIX = "roster_v2_s";
const ROSTER_CACHE_TTL_SEC = 300; // 5 minutes
const DEDUPE_CACHE_TTL_SEC = 3600; // 1 hour (write-through optimization only; Attendance Log is authoritative)
const EVENT_INDEX_CACHE_PREFIX = "evt_idx_v1_";
const EMAIL_TIME_BUDGET_MS = 270000; // 4.5 minutes
const APP_BUILD_VERSION = "2026.11.24-phase4-batch";

/**
 * Reads key-value configuration from ScriptProperties (single batched RPC)
 * and the Config tab (bounded A1:B25 read, with pre-migration secret fallback).
 */
function getConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Config");
  const map = {
    USHER_PIN: "",
    SECRET_SALT: "",
    LEGACY_SECRET_SALT: "",
    V1_COMPAT_EVENT_ID: "",
    V1_COMPAT_RETIRED: false,
    TARGET_EVENT_ID: "",
    EVENT_TRANSITION_PENDING: false,
    EVENT_TITLE: "Event QR Attendance Scanner",
    EVENT_ID: "DEFAULT",
    LOCKED_STAGE: "AUTO",
    ENFORCE_STAGE_ORDER: false,
  };
  if (sheet) {
    const lastRow = sheet.getLastRow();
    if (lastRow > 0) {
      const rows = sheet.getRange(1, 1, Math.min(lastRow, 25), 2).getValues();
      for (let i = 0; i < rows.length; i++) {
        const key = String(rows[i][0] || "").trim();
        const val = String(rows[i][1] === undefined || rows[i][1] === null ? "" : rows[i][1]).trim();
        if (key && key !== "Key" && val !== "") {
          if (key === "ENFORCE_STAGE_ORDER") {
            map[key] = val.toUpperCase() === "TRUE";
          } else {
            map[key] = val;
          }
        }
      }
    }
  }

  try {
    const allProps = PropertiesService.getScriptProperties().getProperties() || {};
    if (allProps.USHER_PIN) map.USHER_PIN = String(allProps.USHER_PIN).trim();
    if (allProps.SECRET_SALT) map.SECRET_SALT = String(allProps.SECRET_SALT).trim();
    if (allProps.LEGACY_SECRET_SALT) map.LEGACY_SECRET_SALT = String(allProps.LEGACY_SECRET_SALT).trim();
    if (allProps.V1_COMPAT_EVENT_ID) map.V1_COMPAT_EVENT_ID = String(allProps.V1_COMPAT_EVENT_ID).trim();
    if (allProps.V1_COMPAT_RETIRED)
      map.V1_COMPAT_RETIRED = String(allProps.V1_COMPAT_RETIRED).trim().toUpperCase() === "TRUE";
    if (allProps.TARGET_EVENT_ID) map.TARGET_EVENT_ID = String(allProps.TARGET_EVENT_ID).trim();
    if (allProps.EVENT_TRANSITION_PENDING)
      map.EVENT_TRANSITION_PENDING =
        String(allProps.EVENT_TRANSITION_PENDING).trim().toUpperCase() === "TRUE";
  } catch (e) {
    // ignore ScriptProperties read error in constrained environments
  }
  return map;
}

/**
 * Ensures SECRET_SALT and USHER_PIN meet minimum security requirements.
 */
function requireSecureConfig_(cfg) {
  if (
    !cfg.SECRET_SALT ||
    cfg.SECRET_SALT === PLACEHOLDER_SALT ||
    cfg.SECRET_SALT.length < 16
  ) {
    throw new Error(
      "SECRET_SALT is missing or using the placeholder value in Config.",
    );
  }
  if (!/^\d{6,}$/.test(String(cfg.USHER_PIN || ""))) {
    throw new Error(
      "USHER_PIN must be configured as a 6+ digit numeric PIN in Config.",
    );
  }
}

/**
 * Prevents spreadsheet formula injection when writing user-controlled strings.
 */
function safeCell_(val) {
  if (typeof val === "string" && /^[=+\-@]/.test(val)) {
    return "'" + val;
  }
  return val;
}

/**
 * Escapes HTML special characters for email templates.
 */
function escapeHtml_(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Computes uppercase hex prefix of SHA-256 digest.
 */
function sha256HexPrefix_(input, length) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(input),
  );
  return raw
    .map((b) => ("0" + (b & 0xff).toString(16)).slice(-2))
    .join("")
    .substring(0, length)
    .toUpperCase();
}

function hmacSha256Hex_(msg, key, length) {
  const raw = Utilities.computeHmacSha256Signature(String(msg), String(key));
  const hex = raw
    .map((b) => ("0" + (b & 0xff).toString(16)).slice(-2))
    .join("")
    .toUpperCase();
  return length ? hex.substring(0, length) : hex;
}

function constantTimeEqual_(a, b) {
  const s1 = String(a || "");
  const s2 = String(b || "");
  if (s1.length !== s2.length) return false;
  let diff = 0;
  for (let i = 0; i < s1.length; i++) {
    diff |= s1.charCodeAt(i) ^ s2.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Legacy v1 signature: exact original SHA256(STUDENT_ID + "|" + SECRET_SALT)[0:10].
 * Never replaced with HMAC-SHA256.
 */
function createSignature_(studentId, salt) {
  return sha256HexPrefix_(
    `${String(studentId).trim().toUpperCase()}|${salt}`,
    10,
  );
}

function verifyLegacyV1Signature_(rawId, scannedToken, cfg) {
  const expectedCurrent = createSignature_(rawId, cfg.SECRET_SALT);
  if (constantTimeEqual_(scannedToken, expectedCurrent)) return true;
  if (cfg.LEGACY_SECRET_SALT) {
    const expectedLegacy = createSignature_(rawId, cfg.LEGACY_SECRET_SALT);
    if (constantTimeEqual_(scannedToken, expectedLegacy)) return true;
  }
  return false;
}

function validateV2Field_(val, label) {
  const s = String(val === undefined || val === null ? "" : val);
  if (!s) throw new Error(`${label} cannot be empty.`);
  if (s.includes("|"))
    throw new Error(`${label} cannot contain the "|" delimiter.`);
  if (s !== s.trim() || /[\x00-\x1f\x7f]/.test(s)) {
    throw new Error(
      `${label} cannot contain leading/trailing whitespace or control characters.`,
    );
  }
  return s;
}

function createV2Signature_(eventId, studentId, key) {
  const ev = validateV2Field_(eventId, "EVENT_ID");
  const sid = validateV2Field_(studentId, "STUDENT_ID");
  return hmacSha256Hex_(`v2|${ev}|${sid}`, key, 64);
}

function verifyV2Signature_(eventId, studentId, scannedHmac, cfg) {
  if (!/^[A-F0-9]{32,64}$/.test(scannedHmac)) return false;
  const prefix = `v2|${eventId}|${studentId}`;
  const expectedCur = hmacSha256Hex_(
    prefix,
    cfg.SECRET_SALT,
    scannedHmac.length,
  );
  if (constantTimeEqual_(scannedHmac, expectedCur)) return true;
  if (cfg.LEGACY_SECRET_SALT) {
    const expectedLeg = hmacSha256Hex_(
      prefix,
      cfg.LEGACY_SECRET_SALT,
      scannedHmac.length,
    );
    if (constantTimeEqual_(scannedHmac, expectedLeg)) return true;
  }
  return false;
}

function normalizeId_(id) {
  return String(id || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Creates a stateless HMAC-SHA256 signed session token tied to SECRET_SALT and USHER_PIN.
 * Rotating USHER_PIN immediately invalidates all previously issued tokens.
 */
function createSessionToken_(usherLabel, cfg) {
  const cleanUsher =
    String(usherLabel || "Usher")
      .replace(/\|/g, " ")
      .trim()
      .substring(0, 40) || "Usher";
  const expMs = Date.now() + SESSION_TTL_MS;
  const payloadB64 = Utilities.base64EncodeWebSafe(`${cleanUsher}|${expMs}`);
  const sig = hmacSha256Hex_(
    payloadB64,
    `${cfg.SECRET_SALT}|${cfg.USHER_PIN}`,
    32,
  );
  return { token: `${payloadB64}.${sig}`, usherLabel: cleanUsher, expMs };
}

/**
 * Verifies a signed HMAC-SHA256 session token against current Config.
 */
function verifySessionToken_(sessionToken, cfg) {
  try {
    requireSecureConfig_(cfg);
  } catch (e) {
    return { ok: false, message: e.message };
  }
  const parts = String(sessionToken || "")
    .trim()
    .split(".");
  if (parts.length !== 2) return { ok: false };
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return { ok: false };

  const expectedSig = hmacSha256Hex_(
    payloadB64,
    `${cfg.SECRET_SALT}|${cfg.USHER_PIN}`,
    32,
  );
  if (!constantTimeEqual_(sig, expectedSig)) return { ok: false };

  let decoded = "";
  try {
    decoded = Utilities.newBlob(
      Utilities.base64DecodeWebSafe(payloadB64),
    ).getDataAsString();
  } catch (e) {
    return { ok: false };
  }
  const sepIdx = decoded.lastIndexOf("|");
  if (sepIdx < 0) return { ok: false };
  const usherLabel = decoded.substring(0, sepIdx) || "Usher";
  const expMs = Number(decoded.substring(sepIdx + 1));
  if (!expMs || Date.now() > expMs) return { ok: false };

  return { ok: true, usherLabel, expMs };
}

/**
 * Adds custom spreadsheet menu on open.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Attendance Scanner")
    .addItem(
      "🚀 Implement New Features / Apply All Upgrades",
      "applyAllSystemUpgrades",
    )
    .addSeparator()
    .addItem(
      "Generate & Email QR Passes (All Pending)",
      "generateAndEmailQRPasses",
    )
    .addItem("Send QR Pass to Selected Row(s)", "sendQRPassesToSelectedRows")
    .addItem(
      "Issue Target-Event v2 Passes (Pending)",
      "issueTargetEventV2Passes",
    )
    .addItem("Rebuild Verified Attendance", "rebuildVerifiedAttendance")
    .addSeparator()
    .addItem(
      "📝 Setup Registration Form & Portal Sync",
      "setupRegistrationFormAndTrigger",
    )
    .addItem(
      "🗑️ Replace Registration Form (Trash Old & Create New)",
      "replaceRegistrationForm",
    )
    .addItem(
      "🧹 Clear All Data Rows (Keep Headers & Config)",
      "clearAllDataRows",
    )
    .addToUi();
}

/**
 * Serves the Usher QR Scanner Web App (fallback UI).
 */
function doGet() {
  const cfg = getConfig_();
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle(cfg.EVENT_TITLE)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * JSON API endpoint for the externally hosted HTTPS QR Scanner (docs/index.html).
 * Accepts text/plain JSON payloads to avoid CORS preflight requests.
 */
function doPost(e) {
  const requestId = Utilities.getUuid().substring(0, 8);
  const jsonOut = (obj) =>
    ContentService.createTextOutput(
      JSON.stringify(Object.assign({ requestId }, obj)),
    ).setMimeType(ContentService.MimeType.JSON);

  let body;
  try {
    const raw =
      e && e.postData && e.postData.contents ? e.postData.contents : "";
    body = JSON.parse(raw);
  } catch (parseErr) {
    return jsonOut({
      ok: false,
      status: "INVALID_JSON",
      message: "Invalid JSON request payload.",
    });
  }

  try {
    const action = String(body && body.action ? body.action : "").trim();
    if (action === "ping") {
      const cfg = getConfig_();
      return jsonOut({
        ok: true,
        status: "OK",
        version: APP_BUILD_VERSION,
        eventId: cfg.EVENT_ID,
      });
    }
    if (action === "login") {
      return jsonOut(verifyUsherPin(body.pin, body.usherName));
    }
    if (action === "state") {
      return jsonOut(getScannerState(body.sessionToken));
    }
    if (action === "snapshot") {
      return jsonOut(getScannerSnapshot(body.sessionToken));
    }
    if (action === "scan") {
      return jsonOut(recordScan(body.sessionToken, body.payload, body.stage));
    }
    if (action === "scanBatch") {
      return jsonOut(recordScanBatch(body.sessionToken, body.scans));
    }
    if (action === "lookupPass") {
      return jsonOut(lookupStudentPass(body.studentId, body.email));
    }
    return jsonOut({
      ok: false,
      status: "ERROR",
      message: "Unknown API action.",
    });
  } catch (err) {
    console.error(
      `doPost [${requestId}] internal error:`,
      err && err.stack ? err.stack : err,
    );
    return jsonOut({
      ok: false,
      status: "INTERNAL_ERROR",
      message: `Internal server error (ref: ${requestId}).`,
    });
  }
}

/**
 * Authenticates an usher PIN and returns a signed 6-hour HMAC-SHA256 session token.
 * Note: Anonymous GAS endpoints cannot inspect caller IP; uses bounded per-failure delay
 * rather than a global gate DoS lockout.
 */
function verifyUsherPin(pinInput, usherName) {
  const cfg = getConfig_();
  try {
    requireSecureConfig_(cfg);
  } catch (e) {
    return {
      ok: false,
      message: "Scanner is not configured securely: " + e.message,
    };
  }

  const cleanPin = String(pinInput || "").trim();
  if (cleanPin && constantTimeEqual_(cleanPin, cfg.USHER_PIN)) {
    const sess = createSessionToken_(usherName, cfg);
    return {
      ok: true,
      sessionToken: sess.token,
      usherLabel: sess.usherLabel,
      eventTitle: cfg.EVENT_TITLE,
      eventId: cfg.EVENT_ID,
      lockedStage: cfg.LOCKED_STAGE,
    };
  }

  const cache = CacheService.getScriptCache();
  const failCount = Number(cache.get(PIN_FAIL_KEY) || "0") + 1;
  cache.put(PIN_FAIL_KEY, String(failCount), PIN_FAIL_WINDOW_SEC);
  if (failCount >= PIN_FAIL_WARN_THRESHOLD) {
    console.warn(
      `High failed PIN attempt volume (${failCount} in ${PIN_FAIL_WINDOW_SEC}s window).`,
    );
  }
  Utilities.sleep(1500);
  return { ok: false, message: "Incorrect Usher PIN." };
}

/**
 * Validates an existing session token on page reload and returns current Config state.
 */
function getScannerState(sessionToken) {
  const cfg = getConfig_();
  const sess = verifySessionToken_(sessionToken, cfg);
  if (!sess.ok) {
    return {
      ok: false,
      status: "UNAUTHORIZED",
      message: "Session expired or invalid. Please log in again.",
    };
  }
  return {
    ok: true,
    usherLabel: sess.usherLabel,
    eventTitle: cfg.EVENT_TITLE,
    eventId: cfg.EVENT_ID,
    lockedStage: cfg.LOCKED_STAGE,
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

  const rosterSheet = ss.getSheetByName("Roster");
  if (!rosterSheet) return null;

  const map = {};
  const lastRow = rosterSheet.getLastRow();
  if (lastRow > 1) {
    const rows = rosterSheet.getRange(2, 1, lastRow - 1, 4).getValues();
    for (let i = 0; i < rows.length; i++) {
      const rId = String(rows[i][0] || "")
        .trim()
        .toUpperCase();
      const normId = normalizeId_(rId);
      if (!normId || map[normId]) continue; // preserve first entry on duplicate normalized ID
      map[normId] = {
        studentId: rId,
        fullName: String(rows[i][2] || "").trim(),
        section: String(rows[i][3] || "").trim(),
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

function rosterShardIdx_(normId) {
  let h = 2166136261;
  const s = String(normId || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h % ROSTER_SHARD_COUNT;
}

/**
 * Rebuilds all 16 compact tuple shards ([studentId, fullName, section]) from Roster
 * in a single sheet read + single CacheService.putAll() RPC. Scales O(1) to ~28,000 students.
 */
function rebuildRosterShards_(ss) {
  const rosterSheet = ss.getSheetByName("Roster");
  if (!rosterSheet) return null;

  const shards = Array.from({ length: ROSTER_SHARD_COUNT }, () => ({}));
  const lastRow = rosterSheet.getLastRow();
  if (lastRow > 1) {
    const rows = rosterSheet.getRange(2, 1, lastRow - 1, 4).getValues();
    for (let i = 0; i < rows.length; i++) {
      const rId = String(rows[i][0] || "")
        .trim()
        .toUpperCase();
      const normId = normalizeId_(rId);
      if (!normId) continue;
      const b = rosterShardIdx_(normId);
      if (shards[b][normId]) continue; // preserve first entry on duplicate normalized ID
      shards[b][normId] = [
        rId,
        String(rows[i][2] || "").trim(),
        String(rows[i][3] || "").trim(),
      ];
    }
  }

  try {
    const batch = {};
    for (let b = 0; b < ROSTER_SHARD_COUNT; b++) {
      const serialized = JSON.stringify(shards[b]);
      if (serialized.length <= 90000) {
        batch[ROSTER_SHARD_PREFIX + b] = serialized;
      }
    }
    if (Object.keys(batch).length > 0) {
      CacheService.getScriptCache().putAll(batch, ROSTER_CACHE_TTL_SEC);
    }
  } catch (e) {
    // ignore cache write failure
  }
  return shards;
}

/**
 * O(1) single-shard Roster lookup with automatic walk-in refresh on miss.
 * Returns { missingSheet: true } if Roster tab is absent, or { record: {...}|null }.
 */
function getRosterEntry_(ss, normId) {
  const b = rosterShardIdx_(normId);
  const shardKey = ROSTER_SHARD_PREFIX + b;
  let shard = null;
  let fromCache = false;

  try {
    const raw = CacheService.getScriptCache().get(shardKey);
    if (raw) {
      shard = JSON.parse(raw);
      fromCache = true;
    }
  } catch (e) {}

  if (!shard) {
    const shards = rebuildRosterShards_(ss);
    if (!shards) return { missingSheet: true, record: null };
    shard = shards[b];
  } else if (!shard[normId] && fromCache) {
    // Cache hit on shard, but student missing -> refresh once for walk-ins
    const shards = rebuildRosterShards_(ss);
    if (!shards) return { missingSheet: true, record: null };
    shard = shards[b];
  }

  const tuple = shard ? shard[normId] : null;
  if (!tuple) return { missingSheet: false, record: null };
  return {
    missingSheet: false,
    record: { studentId: tuple[0], fullName: tuple[1], section: tuple[2] },
  };
}

function invalidateRosterCache_() {
  try {
    const keys = [ROSTER_CACHE_KEY];
    for (let b = 0; b < ROSTER_SHARD_COUNT; b++) {
      keys.push(ROSTER_SHARD_PREFIX + b);
    }
    CacheService.getScriptCache().removeAll(keys);
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
    if (!sheet) return;
    const name = sheet.getName();
    if (name === "Roster") {
      invalidateRosterCache_();
    } else if (name === "Attendance Log") {
      const cfg = getConfig_();
      invalidateEventSeenIndex_(cfg.EVENT_ID);
    }
  } catch (err) {
    // ignore trigger errors
  }
}

/**
 * Event-wide O(1) bitmask dedupe index in CacheService: { normId: bitmask }
 * where Check-In=1, Mid-Event=2, Check-Out=4.
 * Built once on cache miss from authoritative Attendance Log inside ScriptLock.
 */
function eventIndexCacheKey_(eventId) {
  return EVENT_INDEX_CACHE_PREFIX + String(eventId || "DEFAULT");
}

function getEventSeenIndex_(eventId, logSheet) {
  const key = eventIndexCacheKey_(eventId);
  try {
    const raw = CacheService.getScriptCache().get(key);
    if (raw) return JSON.parse(raw);
  } catch (e) {}

  const idx = {};
  const lastLogRow = logSheet.getLastRow();
  if (lastLogRow > 1) {
    const logRows = logSheet.getRange(2, 2, lastLogRow - 1, 7).getValues();
    for (let r = 0; r < logRows.length; r++) {
      const loggedStatus = String(logRows[r][5] || "").trim();
      if (loggedStatus !== "ACCEPTED") continue;
      const loggedEventId = String(logRows[r][6] || "").trim() || "DEFAULT";
      if (loggedEventId !== eventId) continue;
      const loggedNormId = normalizeId_(logRows[r][1]);
      const bit = STAGE_BITS[String(logRows[r][0] || "").trim()] || 0;
      if (loggedNormId && bit) {
        idx[loggedNormId] = (idx[loggedNormId] || 0) | bit;
      }
    }
  }
  putEventSeenIndex_(eventId, idx);
  return idx;
}

function putEventSeenIndex_(eventId, idx) {
  try {
    const serialized = JSON.stringify(idx);
    if (serialized.length <= 90000) {
      CacheService.getScriptCache().put(
        eventIndexCacheKey_(eventId),
        serialized,
        DEDUPE_CACHE_TTL_SEC,
      );
    }
  } catch (e) {}
}

function invalidateEventSeenIndex_(eventId) {
  try {
    CacheService.getScriptCache().remove(eventIndexCacheKey_(eventId));
  } catch (e) {}
}

function dedupeCacheKey_(eventId, normId) {
  return `evt_seen_${eventId}_${normId}`;
}

function getCachedSeenStages_(eventId, normId) {
  try {
    const raw = CacheService.getScriptCache().get(
      dedupeCacheKey_(eventId, normId),
    );
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function putCachedSeenStages_(eventId, normId, seenStages) {
  try {
    CacheService.getScriptCache().put(
      dedupeCacheKey_(eventId, normId),
      JSON.stringify(seenStages),
      DEDUPE_CACHE_TTL_SEC,
    );
  } catch (e) {}
}

/**
 * Called by the Web App on every QR or manual pass scan.
 * Enforces server-side session token, LOCKED_STAGE, v1/v2 signature & event binding,
 * Roster membership, EVENT_ID duplicate prevention (authoritative Attendance Log
 * inside LockService), and optional stage ordering.
 */
function recordScan(sessionToken, payloadStr, stage) {
  const cfg = getConfig_();
  const sess = verifySessionToken_(sessionToken, cfg);
  if (!sess.ok) {
    return {
      status: "UNAUTHORIZED",
      message: "Session expired or invalid. Please log in again.",
    };
  }

  const cleanStage = String(stage || "").trim();
  if (!VALID_STAGES.includes(cleanStage)) {
    return { status: "ERROR", message: "Invalid checkpoint stage selected." };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Helper to log rejected/valid attempts inside minimal ScriptLock critical section
  const logRejectedLocked = (studentId, status) => {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return false;
    try {
      const logSheet = ss.getSheetByName("Attendance Log");
      if (logSheet) {
        logSheet.appendRow([
          new Date(),
          cleanStage,
          safeCell_(studentId || ""),
          "",
          "",
          safeCell_(sess.usherLabel),
          status,
          safeCell_(cfg.EVENT_ID),
        ]);
      }
      return true;
    } finally {
      lock.releaseLock();
    }
  };

  // Validate LOCKED_STAGE, payload syntax, signature, and Roster OUTSIDE ScriptLock
  // so concurrent ushers do not block each other on CPU/crypto/Roster reads.
  if (
    cfg.LOCKED_STAGE &&
    cfg.LOCKED_STAGE !== "AUTO" &&
    cleanStage !== cfg.LOCKED_STAGE
  ) {
    const hintParts = String(payloadStr || "")
      .trim()
      .split("|");
    const rawHint = (
      hintParts[0] === "v2" && hintParts.length >= 3
        ? hintParts[2]
        : hintParts[0]
    )
      .trim()
      .toUpperCase();
    logRejectedLocked(rawHint, "REJECTED_STAGE_LOCKED");
    return {
      status: "REJECTED_STAGE_LOCKED",
      message: `Scanner is locked to ${cfg.LOCKED_STAGE}.`,
    };
  }

  const rawPayload = String(payloadStr || "");
  const parts = rawPayload.split("|");

  let rawId = "";
  let normId = "";

  if (parts[0] === "v2") {
    // Canonical v2|EVENT_ID|STUDENT_ID|HMAC — strict 4 segments, no silent field modification
    if (parts.length !== 4) {
      logRejectedLocked(
        rawPayload.trim().substring(0, 40),
        "REJECTED_MALFORMED",
      );
      return {
        status: "REJECTED_MALFORMED",
        message: "Malformed v2 QR payload.",
      };
    }
    const [, evId, sid, hmac] = parts;
    try {
      validateV2Field_(evId, "EVENT_ID");
      validateV2Field_(sid, "STUDENT_ID");
    } catch (fieldErr) {
      logRejectedLocked(
        rawPayload.trim().substring(0, 40),
        "REJECTED_MALFORMED",
      );
      return { status: "REJECTED_MALFORMED", message: fieldErr.message };
    }
    if (!hmac || hmac !== hmac.trim()) {
      logRejectedLocked(sid, "REJECTED_MALFORMED");
      return { status: "REJECTED_MALFORMED", message: "Malformed v2 HMAC." };
    }

    rawId = sid;
    normId = normalizeId_(rawId);

    // Strict EVENT_ID validation before accepting either SECRET_SALT or LEGACY_SECRET_SALT
    if (evId !== cfg.EVENT_ID) {
      logRejectedLocked(rawId, "REJECTED_WRONG_EVENT");
      return {
        status: "REJECTED_WRONG_EVENT",
        message: `Pass belongs to event "${evId}", not "${cfg.EVENT_ID}".`,
      };
    }

    if (!verifyV2Signature_(evId, sid, hmac, cfg)) {
      logRejectedLocked(rawId, "REJECTED_FORGED");
      return {
        status: "REJECTED_FORGED",
        message: "Forged or tampered v2 QR token.",
      };
    }
  } else {
    // Legacy v1: STUDENTID|10-HEX
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      logRejectedLocked(
        rawPayload.trim().substring(0, 40),
        "REJECTED_MALFORMED",
      );
      return {
        status: "REJECTED_MALFORMED",
        message: "Malformed QR payload.",
      };
    }

    rawId = parts[0].trim().toUpperCase();
    const scannedToken = parts[1].trim().toUpperCase();
    normId = normalizeId_(rawId);

    if (cfg.V1_COMPAT_RETIRED) {
      logRejectedLocked(rawId, "REJECTED_V1_RETIRED");
      return {
        status: "REJECTED_V1_RETIRED",
        message: "Legacy v1 passes have been permanently retired.",
      };
    }
    const compatEventId = cfg.V1_COMPAT_EVENT_ID || "DEFAULT";
    if (cfg.EVENT_ID !== compatEventId) {
      logRejectedLocked(rawId, "REJECTED_WRONG_EVENT");
      return {
        status: "REJECTED_WRONG_EVENT",
        message: `Legacy v1 passes are only valid for ${compatEventId}.`,
      };
    }
    if (!verifyLegacyV1Signature_(rawId, scannedToken, cfg)) {
      logRejectedLocked(rawId, "REJECTED_FORGED");
      return {
        status: "REJECTED_FORGED",
        message: "Forged or tampered QR token.",
      };
    }
  }

  // O(1) sharded Roster lookup outside ScriptLock
  const rosterLookup = getRosterEntry_(ss, normId);
  if (rosterLookup.missingSheet) {
    return { status: "ERROR", message: "Missing Roster sheet." };
  }
  const studentRecord = rosterLookup.record;
  if (!studentRecord) {
    logRejectedLocked(rawId, "REJECTED_NOT_IN_ROSTER");
    return {
      status: "REJECTED_NOT_IN_ROSTER",
      message: `Student ID ${rawId} not found in Roster.`,
    };
  }

  // Acquire ScriptLock ONLY for the atomic dedupe check + appendRow write
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return {
      status: "ERROR",
      message: "Scanner busy. Scan again in 1 second.",
    };
  }

  try {
    const logSheet = ss.getSheetByName("Attendance Log");
    if (!logSheet) {
      return { status: "ERROR", message: "Missing Attendance Log sheet." };
    }

    const now = new Date();
    const logAttempt = (studentId, fullName, section, status) => {
      logSheet.appendRow([
        now,
        cleanStage,
        safeCell_(studentId || ""),
        safeCell_(fullName || ""),
        safeCell_(section || ""),
        safeCell_(sess.usherLabel),
        status,
        safeCell_(cfg.EVENT_ID),
      ]);
    };

    // O(1) event-wide bitmask dedupe index; built once from Attendance Log on cache miss
    const seenIndex = getEventSeenIndex_(cfg.EVENT_ID, logSheet);
    const seenMask = seenIndex[normId] || 0;
    const stageBit = STAGE_BITS[cleanStage] || 0;

    if (seenMask & stageBit) {
      logAttempt(
        studentRecord.studentId,
        studentRecord.fullName,
        studentRecord.section,
        "DUPLICATE",
      );
      return {
        status: "DUPLICATE",
        fullName: studentRecord.fullName,
        section: studentRecord.section,
        studentId: studentRecord.studentId,
        message: `Already scanned for ${cleanStage}.`,
      };
    }

    if (cfg.ENFORCE_STAGE_ORDER) {
      if (cleanStage === "Mid-Event" && !(seenMask & STAGE_BITS["Check-In"])) {
        logAttempt(
          studentRecord.studentId,
          studentRecord.fullName,
          studentRecord.section,
          "REJECTED_STAGE_ORDER",
        );
        return {
          status: "REJECTED_STAGE_ORDER",
          fullName: studentRecord.fullName,
          studentId: studentRecord.studentId,
          message: "Must complete Check-In before Mid-Event.",
        };
      }
      if (cleanStage === "Check-Out" && !(seenMask & STAGE_BITS["Mid-Event"])) {
        logAttempt(
          studentRecord.studentId,
          studentRecord.fullName,
          studentRecord.section,
          "REJECTED_STAGE_ORDER",
        );
        return {
          status: "REJECTED_STAGE_ORDER",
          fullName: studentRecord.fullName,
          studentId: studentRecord.studentId,
          message: "Must complete Mid-Event before Check-Out.",
        };
      }
    }

    logAttempt(
      studentRecord.studentId,
      studentRecord.fullName,
      studentRecord.section,
      "ACCEPTED",
    );
    seenIndex[normId] = seenMask | stageBit;
    putEventSeenIndex_(cfg.EVENT_ID, seenIndex);

    return {
      status: "OK",
      fullName: studentRecord.fullName,
      section: studentRecord.section,
      studentId: studentRecord.studentId,
      stage: cleanStage,
      eventId: cfg.EVENT_ID,
      time: Utilities.formatDate(now, Session.getScriptTimeZone(), "HH:mm:ss"),
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns a compact, secret-free snapshot (Roster tuples + seen stage bitmasks)
 * for instant (<10ms) offline-first client-side pre-validation.
 * Never exposes SECRET_SALT, USHER_PIN, tokens, or participant emails.
 */
function getScannerSnapshot(sessionToken) {
  const cfg = getConfig_();
  const sess = verifySessionToken_(sessionToken, cfg);
  if (!sess.ok) {
    return {
      ok: false,
      status: "UNAUTHORIZED",
      message: "Session expired or invalid. Please log in again.",
    };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rosterMap = getRosterMap_(ss, true);
  if (!rosterMap) {
    return { ok: false, status: "ERROR", message: "Missing Roster sheet." };
  }

  const compactRoster = {};
  const keys = Object.keys(rosterMap);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const rec = rosterMap[k];
    compactRoster[k] = [rec.studentId, rec.fullName, rec.section];
  }

  const logSheet = ss.getSheetByName("Attendance Log");
  const seen = logSheet ? getEventSeenIndex_(cfg.EVENT_ID, logSheet) : {};

  return {
    ok: true,
    usherLabel: sess.usherLabel,
    eventTitle: cfg.EVENT_TITLE,
    eventId: cfg.EVENT_ID,
    lockedStage: cfg.LOCKED_STAGE,
    enforceStageOrder: !!cfg.ENFORCE_STAGE_ORDER,
    v1Retired: !!cfg.V1_COMPAT_RETIRED,
    v1CompatEventId: cfg.V1_COMPAT_EVENT_ID || "DEFAULT",
    roster: compactRoster,
    seen,
  };
}

/**
 * Processes up to 50 queued offline/instant scans in a single ScriptLock + single
 * setValues() batch write. Performs full authoritative server-side HMAC/SHA-256
 * verification, Roster membership, stage-lock, stage-order, and dedupe checks.
 */
function recordScanBatch(sessionToken, scans) {
  const cfg = getConfig_();
  const sess = verifySessionToken_(sessionToken, cfg);
  if (!sess.ok) {
    return {
      ok: false,
      status: "UNAUTHORIZED",
      message: "Session expired or invalid. Please log in again.",
    };
  }

  if (!Array.isArray(scans) || scans.length === 0) {
    return { ok: true, eventId: cfg.EVENT_ID, results: [] };
  }

  const batch = scans.slice(0, 50);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();

  // Pre-validate every scan's syntax, signature, event binding & Roster OUTSIDE ScriptLock
  const prepared = batch.map((item) => {
    const clientId = String((item && item.clientId) || "");
    const payloadStr = String((item && item.payload) || "");
    const cleanStage = String((item && item.stage) || "").trim();
    let scanTime = new Date();
    if (item && item.scannedAt) {
      const parsed = new Date(item.scannedAt);
      if (!isNaN(parsed.getTime())) scanTime = parsed;
    }

    if (!VALID_STAGES.includes(cleanStage)) {
      return {
        clientId,
        cleanStage,
        scanTime,
        preRejected: true,
        logRow: null,
        result: { clientId, status: "ERROR", message: "Invalid checkpoint stage." },
      };
    }

    if (
      cfg.LOCKED_STAGE &&
      cfg.LOCKED_STAGE !== "AUTO" &&
      cleanStage !== cfg.LOCKED_STAGE
    ) {
      const hintParts = payloadStr.trim().split("|");
      const rawHint = (
        hintParts[0] === "v2" && hintParts.length >= 3
          ? hintParts[2]
          : hintParts[0]
      )
        .trim()
        .toUpperCase();
      return {
        clientId,
        cleanStage,
        scanTime,
        preRejected: true,
        logRow: [
          scanTime,
          cleanStage,
          safeCell_(rawHint),
          "",
          "",
          safeCell_(sess.usherLabel),
          "REJECTED_STAGE_LOCKED",
          safeCell_(cfg.EVENT_ID),
        ],
        result: {
          clientId,
          status: "REJECTED_STAGE_LOCKED",
          studentId: rawHint,
          stage: cleanStage,
          message: `Scanner is locked to ${cfg.LOCKED_STAGE}.`,
        },
      };
    }

    const parts = payloadStr.split("|");
    let rawId = "";
    let normId = "";
    let rejectStatus = "";
    let rejectMsg = "";

    if (parts[0] === "v2") {
      if (parts.length !== 4) {
        rawId = payloadStr.trim().substring(0, 40);
        rejectStatus = "REJECTED_MALFORMED";
        rejectMsg = "Malformed v2 QR payload.";
      } else {
        const [, evId, sid, hmac] = parts;
        try {
          validateV2Field_(evId, "EVENT_ID");
          validateV2Field_(sid, "STUDENT_ID");
        } catch (fieldErr) {
          rawId = payloadStr.trim().substring(0, 40);
          rejectStatus = "REJECTED_MALFORMED";
          rejectMsg = fieldErr.message;
        }
        if (!rejectStatus && (!hmac || hmac !== hmac.trim())) {
          rawId = sid;
          rejectStatus = "REJECTED_MALFORMED";
          rejectMsg = "Malformed v2 HMAC.";
        }
        if (!rejectStatus) {
          rawId = sid;
          normId = normalizeId_(rawId);
          if (evId !== cfg.EVENT_ID) {
            rejectStatus = "REJECTED_WRONG_EVENT";
            rejectMsg = `Pass belongs to event "${evId}", not "${cfg.EVENT_ID}".`;
          } else if (!verifyV2Signature_(evId, sid, hmac, cfg)) {
            rejectStatus = "REJECTED_FORGED";
            rejectMsg = "Forged or tampered v2 QR token.";
          }
        }
      }
    } else {
      if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
        rawId = payloadStr.trim().substring(0, 40);
        rejectStatus = "REJECTED_MALFORMED";
        rejectMsg = "Malformed QR payload.";
      } else {
        rawId = parts[0].trim().toUpperCase();
        const scannedToken = parts[1].trim().toUpperCase();
        normId = normalizeId_(rawId);
        const compatEventId = cfg.V1_COMPAT_EVENT_ID || "DEFAULT";
        if (cfg.V1_COMPAT_RETIRED) {
          rejectStatus = "REJECTED_V1_RETIRED";
          rejectMsg = "Legacy v1 passes have been permanently retired.";
        } else if (cfg.EVENT_ID !== compatEventId) {
          rejectStatus = "REJECTED_WRONG_EVENT";
          rejectMsg = `Legacy v1 passes are only valid for ${compatEventId}.`;
        } else if (!verifyLegacyV1Signature_(rawId, scannedToken, cfg)) {
          rejectStatus = "REJECTED_FORGED";
          rejectMsg = "Forged or tampered QR token.";
        }
      }
    }

    if (rejectStatus) {
      return {
        clientId,
        cleanStage,
        scanTime,
        preRejected: true,
        logRow: [
          scanTime,
          cleanStage,
          safeCell_(rawId),
          "",
          "",
          safeCell_(sess.usherLabel),
          rejectStatus,
          safeCell_(cfg.EVENT_ID),
        ],
        result: {
          clientId,
          status: rejectStatus,
          studentId: rawId,
          stage: cleanStage,
          message: rejectMsg,
        },
      };
    }

    const rosterLookup = getRosterEntry_(ss, normId);
    if (rosterLookup.missingSheet) {
      return {
        clientId,
        cleanStage,
        scanTime,
        preRejected: true,
        logRow: null,
        result: { clientId, status: "ERROR", message: "Missing Roster sheet." },
      };
    }
    if (!rosterLookup.record) {
      return {
        clientId,
        cleanStage,
        scanTime,
        preRejected: true,
        logRow: [
          scanTime,
          cleanStage,
          safeCell_(rawId),
          "",
          "",
          safeCell_(sess.usherLabel),
          "REJECTED_NOT_IN_ROSTER",
          safeCell_(cfg.EVENT_ID),
        ],
        result: {
          clientId,
          status: "REJECTED_NOT_IN_ROSTER",
          studentId: rawId,
          stage: cleanStage,
          message: `Student ID ${rawId} not found in Roster.`,
        },
      };
    }

    return {
      clientId,
      cleanStage,
      scanTime,
      preRejected: false,
      normId,
      studentRecord: rosterLookup.record,
    };
  });

  // Single ScriptLock + single batch setValues() for all rows in the batch
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return {
      ok: false,
      status: "ERROR",
      message: "Scanner busy. Batch will retry automatically.",
    };
  }

  try {
    const logSheet = ss.getSheetByName("Attendance Log");
    if (!logSheet) {
      return {
        ok: false,
        status: "ERROR",
        message: "Missing Attendance Log sheet.",
      };
    }

    const seenIndex = getEventSeenIndex_(cfg.EVENT_ID, logSheet);
    let seenDirty = false;
    const rowsToWrite = [];
    const results = [];

    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      if (p.preRejected) {
        if (p.logRow) rowsToWrite.push(p.logRow);
        results.push(p.result);
        continue;
      }

      const rec = p.studentRecord;
      const seenMask = seenIndex[p.normId] || 0;
      const stageBit = STAGE_BITS[p.cleanStage] || 0;

      if (seenMask & stageBit) {
        rowsToWrite.push([
          p.scanTime,
          p.cleanStage,
          safeCell_(rec.studentId),
          safeCell_(rec.fullName),
          safeCell_(rec.section),
          safeCell_(sess.usherLabel),
          "DUPLICATE",
          safeCell_(cfg.EVENT_ID),
        ]);
        results.push({
          clientId: p.clientId,
          status: "DUPLICATE",
          studentId: rec.studentId,
          fullName: rec.fullName,
          section: rec.section,
          stage: p.cleanStage,
          message: `Already scanned for ${p.cleanStage}.`,
        });
        continue;
      }

      if (cfg.ENFORCE_STAGE_ORDER) {
        if (p.cleanStage === "Mid-Event" && !(seenMask & STAGE_BITS["Check-In"])) {
          rowsToWrite.push([
            p.scanTime,
            p.cleanStage,
            safeCell_(rec.studentId),
            safeCell_(rec.fullName),
            safeCell_(rec.section),
            safeCell_(sess.usherLabel),
            "REJECTED_STAGE_ORDER",
            safeCell_(cfg.EVENT_ID),
          ]);
          results.push({
            clientId: p.clientId,
            status: "REJECTED_STAGE_ORDER",
            studentId: rec.studentId,
            fullName: rec.fullName,
            stage: p.cleanStage,
            message: "Must complete Check-In before Mid-Event.",
          });
          continue;
        }
        if (p.cleanStage === "Check-Out" && !(seenMask & STAGE_BITS["Mid-Event"])) {
          rowsToWrite.push([
            p.scanTime,
            p.cleanStage,
            safeCell_(rec.studentId),
            safeCell_(rec.fullName),
            safeCell_(rec.section),
            safeCell_(sess.usherLabel),
            "REJECTED_STAGE_ORDER",
            safeCell_(cfg.EVENT_ID),
          ]);
          results.push({
            clientId: p.clientId,
            status: "REJECTED_STAGE_ORDER",
            studentId: rec.studentId,
            fullName: rec.fullName,
            stage: p.cleanStage,
            message: "Must complete Mid-Event before Check-Out.",
          });
          continue;
        }
      }

      rowsToWrite.push([
        p.scanTime,
        p.cleanStage,
        safeCell_(rec.studentId),
        safeCell_(rec.fullName),
        safeCell_(rec.section),
        safeCell_(sess.usherLabel),
        "ACCEPTED",
        safeCell_(cfg.EVENT_ID),
      ]);
      seenIndex[p.normId] = seenMask | stageBit;
      seenDirty = true;
      results.push({
        clientId: p.clientId,
        status: "OK",
        studentId: rec.studentId,
        fullName: rec.fullName,
        section: rec.section,
        stage: p.cleanStage,
        eventId: cfg.EVENT_ID,
        time: Utilities.formatDate(p.scanTime, tz, "HH:mm:ss"),
      });
    }

    if (rowsToWrite.length > 0) {
      const nextRow = logSheet.getLastRow() + 1;
      logSheet.getRange(nextRow, 1, rowsToWrite.length, 8).setValues(rowsToWrite);
    }
    if (seenDirty) {
      putEventSeenIndex_(cfg.EVENT_ID, seenIndex);
    }

    return { ok: true, eventId: cfg.EVENT_ID, results, seen: seenIndex };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Clears all data rows (Row 2+) from Roster, Attendance Log, and Verified Attendance
 * while preserving Row 1 headers, formatting, and the Config tab.
 * Requires typing "CLEAR ALL" in a confirmation prompt to prevent accidental data loss.
 */
function clearAllDataRows() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const targets = [
    { name: "Roster", minCols: 14 },
    { name: "Attendance Log", minCols: 8 },
    { name: "Verified Attendance", minCols: 8 },
  ];

  const counts = targets.map((t) => {
    const s = ss.getSheetByName(t.name);
    const rows = s ? Math.max(0, s.getLastRow() - 1) : 0;
    return `${t.name}: ${rows} row(s)`;
  });

  const prompt = ui.prompt(
    "⚠️ Clear All Data Rows",
    `This will permanently clear all data rows (keeping Row 1 headers and Config):\n\n• ${counts.join("\n• ")}\n\nType CLEAR ALL to confirm:`,
    ui.ButtonSet.OK_CANCEL,
  );
  if (
    prompt.getSelectedButton() !== ui.Button.OK ||
    String(prompt.getResponseText() || "").trim() !== "CLEAR ALL"
  ) {
    ui.alert("Cancelled", "No rows were cleared.", ui.ButtonSet.OK);
    return { ok: false, reason: "CANCELLED" };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    ui.alert(
      "Busy",
      "Another scan or rebuild is in progress. Please try again in a moment.",
      ui.ButtonSet.OK,
    );
    return { ok: false, reason: "LOCKED" };
  }

  try {
    const cleared = {};
    const cfg = getConfig_();

    targets.forEach((t) => {
      const s = ss.getSheetByName(t.name);
      if (!s) {
        cleared[t.name] = 0;
        return;
      }
      const lastRow = s.getLastRow();
      if (lastRow > 1) {
        const numCols = Math.max(t.minCols, s.getLastColumn());
        s.getRange(2, 1, lastRow - 1, numCols).clearContent();
        cleared[t.name] = lastRow - 1;
      } else {
        cleared[t.name] = 0;
      }
    });

    invalidateRosterCache_();
    invalidateEventSeenIndex_(cfg.EVENT_ID);

    ui.alert(
      "Data Rows Cleared",
      `Cleared successfully (headers & Config preserved):\n\n• Roster: ${cleared["Roster"]}\n• Attendance Log: ${cleared["Attendance Log"]}\n• Verified Attendance: ${cleared["Verified Attendance"]}\n\nCaches invalidated.`,
      ui.ButtonSet.OK,
    );
    return { ok: true, cleared };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Creates (or re-links) a Google Form for student self-registration with all fields required
 * and limited to 1 response per user, links it to this spreadsheet, and installs the
 * automatic onFormSubmit QR pass email trigger under the currently signed-in account.
 *
 * Tip: Run this menu item while signed in as your @cvsu.edu.ph Google Workspace account
 * (with Editor access to this sheet) so automated QR emails use the 1,500/day Workspace quota,
 * while the scanner Web App remains deployed under your personal account for ANYONE_ANONYMOUS access.
 */
function setupRegistrationFormAndTrigger() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getConfig_();
  requireSecureConfig_(cfg);

  const props = PropertiesService.getScriptProperties();
  let formId = props.getProperty("REGISTRATION_FORM_ID") || "";
  let form = null;
  let createdNew = false;

  if (formId) {
    try {
      form = FormApp.openById(formId);
    } catch (e) {
      form = null;
      formId = "";
    }
  }

  const idValidation = FormApp.createTextValidation()
    .setHelpText(
      "Enter a valid Student ID (e.g. 202300328). Letters, numbers, and optional dash only — no spaces.",
    )
    .requireTextMatchesPattern("^[A-Za-z0-9]{4,15}(-[A-Za-z0-9]{1,8})?$")
    .build();

  const nameValidation = FormApp.createTextValidation()
    .setHelpText(
      "Enter your full name (3-80 characters, e.g. Dela Cruz, Juan M.). Letters, spaces, commas, periods, and hyphens only.",
    )
    .requireTextMatchesPattern(
      "^[A-Za-z\\u00C0-\\u00FF][A-Za-z\\u00C0-\\u00FF .,'\\-]{2,79}$",
    )
    .build();

  const sectionValidation = FormApp.createTextValidation()
    .setHelpText(
      "Enter your Course & Section (e.g. BSCS 3-1, BSCS 4-4, or BSCS-3A).",
    )
    .requireTextMatchesPattern(
      "^[A-Za-z]{2,10}[\\s\\-]?[1-5][\\s\\-]?[A-Za-z0-9]{1,3}$",
    )
    .build();

  if (!form) {
    form = FormApp.create(`${cfg.EVENT_TITLE} - Student Registration`);
    form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
    formId = form.getId();
    props.setProperty("REGISTRATION_FORM_ID", formId);
    createdNew = true;
  }

  // Always enforce settings, confirmation message & strict field validations (on both new & existing Forms)
  form.setTitle(`${cfg.EVENT_TITLE} - Student Registration`);
  form.setDescription(
    `Register for ${cfg.EVENT_TITLE} (${cfg.EVENT_ID}).\n` +
      "All fields are required. You are limited to 1 response. " +
      "After submitting, open the QR Pass Portal link on the next screen to view and download your signed QR Attendance Pass.",
  );
  form.setCollectEmail(true);
  form.setLimitOneResponsePerUser(true);
  form.setAllowResponseEdits(false);
  try {
    form.setRequireLogin(true);
  } catch (e) {
    // setRequireLogin is Workspace-domain specific; ignore on personal accounts
  }
  form.setConfirmationMessage(
    `Registration received for ${cfg.EVENT_TITLE} (${cfg.EVENT_ID})!\n\n` +
      "View and download your signed QR Attendance Pass immediately on the Pass Portal " +
      "(enter your Student ID and the exact email you used here):\n" +
      "https://drinkboooz.github.io/CVSU-CSSO-ATTENDANCE/pass.html\n\n" +
      "Save a screenshot of your QR pass and bring your physical School ID to the venue.",
  );

  const ensureTextQuestion = (title, helpText, validation) => {
    const existingItem = form
      .getItems(FormApp.ItemType.TEXT)
      .find((it) => String(it.getTitle() || "").trim() === title);
    const textItem = existingItem
      ? existingItem.asTextItem()
      : form.addTextItem().setTitle(title);
    textItem
      .setHelpText(helpText)
      .setRequired(true)
      .setValidation(validation);
  };

  ensureTextQuestion("Student ID", "Example: 202300328", idValidation);
  ensureTextQuestion("Full Name", "Example: Dela Cruz, Juan M.", nameValidation);
  ensureTextQuestion("Section", "Example: BSCS 3-1", sectionValidation);

  // Install/replace the onFormSubmit trigger under the currently active user
  const existing = ScriptApp.getProjectTriggers();
  existing
    .filter((t) => t.getHandlerFunction() === "onRegistrationFormSubmit")
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("onRegistrationFormSubmit")
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();

  const publishedUrl = form.getPublishedUrl();
  const editUrl = form.getEditUrl();

  // Save Form URL into Config tab for easy reference
  const configSheet = ss.getSheetByName("Config");
  if (configSheet) {
    const rows = configSheet.getDataRange().getValues();
    let foundRow = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0] || "").trim() === "REGISTRATION_FORM_URL") {
        foundRow = i + 1;
        break;
      }
    }
    if (foundRow > 0) {
      configSheet.getRange(foundRow, 2, 1, 2).setValues([[publishedUrl, `Linked Form ID: ${formId}`]]);
    } else {
      configSheet.appendRow([
        "REGISTRATION_FORM_URL",
        publishedUrl,
        `Linked Form ID: ${formId}`,
      ]);
    }
  }

  ui.alert(
    createdNew
      ? "Registration Form Created & Linked"
      : "Form Portal Sync Trigger Updated",
    `Zero-Email Registration Form & Roster Sync is now ACTIVE!\n\n` +
      `Students submit this Form -> auto-syncs to Roster -> download their QR Pass on pass.html (unlimited, 0 emails used).\n\n` +
      `Shareable Form URL (saved in Config):\n${publishedUrl}\n\n` +
      `Form Edit URL:\n${editUrl}`,
    ui.ButtonSet.OK,
  );
  return { ok: true, formId, publishedUrl, editUrl };
}

/**
 * Unlinks and trashes the previously created Registration Form (and removes its
 * old Form Responses tab from the spreadsheet), then creates a fresh validated Form.
 */
function replaceRegistrationForm() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const oldFormId = props.getProperty("REGISTRATION_FORM_ID") || "";

  const resp = ui.alert(
    "Replace Registration Form?",
    "This will unlink the old Registration Form, move it to your Google Drive Trash, delete its old 'Form Responses' tab from this spreadsheet, and create a brand-new validated Form.\n\nContinue?",
    ui.ButtonSet.YES_NO,
  );
  if (resp !== ui.Button.YES) {
    return { ok: false, reason: "CANCELLED" };
  }

  let oldFormUrl = "";
  if (oldFormId) {
    try {
      const oldForm = FormApp.openById(oldFormId);
      oldFormUrl = oldForm.getPublishedUrl() || "";
      try {
        oldForm.removeDestination();
      } catch (e) {}
    } catch (e) {}

    try {
      DriveApp.getFileById(oldFormId).setTrashed(true);
    } catch (e) {
      // Ignore if already trashed or Drive scope not yet granted
    }
  }

  // Delete any old Form Responses tab linked to the old form (or matching Form Responses*)
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    const formUrl = s.getFormUrl ? s.getFormUrl() : null;
    const isOldLinked = oldFormUrl && formUrl && formUrl === oldFormUrl;
    const isFormRespTab = /^Form Responses \d+$/i.test(s.getName());
    if ((isOldLinked || (!oldFormUrl && isFormRespTab)) && ss.getSheets().length > 1) {
      ss.deleteSheet(s);
    }
  }

  props.deleteProperty("REGISTRATION_FORM_ID");
  return setupRegistrationFormAndTrigger();
}

/**
 * Installable onFormSubmit trigger: registers the student in Roster (deduped by Student ID)
 * and immediately emails their signed QR Attendance Pass via GmailApp.
 */
function onRegistrationFormSubmit(e) {
  if (!e || (!e.namedValues && !e.values)) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    console.error("onRegistrationFormSubmit: could not acquire ScriptLock.");
    return;
  }

  try {
    const nv = e.namedValues || {};
    const pick = (keys) => {
      for (let i = 0; i < keys.length; i++) {
        if (nv[keys[i]] && nv[keys[i]][0] !== undefined) {
          return String(nv[keys[i]][0]).trim();
        }
      }
      return "";
    };

    const cleanEmail = pick(["Email Address", "Email", "CvSU Email"]);
    const studentId = pick(["Student ID", "Student Number", "ID"])
      .trim()
      .toUpperCase();
    const fullName = pick(["Full Name", "Name"]);
    const section = pick(["Section", "Course & Section", "Year & Section"]);

    if (!studentId || !cleanEmail) {
      console.warn(
        "onRegistrationFormSubmit: missing Student ID or Email Address.",
      );
      return;
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rosterSheet = ss.getSheetByName("Roster");
    if (!rosterSheet) {
      console.error("onRegistrationFormSubmit: Missing Roster tab.");
      return;
    }

    const cfg = getConfig_();
    requireSecureConfig_(cfg);

    const compatEventId = cfg.V1_COMPAT_EVENT_ID || "DEFAULT";
    const issueProtocol =
      !cfg.V1_COMPAT_RETIRED && cfg.EVENT_ID === compatEventId ? "v1" : "v2";
    const issueEventId = cfg.EVENT_ID;

    const token =
      issueProtocol === "v2"
        ? createV2Signature_(issueEventId, studentId, cfg.SECRET_SALT)
        : createSignature_(studentId, cfg.SECRET_SALT);
    const payload =
      issueProtocol === "v2"
        ? `v2|${issueEventId}|${studentId}|${token}`
        : `${studentId}|${token}`;

    // Check if student already exists in Roster (prevent duplicate Roster rows)
    const normId = normalizeId_(studentId);
    const lastRow = rosterSheet.getLastRow();
    let existingRowNum = -1;
    let prevAttempts = 0;
    if (lastRow > 1) {
      const existingData = rosterSheet
        .getRange(2, 1, lastRow - 1, 14)
        .getValues();
      for (let i = 0; i < existingData.length; i++) {
        if (normalizeId_(existingData[i][0]) === normId) {
          existingRowNum = i + 2;
          prevAttempts = Number(existingData[i][9]) || 0;
          break;
        }
      }
    }

    const attemptNum = prevAttempts;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const passStatus = emailRegex.test(cleanEmail)
      ? "READY_ON_PORTAL"
      : "INVALID_EMAIL";
    const lastError = emailRegex.test(cleanEmail) ? "" : "Invalid email format";
    const rowValues = [
      safeCell_(studentId),
      safeCell_(cleanEmail),
      safeCell_(fullName),
      safeCell_(section),
      token,
      passStatus,
      "", // QR Preview preserved
      "",
      "",
      attemptNum,
      "",
      lastError,
      issueProtocol,
      issueEventId,
    ];

    if (existingRowNum > 0) {
      rosterSheet.getRange(existingRowNum, 1, 1, 14).setValues([rowValues]);
    } else {
      rosterSheet.appendRow(rowValues);
    }

    invalidateRosterCache_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Self-service QR Pass Portal lookup (Way 3B — zero email quota required).
 * Requires BOTH Student ID and registered Email to match the exact Roster row.
 * Uses a generic error + 1.5s delay on mismatch to prevent enumeration/brute-force.
 * Returns a server-signed QR payload and inline PNG data URI (zero secrets exposed).
 */
function lookupStudentPass(studentIdInput, emailInput) {
  const cfg = getConfig_();
  try {
    requireSecureConfig_(cfg);
  } catch (e) {
    return {
      ok: false,
      status: "ERROR",
      message: "System is not configured securely yet.",
    };
  }

  const normId = normalizeId_(studentIdInput);
  const cleanEmail = String(emailInput || "").trim().toLowerCase();
  if (!normId || !cleanEmail) {
    return {
      ok: false,
      status: "INVALID_INPUT",
      message: "Please enter both your Student ID and registered Email.",
    };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rosterSheet = ss.getSheetByName("Roster");
  if (!rosterSheet || rosterSheet.getLastRow() <= 1) {
    Utilities.sleep(1500);
    return {
      ok: false,
      status: "NOT_FOUND",
      message:
        "No matching registration found. Verify your Student ID and the exact email you submitted.",
    };
  }

  const rows = rosterSheet
    .getRange(2, 1, rosterSheet.getLastRow() - 1, 4)
    .getValues();
  let matched = null;
  for (let i = 0; i < rows.length; i++) {
    const rId = String(rows[i][0] || "").trim().toUpperCase();
    const rEmail = String(rows[i][1] || "").trim().toLowerCase();
    if (normalizeId_(rId) === normId && rEmail === cleanEmail) {
      matched = {
        studentId: rId,
        fullName: String(rows[i][2] || "").trim(),
        section: String(rows[i][3] || "").trim(),
      };
      break;
    }
  }

  if (!matched) {
    Utilities.sleep(1500);
    return {
      ok: false,
      status: "NOT_FOUND",
      message:
        "No matching registration found. Verify your Student ID and the exact email you submitted.",
    };
  }

  const compatEventId = cfg.V1_COMPAT_EVENT_ID || "DEFAULT";
  const issueProtocol =
    !cfg.V1_COMPAT_RETIRED && cfg.EVENT_ID === compatEventId ? "v1" : "v2";
  const issueEventId = cfg.EVENT_ID;

  const token =
    issueProtocol === "v2"
      ? createV2Signature_(issueEventId, matched.studentId, cfg.SECRET_SALT)
      : createSignature_(matched.studentId, cfg.SECRET_SALT);
  const payload =
    issueProtocol === "v2"
      ? `v2|${issueEventId}|${matched.studentId}|${token}`
      : `${matched.studentId}|${token}`;

  const qrBlob = generateQrPngBlob_(payload, `Pass_${matched.studentId}.png`);
  const qrBase64 = Utilities.base64Encode(qrBlob.getBytes());

  return {
    ok: true,
    eventTitle: cfg.EVENT_TITLE,
    eventId: issueEventId,
    protocol: issueProtocol,
    studentId: matched.studentId,
    fullName: matched.fullName,
    section: matched.section,
    payload,
    qrDataUri: `data:image/png;base64,${qrBase64}`,
  };
}

/**
 * Generates and emails signed QR passes for all pending Roster rows (Active event mode).
 */
function generateAndEmailQRPasses() {
  return sendPasses_(null, true, { mode: "ACTIVE" });
}

/**
 * Generates and emails signed QR passes only for the currently selected Roster row(s).
 */
function sendQRPassesToSelectedRows() {
  return sendSelectedRowsWithMode_("ACTIVE");
}

/**
 * Pre-issues v2 passes for persisted TARGET_EVENT_ID without changing active Config.EVENT_ID.
 */
function issueTargetEventV2Passes() {
  return sendPasses_(null, true, { mode: "TARGET" });
}

function issueTargetEventV2PassesSelectedRows() {
  return sendSelectedRowsWithMode_("TARGET");
}

function sendSelectedRowsWithMode_(mode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = ss.getActiveSheet();
  if (!activeSheet || activeSheet.getName() !== "Roster") {
    SpreadsheetApp.getUi().alert(
      'Please select one or more student rows in the "Roster" tab first.',
    );
    return;
  }
  const range = activeSheet.getActiveRange();
  if (!range) {
    SpreadsheetApp.getUi().alert("No cells selected in Roster.");
    return;
  }
  const startRow = range.getRow();
  const endRow = range.getLastRow();
  const indices = [];
  for (let r = startRow; r <= endRow; r++) {
    if (r >= 2) indices.push(r - 1);
  }
  if (indices.length === 0) {
    SpreadsheetApp.getUi().alert(
      "Select student rows (row 2 or below), not the header row.",
    );
    return;
  }
  return sendPasses_(indices, true, { mode: mode || "ACTIVE" });
}

/**
 * Shared quota-safe, lock-protected, row-shift-verified email sender using GmailApp.
 * Explicit mode: 'ACTIVE' (v1 only while !V1_COMPAT_RETIRED && EVENT_ID === V1_COMPAT_EVENT_ID;
 * otherwise v2 for active EVENT_ID) or 'TARGET' (v2 for persisted TARGET_EVENT_ID).
 */
function sendPasses_(targetRowIndices, requireConfirm, opts) {
  const mode =
    opts && opts.mode ? String(opts.mode).trim().toUpperCase() : "ACTIVE";
  if (mode !== "ACTIVE" && mode !== "TARGET") {
    throw new Error("Invalid issuance mode: " + mode);
  }

  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    ui.alert(
      "Email Sender Busy",
      "QR pass emailing is already running. Please wait for it to finish.",
      ui.ButtonSet.OK,
    );
    return { ok: false, reason: "LOCKED" };
  }

  const startMs = Date.now();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rosterSheet = ss.getSheetByName("Roster");
    if (!rosterSheet) throw new Error('Missing "Roster" tab.');

    const cfg = getConfig_();
    requireSecureConfig_(cfg);

    let issueProtocol = "v2";
    let issueEventId = cfg.EVENT_ID;

    if (mode === "TARGET") {
      const targetId = validateV2Field_(
        cfg.TARGET_EVENT_ID || "",
        "TARGET_EVENT_ID",
      );
      if (targetId === "DEFAULT" || targetId === cfg.EVENT_ID) {
        throw new Error(
          "TARGET_EVENT_ID must be a non-DEFAULT event distinct from active Config.EVENT_ID.",
        );
      }
      issueProtocol = "v2";
      issueEventId = targetId;
    } else {
      const compatEventId = cfg.V1_COMPAT_EVENT_ID || "DEFAULT";
      if (!cfg.V1_COMPAT_RETIRED && cfg.EVENT_ID === compatEventId) {
        issueProtocol = "v1";
      } else {
        issueProtocol = "v2";
      }
      issueEventId = cfg.EVENT_ID;
    }

    const lastRow = rosterSheet.getLastRow();
    if (lastRow <= 1) {
      ui.alert("Roster is empty.");
      return { ok: true, sent: 0 };
    }

    const totalCols = Math.max(14, rosterSheet.getLastColumn());
    const data = rosterSheet.getRange(1, 1, lastRow, totalCols).getValues();
    const candidateIndices = targetRowIndices
      ? targetRowIndices.filter((i) => i >= 1 && i < data.length)
      : Array.from({ length: data.length - 1 }, (_, k) => k + 1);

    const isAlreadyDispatchedForTarget = (row) => {
      const status = String(row[5] || "").trim();
      if (mode === "TARGET") {
        const rowProto = String(row[12] || "").trim();
        const rowEvt = String(row[13] || "").trim();
        return (
          status === "DISPATCHED" &&
          rowProto === "v2" &&
          rowEvt === issueEventId
        );
      }
      return status === "SENT" || status === "DISPATCHED";
    };

    const pendingIndices = candidateIndices.filter((i) => {
      const studentId = String(data[i][0] || "").trim();
      const cleanEmail = String(data[i][1] || "").trim();
      if (!studentId || !cleanEmail) return false;
      return targetRowIndices ? true : !isAlreadyDispatchedForTarget(data[i]);
    });

    if (pendingIndices.length === 0) {
      ui.alert("No pending passes to email.");
      return { ok: true, sent: 0 };
    }

    const initialQuota = MailApp.getRemainingDailyQuota();
    if (requireConfirm) {
      const alreadyCount = pendingIndices.filter((i) =>
        isAlreadyDispatchedForTarget(data[i]),
      ).length;
      const resendNote =
        alreadyCount > 0
          ? `\nAlready dispatched in selection: ${alreadyCount} (will be re-sent).`
          : "";
      const resp = ui.alert(
        "Confirm QR Pass Emailing",
        `Mode: ${mode} (${issueProtocol}, Event: ${issueEventId})\nReady to dispatch ${pendingIndices.length} participant(s) via GmailApp.${resendNote}\nRemaining daily email quota: ${initialQuota}.\n\nProceed?`,
        ui.ButtonSet.YES_NO,
      );
      if (resp !== ui.Button.YES) return { ok: false, reason: "CANCELLED" };
    }

    const rowCount = data.length - 1;
    const expectedNormIds = [];
    const efUpdates = [];
    const hlUpdates = [];
    const mnUpdates = [];
    const touchedSet = new Set();

    for (let i = 1; i < data.length; i++) {
      expectedNormIds.push(normalizeId_(data[i][0]));
      efUpdates.push([data[i][4] || "", data[i][5] || ""]);
      hlUpdates.push([
        data[i][7] || "",
        data[i][8] || "",
        data[i][9] || "",
        data[i][10] || "",
        data[i][11] || "",
      ]);
      mnUpdates.push([data[i][12] || "", data[i][13] || ""]);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let sent = 0;
    let errors = 0;
    let stoppedReason = "";

    try {
      for (const i of pendingIndices) {
        if (MailApp.getRemainingDailyQuota() <= 0) {
          stoppedReason = "Daily email quota reached.";
          break;
        }
        if (Date.now() - startMs > EMAIL_TIME_BUDGET_MS) {
          stoppedReason = "Time budget reached (4.5 min). Re-run to continue.";
          break;
        }

        const studentId = String(data[i][0] || "")
          .trim()
          .toUpperCase();
        const cleanEmail = String(data[i][1] || "").trim();
        const fullName = data[i][2];
        const section = data[i][3];
        const token =
          issueProtocol === "v2"
            ? createV2Signature_(issueEventId, studentId, cfg.SECRET_SALT)
            : createSignature_(studentId, cfg.SECRET_SALT);
        const payload =
          issueProtocol === "v2"
            ? `v2|${issueEventId}|${studentId}|${token}`
            : `${studentId}|${token}`;

        const prevAttempts = Number(data[i][9]) || 0;
        const attemptNum = prevAttempts + 1;

        touchedSet.add(i - 1);
        efUpdates[i - 1][0] = token;
        hlUpdates[i - 1][2] = attemptNum;
        mnUpdates[i - 1][0] = issueProtocol;
        mnUpdates[i - 1][1] = issueEventId;

        if (!emailRegex.test(cleanEmail)) {
          efUpdates[i - 1][1] = "INVALID_EMAIL";
          hlUpdates[i - 1][4] = "Invalid email format";
          errors++;
          continue;
        }

        let qrBlob;
        try {
          qrBlob = generateQrPngBlob_(payload, `Pass_${studentId}.png`);
        } catch (qrErr) {
          efUpdates[i - 1][1] = "QR_GEN_FAILED";
          hlUpdates[i - 1][4] = String(
            qrErr && qrErr.message ? qrErr.message : qrErr,
          ).substring(0, 120);
          errors++;
          continue;
        }

        try {
          const subject = `${cfg.EVENT_TITLE} (${issueEventId}) - Your QR Attendance Pass`;
          const plainBody = [
            `${cfg.EVENT_TITLE} (${issueEventId})`,
            `Participant: ${fullName || "Participant"}`,
            `Student ID: ${studentId}${section ? " | " + section : ""}`,
            `Manual Pass Code: ${payload}`,
            "",
            "Bring your physical School ID. You must be scanned at Check-In, Mid-Event, and Check-Out to qualify.",
          ].join("\n");

          const htmlBody = `
            <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; border: 1px solid #d0d7de; border-radius: 10px; padding: 20px; text-align: center;">
              <h2 style="margin: 0 0 8px 0;">${escapeHtml_(cfg.EVENT_TITLE)}</h2>
              <p style="margin: 0 0 8px 0; font-size: 12px; color: #555;">Event: ${escapeHtml_(issueEventId)}</p>
              <p style="margin: 4px 0; font-size: 16px;"><strong>${escapeHtml_(fullName || "Participant")}</strong></p>
              <p style="margin: 4px 0 14px 0; color: #555;">ID: ${escapeHtml_(studentId)}${section ? " | " + escapeHtml_(section) : ""}</p>
              <img src="cid:qrpass" alt="QR Pass" style="width: 240px; height: 240px;" />
              <p style="margin: 10px 0 4px 0; font-size: 13px; color: #111;">
                Manual Pass Code: <code style="background:#f3f4f6; padding:3px 6px; border-radius:4px;">${escapeHtml_(payload)}</code>
              </p>
              <p style="margin-top: 10px; font-size: 12px; color: #444; line-height: 1.4;">
                Save a screenshot of this pass and bring your physical School ID.<br>
                You must be scanned at <strong>Check-In</strong>, <strong>Mid-Event</strong>, and <strong>Check-Out</strong> to qualify.
              </p>
            </div>
          `;

          GmailApp.sendEmail(cleanEmail, subject, plainBody, {
            htmlBody,
            inlineImages: { qrpass: qrBlob },
          });

          efUpdates[i - 1][1] = "DISPATCHED";
          hlUpdates[i - 1][0] = token;
          hlUpdates[i - 1][1] = studentId;
          hlUpdates[i - 1][3] = new Date().toISOString();
          hlUpdates[i - 1][4] = "";
          sent++;
          Utilities.sleep(150);
        } catch (err) {
          efUpdates[i - 1][1] = "MAIL_API_ERROR";
          hlUpdates[i - 1][4] = String(
            err && err.message ? err.message : err,
          ).substring(0, 120);
          errors++;
        }
      }
    } finally {
      if (rowCount > 0 && touchedSet.size > 0) {
        const currentIds = rosterSheet.getRange(2, 1, rowCount, 1).getValues();
        let shifted = false;
        for (const idx of touchedSet) {
          const curNorm = normalizeId_(
            currentIds[idx] ? currentIds[idx][0] : "",
          );
          if (curNorm !== expectedNormIds[idx]) {
            shifted = true;
            break;
          }
        }
        if (shifted) {
          stoppedReason =
            (stoppedReason ? stoppedReason + " " : "") +
            "Roster rows shifted during send; batch write aborted to prevent Student ID mismatch.";
        } else {
          rosterSheet.getRange(2, 5, rowCount, 2).setValues(efUpdates);
          rosterSheet.getRange(2, 8, rowCount, 5).setValues(hlUpdates);
          rosterSheet.getRange(2, 13, rowCount, 2).setValues(mnUpdates);
        }
      }
      invalidateRosterCache_();
    }

    const summary =
      `Mode: ${mode} (${issueProtocol} / ${issueEventId})\nDispatched: ${sent}\nErrors: ${errors}` +
      (stoppedReason ? `\nNote: ${stoppedReason}` : "");
    ui.alert("QR Pass Email Summary", summary, ui.ButtonSet.OK);
    return {
      ok: true,
      mode,
      protocol: issueProtocol,
      eventId: issueEventId,
      sent,
      errors,
      stoppedReason,
    };
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
    SpreadsheetApp.getUi().alert(
      "Rebuild Busy",
      "Another scan or rebuild is in progress. Please try again in a moment.",
      SpreadsheetApp.getUi().ButtonSet.OK,
    );
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
  const rosterSheet = ss.getSheetByName("Roster");
  const logSheet = ss.getSheetByName("Attendance Log");
  const verSheet = ss.getSheetByName("Verified Attendance");
  if (!rosterSheet || !logSheet || !verSheet) return;

  const cfg = getConfig_();
  const summary = {};

  const rosterLastRow = rosterSheet.getLastRow();
  if (rosterLastRow > 1) {
    const rosterData = rosterSheet
      .getRange(2, 1, rosterLastRow - 1, 4)
      .getValues();
    for (let i = 0; i < rosterData.length; i++) {
      const rId = String(rosterData[i][0] || "")
        .trim()
        .toUpperCase();
      const normId = normalizeId_(rId);
      if (!normId) continue;
      summary[normId] = {
        studentId: rId,
        fullName: String(rosterData[i][2] || "").trim(),
        section: String(rosterData[i][3] || "").trim(),
        stages: {},
      };
    }
  }

  const logLastRow = logSheet.getLastRow();
  if (logLastRow > 1) {
    const logData = logSheet.getRange(2, 1, logLastRow - 1, 8).getValues();
    for (let r = 0; r < logData.length; r++) {
      const [ts, stage, rawId, name, sec, , status, eventId] = logData[r];
      if (String(status || "").trim() !== "ACCEPTED") continue;
      const rowEventId = String(eventId || "").trim() || "DEFAULT";
      if (rowEventId !== cfg.EVENT_ID) continue;

      const normId = normalizeId_(rawId);
      if (!normId) continue;

      if (!summary[normId]) {
        summary[normId] = {
          studentId: String(rawId || "")
            .trim()
            .toUpperCase(),
          fullName: String(name || "").trim(),
          section: String(sec || "").trim(),
          stages: {},
        };
      }

      const st = String(stage || "").trim();
      if (VALID_STAGES.includes(st) && !summary[normId].stages[st]) {
        summary[normId].stages[st] = Utilities.formatDate(
          new Date(ts),
          Session.getScriptTimeZone(),
          "HH:mm:ss",
        );
      }
    }
  }

  const outRows = [];
  Object.keys(summary)
    .sort()
    .forEach((k) => {
      const item = summary[k];
      const ci = item.stages["Check-In"] || "—";
      const me = item.stages["Mid-Event"] || "—";
      const co = item.stages["Check-Out"] || "—";
      const count =
        (ci !== "—" ? 1 : 0) + (me !== "—" ? 1 : 0) + (co !== "—" ? 1 : 0);
      const qualified = count === 3 ? "QUALIFIED" : "INCOMPLETE";
      outRows.push([
        safeCell_(item.studentId),
        safeCell_(item.fullName),
        safeCell_(item.section),
        ci,
        me,
        co,
        qualified,
        count,
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
      report.push(`✅ ${name}${detail ? ": " + detail : ""}`);
    } catch (err) {
      report.push(`❌ ${name}: ${err && err.message ? err.message : err}`);
    }
  };

  runStep("Config Keys & Validation", () => ensureConfigKeys_(ss));
  runStep("Secret Salt Initialization", () => ensureStrongSecretSalt_(ss));
  runStep("Sheets & Canonical Headers", () => ensureSheetsAndHeaders_(ss));
  runStep("Plain-Text ID Formatting", () => formatIdColumnsAsText_(ss));
  runStep("Backfill Missing Roster Tokens", () => backfillRosterTokens_(ss));
  runStep("Roster Integrity Audit", () => {
    const a = auditRosterIntegrity_(ss);
    return `Duplicates=${a.duplicateIds.length}, InvalidEmails=${a.invalidEmails.length}, MissingNames=${a.missingNames.length}, TokenDrift=${a.tokenDrift.length}`;
  });
  runStep("Conditional Formatting", () => applyConditionalFormatting_(ss));
  runStep("Installable Triggers (5-Min + onEdit)", () =>
    ensureInstallableTriggers_(),
  );
  runStep("Rebuild Verified Attendance", () => {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error("Lock busy");
    try {
      rebuildVerifiedAttendance_();
    } finally {
      lock.releaseLock();
    }
    return "Synced to active EVENT_ID";
  });
  runStep("Security Audit", () => {
    const cfg = getConfig_();
    requireSecureConfig_(cfg);
    return `PIN & Salt valid (EVENT_ID=${cfg.EVENT_ID}, LOCKED_STAGE=${cfg.LOCKED_STAGE})`;
  });

  SpreadsheetApp.getUi().alert(
    "System Upgrades Complete",
    report.join("\n"),
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

function ensureConfigKeys_(ss) {
  let sheet = ss.getSheetByName("Config");
  if (!sheet) {
    sheet = ss.insertSheet("Config");
    sheet.getRange(1, 1, 1, 3).setValues([["Key", "Value", "Notes"]]);
  }
  const rows = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [];
  const existingKeys = new Set(rows.map((r) => String(r[0] || "").trim()));
  const defaults = [
    [
      "EVENT_ID",
      "DEFAULT",
      "Unique identifier for the active event (scopes duplicates and Verified Attendance)",
    ],
    ["LOCKED_STAGE", "AUTO", "Set to Check-In, Mid-Event, Check-Out, or AUTO"],
    [
      "ENFORCE_STAGE_ORDER",
      "FALSE",
      "If TRUE, requires Check-In before Mid-Event and Mid-Event before Check-Out",
    ],
    [
      "AUTO_EMAIL_ON_SUBMIT",
      "FALSE",
      "FALSE = zero-email QR Pass Portal mode (unlimited); set TRUE to also email on Form submit",
    ],
  ];
  const toAdd = defaults.filter(([k]) => !existingKeys.has(k));
  if (toAdd.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
  }

  // Apply dropdown validation to LOCKED_STAGE value cell
  const updatedRows = sheet.getDataRange().getValues();
  for (let i = 0; i < updatedRows.length; i++) {
    if (String(updatedRows[i][0] || "").trim() === "LOCKED_STAGE") {
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(
          ["AUTO", "Check-In", "Mid-Event", "Check-Out"],
          true,
        )
        .setAllowInvalid(false)
        .build();
      sheet.getRange(i + 1, 2).setDataValidation(rule);
      break;
    }
  }
  return toAdd.length
    ? `Added ${toAdd.map((r) => r[0]).join(", ")}`
    : "All keys present";
}

/**
 * Generates a cryptographically strong 32-char hex SECRET_SALT automatically
 * on fresh template copies when SECRET_SALT is missing or still PLACEHOLDER_SALT.
 * Never overwrites an already-configured or ScriptProperties-migrated secret.
 */
function ensureStrongSecretSalt_(ss) {
  const cfg = getConfig_();
  if (
    cfg.SECRET_SALT &&
    cfg.SECRET_SALT !== PLACEHOLDER_SALT &&
    cfg.SECRET_SALT.length >= 16
  ) {
    return "Existing secret preserved";
  }

  const generated = sha256HexPrefix_(
    `${Utilities.getUuid()}|${Utilities.getUuid()}|${Date.now()}`,
    32,
  );
  const sheet = ss.getSheetByName("Config");
  if (!sheet) throw new Error("Missing Config tab.");

  const rows = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [];
  let updated = false;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === "SECRET_SALT") {
      sheet.getRange(i + 1, 2).setValue(generated);
      updated = true;
      break;
    }
  }
  if (!updated) {
    sheet.appendRow([
      "SECRET_SALT",
      generated,
      "Auto-generated 32-char secret for QR token signing",
    ]);
  }
  return "Auto-generated 32-char random SECRET_SALT";
}

function ensureSheetsAndHeaders_(ss) {
  const specs = [
    { name: "Config", headers: ["Key", "Value", "Notes"] },
    {
      name: "Roster",
      headers: [
        "Student ID",
        "Email",
        "Full Name",
        "Section",
        "Token",
        "Pass Status",
        "QR Preview",
        "Last Sent Token",
        "Last Sent ID",
        "Attempt #",
        "Dispatched At",
        "Last Error",
        "Pass Protocol",
        "Pass Event ID",
      ],
    },
    {
      name: "Attendance Log",
      headers: [
        "Timestamp",
        "Stage",
        "Student ID",
        "Full Name",
        "Section",
        "Usher Label",
        "Scan Status",
        "Event ID",
      ],
    },
    {
      name: "Verified Attendance",
      headers: [
        "Student ID",
        "Full Name",
        "Section",
        "Check-In",
        "Mid-Event",
        "Check-Out",
        "Qualification",
        "Stage Count",
      ],
    },
  ];
  let updated = 0;
  specs.forEach((spec) => {
    let sheet = ss.getSheetByName(spec.name);
    if (!sheet) sheet = ss.insertSheet(spec.name);
    const current = sheet.getRange(1, 1, 1, spec.headers.length).getValues()[0];
    let dirty = false;
    const merged = spec.headers.map((h, idx) => {
      if (String(current[idx] || "").trim() === "") {
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
  return updated
    ? `Repaired headers on ${updated} tab(s)`
    : "All headers intact";
}

function formatIdColumnsAsText_(ss) {
  const targets = [
    { name: "Roster", col: 1 },
    { name: "Attendance Log", col: 3 },
    { name: "Verified Attendance", col: 1 },
  ];
  targets.forEach((t) => {
    const s = ss.getSheetByName(t.name);
    if (s)
      s.getRange(2, t.col, Math.max(1, s.getMaxRows() - 1), 1).setNumberFormat(
        "@",
      );
  });
  return "Applied @ format to ID columns";
}

/**
 * Audits Roster for duplicate normalized IDs, invalid emails, missing names, and token drift.
 * Distinguishes Student ID edits (TOKEN_DRIFT_ID_CHANGED) from secret rotation (TOKEN_DRIFT_SECRET_ROTATED).
 */
function auditRosterIntegrity_(ss) {
  const result = {
    duplicateIds: [],
    invalidEmails: [],
    missingNames: [],
    tokenDrift: [],
  };
  const rosterSheet = ss.getSheetByName("Roster");
  if (!rosterSheet || rosterSheet.getLastRow() <= 1) return result;

  const cfg = getConfig_();
  const hasSalt =
    cfg.SECRET_SALT &&
    cfg.SECRET_SALT !== PLACEHOLDER_SALT &&
    cfg.SECRET_SALT.length >= 16;
  const lastRow = rosterSheet.getLastRow();
  const numCols = Math.max(6, Math.min(9, rosterSheet.getLastColumn()));
  const rows = rosterSheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  const seenIds = {};
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const rawId = String(rows[i][0] || "")
      .trim()
      .toUpperCase();
    const email = String(rows[i][1] || "").trim();
    const fullName = String(rows[i][2] || "").trim();
    const token = String(rows[i][4] || "")
      .trim()
      .toUpperCase();
    const lastSentToken =
      numCols >= 8
        ? String(rows[i][7] || "")
            .trim()
            .toUpperCase()
        : "";
    const lastSentId =
      numCols >= 9
        ? String(rows[i][8] || "")
            .trim()
            .toUpperCase()
        : "";
    const normId = normalizeId_(rawId);

    if (normId) {
      if (seenIds[normId]) {
        result.duplicateIds.push({
          row: rowNum,
          firstRow: seenIds[normId],
          studentId: rawId,
          normId,
        });
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
        const reason =
          lastSentId && normalizeId_(lastSentId) !== normId
            ? "TOKEN_DRIFT_ID_CHANGED"
            : "TOKEN_DRIFT_SECRET_ROTATED";
        result.tokenDrift.push({ row: rowNum, studentId: rawId, reason });
      }
    }
  }
  return result;
}

function backfillRosterTokens_(ss) {
  const rosterSheet = ss.getSheetByName("Roster");
  if (!rosterSheet || rosterSheet.getLastRow() <= 1) return "No roster rows";
  const cfg = getConfig_();
  requireSecureConfig_(cfg);

  const count = rosterSheet.getLastRow() - 1;
  const idsAndTokens = rosterSheet.getRange(2, 1, count, 5).getValues();
  const tokenCol = [];
  let filled = 0;
  for (let i = 0; i < idsAndTokens.length; i++) {
    const studentId = String(idsAndTokens[i][0] || "")
      .trim()
      .toUpperCase();
    const existing = String(idsAndTokens[i][4] || "").trim();
    const expected = studentId
      ? createSignature_(studentId, cfg.SECRET_SALT)
      : "";
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
    const preserved = sheet.getConditionalFormatRules().filter((rule) => {
      const ranges = rule.getRanges ? rule.getRanges() : [];
      return !ranges.some((r) => r.getColumn && r.getColumn() === colNum);
    });
    sheet.setConditionalFormatRules(preserved.concat(newRules));
  };

  const logSheet = ss.getSheetByName("Attendance Log");
  if (logSheet) {
    const range = logSheet.getRange(
      2,
      7,
      Math.max(1, logSheet.getMaxRows() - 1),
      1,
    );
    const rules = [
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo("ACCEPTED")
        .setBackground("#d1fae5")
        .setFontColor("#065f46")
        .setRanges([range])
        .build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo("DUPLICATE")
        .setBackground("#fef3c7")
        .setFontColor("#92400e")
        .setRanges([range])
        .build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextStartsWith("REJECTED")
        .setBackground("#fee2e2")
        .setFontColor("#991b1b")
        .setRanges([range])
        .build(),
    ];
    replaceColRules(logSheet, 7, rules);
  }

  const verSheet = ss.getSheetByName("Verified Attendance");
  if (verSheet) {
    const range = verSheet.getRange(
      2,
      7,
      Math.max(1, verSheet.getMaxRows() - 1),
      1,
    );
    const rules = [
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo("QUALIFIED")
        .setBackground("#d1fae5")
        .setFontColor("#065f46")
        .setRanges([range])
        .build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo("INCOMPLETE")
        .setBackground("#fef3c7")
        .setFontColor("#92400e")
        .setRanges([range])
        .build(),
    ];
    replaceColRules(verSheet, 7, rules);
  }
  return "Updated Log & Verified Attendance rules (preserved custom rules)";
}

function ensureInstallableTriggers_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const existing = ScriptApp.getProjectTriggers();
  const rebuildTriggers = existing.filter(
    (t) => t.getHandlerFunction() === "rebuildVerifiedAttendanceTrigger",
  );
  if (rebuildTriggers.length !== 1) {
    rebuildTriggers.forEach((t) => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger("rebuildVerifiedAttendanceTrigger")
      .timeBased()
      .everyMinutes(5)
      .create();
  }
  const editTriggers = existing.filter(
    (t) => t.getHandlerFunction() === "onSheetEdit",
  );
  if (editTriggers.length !== 1) {
    editTriggers.forEach((t) => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger("onSheetEdit").forSpreadsheet(ss).onEdit().create();
  }
  return "5-minute + onEdit triggers active";
}

/**
 * Migrates USHER_PIN and SECRET_SALT from Config into ScriptProperties,
 * read-back verifies both values, initializes V1_COMPAT_EVENT_ID once,
 * and only then clears the plaintext Config cells.
 */
function migrateSecretsToProperties() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getConfig_();
  requireSecureConfig_(cfg);

  const props = PropertiesService.getScriptProperties();
  const toStore = {
    USHER_PIN: cfg.USHER_PIN,
    SECRET_SALT: cfg.SECRET_SALT,
  };
  if (!props.getProperty("V1_COMPAT_EVENT_ID")) {
    toStore.V1_COMPAT_EVENT_ID = cfg.EVENT_ID || "DEFAULT";
  }
  props.setProperties(toStore);

  // Read-back verification before clearing plaintext Config cells
  if (
    props.getProperty("USHER_PIN") !== cfg.USHER_PIN ||
    props.getProperty("SECRET_SALT") !== cfg.SECRET_SALT
  ) {
    throw new Error(
      "ScriptProperties read-back verification failed; Config left untouched.",
    );
  }

  const configSheet = ss.getSheetByName("Config");
  if (configSheet && configSheet.getLastRow() > 1) {
    const rows = configSheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const k = String(rows[i][0] || "").trim();
      if (k === "USHER_PIN" || k === "SECRET_SALT") {
        configSheet.getRange(i + 1, 2).setValue("");
      }
    }
  }
  return { ok: true, compatEventId: props.getProperty("V1_COMPAT_EVENT_ID") };
}

/**
 * Authorized rollback helper: restores USHER_PIN and SECRET_SALT from ScriptProperties
 * back into Config before redeploying an older Config-only version.
 */
function restoreSecretsToConfigFromProperties() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const pin = props.getProperty("USHER_PIN");
  const salt = props.getProperty("SECRET_SALT");
  if (!pin || !salt) {
    throw new Error("Missing USHER_PIN or SECRET_SALT in ScriptProperties.");
  }
  const configSheet = ss.getSheetByName("Config");
  if (!configSheet) throw new Error("Missing Config tab.");

  const rows = configSheet.getDataRange().getValues();
  let wrotePin = false;
  let wroteSalt = false;
  for (let i = 1; i < rows.length; i++) {
    const k = String(rows[i][0] || "").trim();
    if (k === "USHER_PIN") {
      configSheet.getRange(i + 1, 2).setValue(pin);
      wrotePin = true;
    } else if (k === "SECRET_SALT") {
      configSheet.getRange(i + 1, 2).setValue(salt);
      wroteSalt = true;
    }
  }
  if (!wrotePin || !wroteSalt) {
    throw new Error("Could not find USHER_PIN and SECRET_SALT rows in Config.");
  }
  return { ok: true };
}

/**
 * Rotates SECRET_SALT while preserving the prior key in LEGACY_SECRET_SALT.
 * Refuses to execute if LEGACY_SECRET_SALT is already populated.
 */
function rotateSecretSalt(newSalt) {
  const cleanNew = String(newSalt || "").trim();
  if (!cleanNew || cleanNew === PLACEHOLDER_SALT || cleanNew.length < 16) {
    throw new Error(
      "New SECRET_SALT must be at least 16 non-placeholder characters.",
    );
  }
  const cfg = getConfig_();
  requireSecureConfig_(cfg);

  const props = PropertiesService.getScriptProperties();
  if (props.getProperty("LEGACY_SECRET_SALT")) {
    throw new Error(
      "LEGACY_SECRET_SALT is still active. Run retireLegacySecretSalt() after reissuing passes before rotating again.",
    );
  }

  props.setProperties({
    LEGACY_SECRET_SALT: cfg.SECRET_SALT,
    SECRET_SALT: cleanNew,
  });
  return { ok: true };
}

function retireLegacySecretSalt() {
  PropertiesService.getScriptProperties().deleteProperty("LEGACY_SECRET_SALT");
  return { ok: true };
}

/**
 * Persists TARGET_EVENT_ID in ScriptProperties for pre-transition v2 issuance
 * without changing active Config.EVENT_ID.
 */
function setTargetEventId(targetEventId) {
  const cleanTarget = validateV2Field_(targetEventId, "TARGET_EVENT_ID");
  if (cleanTarget === "DEFAULT") {
    throw new Error(
      "TARGET_EVENT_ID cannot be DEFAULT (reserved exclusively for legacy v1 compatibility).",
    );
  }
  const cfg = getConfig_();
  if (cleanTarget === cfg.EVENT_ID) {
    throw new Error(
      "TARGET_EVENT_ID must differ from the active Config.EVENT_ID.",
    );
  }
  PropertiesService.getScriptProperties().setProperty(
    "TARGET_EVENT_ID",
    cleanTarget,
  );
  return { ok: true, targetEventId: cleanTarget };
}

/**
 * Evaluates roster-wide readiness and distribution reconciliation for TARGET_EVENT_ID.
 * Note: DISPATCHED is never treated as proof of inbox delivery; unresolvedRecipients
 * must be explicitly acknowledged by the operator before transition.
 */
function evaluateTransitionReadiness_(ss, cfg, targetId) {
  const audit = auditRosterIntegrity_(ss);
  const rosterSheet = ss.getSheetByName("Roster");
  const missingIssuance = [];
  const failedDispatch = [];
  const unresolvedRecipients = [];
  const digestParts = [targetId];

  if (!rosterSheet || rosterSheet.getLastRow() <= 1) {
    return {
      targetId,
      eligibleCount: 0,
      duplicates: audit.duplicateIds,
      invalidRecords: [...audit.invalidEmails, ...audit.missingNames],
      missingIssuance: [{ row: 0, reason: "Roster is empty" }],
      failedDispatch,
      unresolvedRecipients,
      readyToAcknowledge: false,
      digest: "",
    };
  }

  const lastRow = rosterSheet.getLastRow();
  const totalCols = Math.max(14, rosterSheet.getLastColumn());
  const rows = rosterSheet.getRange(2, 1, lastRow - 1, totalCols).getValues();
  let eligibleCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const rawId = String(rows[i][0] || "")
      .trim()
      .toUpperCase();
    const email = String(rows[i][1] || "").trim();
    const fullName = String(rows[i][2] || "").trim();
    const token = String(rows[i][4] || "")
      .trim()
      .toUpperCase();
    const status = String(rows[i][5] || "").trim();
    const lastSentToken = String(rows[i][7] || "")
      .trim()
      .toUpperCase();
    const lastSentId = String(rows[i][8] || "")
      .trim()
      .toUpperCase();
    const proto = String(rows[i][12] || "").trim();
    const passEvt = String(rows[i][13] || "").trim();

    const attemptNum = String(
      rows[i][9] === undefined || rows[i][9] === null ? "" : rows[i][9],
    ).trim();
    const dispatchedAt = String(
      rows[i][10] === undefined || rows[i][10] === null ? "" : rows[i][10],
    ).trim();
    const lastError = String(
      rows[i][11] === undefined || rows[i][11] === null ? "" : rows[i][11],
    ).trim();

    if (!rawId && !email && !fullName) continue;
    eligibleCount++;

    const expectedV2 = rawId
      ? createV2Signature_(targetId, rawId, cfg.SECRET_SALT)
      : "";
    if (
      proto !== "v2" ||
      passEvt !== targetId ||
      token !== expectedV2 ||
      lastSentToken !== expectedV2 ||
      lastSentId !== rawId
    ) {
      missingIssuance.push({ row: rowNum, studentId: rawId, proto, passEvt });
    } else if (status !== "DISPATCHED") {
      failedDispatch.push({ row: rowNum, studentId: rawId, status });
    } else {
      unresolvedRecipients.push({
        row: rowNum,
        studentId: rawId,
        email,
        status: "DISPATCHED_UNCONFIRMED",
      });
    }

    digestParts.push(
      JSON.stringify([
        normalizeId_(rawId),
        email,
        fullName,
        token,
        status,
        lastSentToken,
        lastSentId,
        proto,
        passEvt,
        attemptNum,
        dispatchedAt,
        lastError,
      ]),
    );
  }

  const invalidRecords = [...audit.invalidEmails, ...audit.missingNames];
  const readyToAcknowledge =
    eligibleCount > 0 &&
    audit.duplicateIds.length === 0 &&
    invalidRecords.length === 0 &&
    missingIssuance.length === 0 &&
    failedDispatch.length === 0;
  const digest = sha256HexPrefix_(digestParts.join("\n"), 32);

  return {
    targetId,
    eligibleCount,
    duplicates: audit.duplicateIds,
    invalidRecords,
    missingIssuance,
    failedDispatch,
    unresolvedRecipients,
    readyToAcknowledge,
    digest,
  };
}

function reconcileTargetEventDistribution() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getConfig_();
  requireSecureConfig_(cfg);
  const targetId = validateV2Field_(
    cfg.TARGET_EVENT_ID || "",
    "TARGET_EVENT_ID",
  );
  return evaluateTransitionReadiness_(ss, cfg, targetId);
}

function acknowledgeTargetDistribution(expectedDigest) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getConfig_();
  requireSecureConfig_(cfg);
  const targetId = validateV2Field_(
    cfg.TARGET_EVENT_ID || "",
    "TARGET_EVENT_ID",
  );
  const report = evaluateTransitionReadiness_(ss, cfg, targetId);
  if (!report.readyToAcknowledge) {
    throw new Error(
      "Roster is not ready for distribution acknowledgement (fix duplicates, invalid records, missing issuance, or failed dispatches first).",
    );
  }
  if (expectedDigest && String(expectedDigest).trim() !== report.digest) {
    throw new Error(
      "Distribution state changed since reconciliation report was generated; re-run reconciliation.",
    );
  }
  PropertiesService.getScriptProperties().setProperty(
    "TRANSITION_RECON_ACK",
    `${targetId}|${report.digest}`,
  );
  return { ok: true, targetId, digest: report.digest };
}

/**
 * Resumable 7-step transition from active event (e.g., DEFAULT) to TARGET_EVENT_ID:
 * 1) Validate TARGET_EVENT_ID, 2) Fail-closed roster readiness & operator reconciliation ack,
 * 3) Persist EVENT_TRANSITION_PENDING, 4) Persist V1_COMPAT_RETIRED = TRUE (irreversible),
 * 5) Set Config.EVENT_ID = TARGET_EVENT_ID, 6) Verify v2 acceptance & old-event rejection,
 * 7) Clear EVENT_TRANSITION_PENDING.
 */
function transitionToTargetEvent() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const cfg = getConfig_();
  requireSecureConfig_(cfg);

  const targetId = validateV2Field_(
    props.getProperty("TARGET_EVENT_ID") || "",
    "TARGET_EVENT_ID",
  );
  if (targetId === "DEFAULT") {
    throw new Error("TARGET_EVENT_ID cannot be DEFAULT.");
  }

  const isPending =
    String(
      props.getProperty("EVENT_TRANSITION_PENDING") || "",
    ).toUpperCase() === "TRUE";
  const isRetired =
    String(props.getProperty("V1_COMPAT_RETIRED") || "").toUpperCase() ===
    "TRUE";

  // Post-Step-7 idempotency guard: completed transition returns deterministically without requiring TRANSITION_RECON_ACK
  if (cfg.EVENT_ID === targetId && isRetired && !isPending) {
    return {
      ok: true,
      alreadyCompleted: true,
      activeEventId: targetId,
      v1Retired: true,
    };
  }

  // Step 2: Fail-closed readiness & distribution acknowledgement BEFORE setting pending/retired
  // (Skip re-gating only if already past Step 4 with V1_COMPAT_RETIRED=TRUE & EVENT_TRANSITION_PENDING=TRUE)
  const resumingPostRetirement = isPending && isRetired;
  if (!resumingPostRetirement) {
    const report = evaluateTransitionReadiness_(ss, cfg, targetId);
    if (!report.readyToAcknowledge) {
      throw new Error(
        `Transition readiness failed: missingIssuance=${report.missingIssuance.length}, failedDispatch=${report.failedDispatch.length}, duplicates=${report.duplicates.length}, invalid=${report.invalidRecords.length}`,
      );
    }
    const ack = String(props.getProperty("TRANSITION_RECON_ACK") || "");
    if (ack !== `${targetId}|${report.digest}`) {
      throw new Error(
        "Operator distribution reconciliation acknowledgement is missing or invalidated by Roster changes.",
      );
    }
  }

  // Step 3: Persist pending state
  props.setProperty("EVENT_TRANSITION_PENDING", "TRUE");

  // Step 4: Irreversibly retire v1 compatibility
  props.setProperty("V1_COMPAT_RETIRED", "TRUE");

  // Step 5: Activate target by updating Config.EVENT_ID
  const configSheet = ss.getSheetByName("Config");
  if (!configSheet) throw new Error("Missing Config tab.");
  const rows = configSheet.getDataRange().getValues();
  let updated = false;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === "EVENT_ID") {
      configSheet.getRange(i + 1, 2).setValue(targetId);
      updated = true;
      break;
    }
  }
  if (!updated) {
    configSheet
      .getRange(configSheet.getLastRow() + 1, 1, 1, 3)
      .setValues([["EVENT_ID", targetId, "Active event ID"]]);
  }

  // Step 6: Self-verify target v2 signature acceptance & v1 rejection
  const afterCfg = getConfig_();
  if (afterCfg.EVENT_ID !== targetId || !afterCfg.V1_COMPAT_RETIRED) {
    throw new Error(
      "Transition verification failed; EVENT_TRANSITION_PENDING retained.",
    );
  }
  const probeSig = createV2Signature_(
    targetId,
    "PROBE001",
    afterCfg.SECRET_SALT,
  );
  if (!verifyV2Signature_(targetId, "PROBE001", probeSig, afterCfg)) {
    throw new Error(
      "Target v2 self-verification failed; EVENT_TRANSITION_PENDING retained.",
    );
  }

  // Step 7: Clear pending state & ack only after successful verification
  props.deleteProperty("EVENT_TRANSITION_PENDING");
  props.deleteProperty("TRANSITION_RECON_ACK");
  return { ok: true, activeEventId: targetId, v1Retired: true };
}

      const DEFAULT_API_URL =
        (window.CSSO_CONFIG && window.CSSO_CONFIG.DEFAULT_API_URL) ||
        "https://script.google.com/macros/s/AKfycbwUMbXFKERYyNEWdGgDavVR4miCPD7OsDPBud_YsjSe3FbPdW-UiN26gclamX8UD_ou/exec";
      const GAS_EXEC_RE =
        /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
      const IS_LOCAL_HOST =
        window.location.hostname === "127.0.0.1" ||
        window.location.hostname === "localhost";
      const LOCAL_API_RE =
        /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[A-Za-z0-9_\/-]+$/;
      const rawApiParam = (
        new URLSearchParams(window.location.search).get("api") || ""
      ).trim();
      const isTrustedApi =
        GAS_EXEC_RE.test(rawApiParam) ||
        (IS_LOCAL_HOST && LOCAL_API_RE.test(rawApiParam));
      const UNTRUSTED_API_WARNING = Boolean(rawApiParam && !isTrustedApi);
      const API_URL = isTrustedApi ? rawApiParam : DEFAULT_API_URL;
      const SESSION_KEY = "csso_session_token";
      const LOCAL_SEEN_KEY = "csso_local_seen_v1";
      const SCAN_QUEUE_KEY = "csso_scan_queue_v1";
      const SNAPSHOT_CACHE_KEY = "csso_snapshot_v1";
      const SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
      const STAGE_BITS = { "Check-In": 1, "Mid-Event": 2, "Check-Out": 4 };
      const CAMERA_COOLDOWN_MS = 4000;
      const FETCH_TIMEOUT_MS = 15000;
      const KEEP_WARM_INTERVAL_MS = 240000; // 4 minutes (prevents Apps Script V8 cold starts)
      const SYNC_INTERVAL_MS = 5000; // 5-second background batch sync
      const SYNC_BATCH_THRESHOLD = 10;

      let html5QrCode = null;
      let isProcessing = false;
      let isStarting = false;
      let sessionToken = "";
      let activeEventId = "DEFAULT";
      let localSeen = {};
      let scanQueue = [];
      let isSyncing = false;
      let snapshotReady = false;
      let snapshotRoster = {};
      let snapshotSeen = {};
      let snapshotEnforceOrder = false;
      let snapshotRequireMidEvent = true;
      let snapshotV1Retired = false;
      let snapshotV1CompatEventId = "DEFAULT";
      let snapshotLockedStage = "AUTO";
      let syncAlerts = 0;
      let lastCameraPayload = "";
      let lastCameraTime = 0;
      let acceptedCount = 0;
      let audioCtx = null;
      let keepWarmTimer = null;
      let syncTimer = null;
      let pendingConfirm = null;

      function normalizeIdLocal(id) {
        return String(id || "")
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "");
      }

      function getScanQueueKey() {
        try {
          const hash = btoa(
            unescape(encodeURIComponent(`${API_URL}|${activeEventId}`)),
          )
            .replace(/[^A-Za-z0-9]/g, "")
            .slice(-16);
          return `${SCAN_QUEUE_KEY}_${hash}`;
        } catch (e) {
          return SCAN_QUEUE_KEY;
        }
      }

      function loadScanQueue() {
        try {
          const raw = localStorage.getItem(getScanQueueKey());
          scanQueue = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(scanQueue)) scanQueue = [];
        } catch (e) {
          scanQueue = [];
        }
        updateSyncUI();
      }

      function saveScanQueue() {
        try {
          localStorage.setItem(getScanQueueKey(), JSON.stringify(scanQueue));
        } catch (e) {}
        updateSyncUI();
      }

      function updateSyncUI() {
        const badge = document.getElementById("syncBadge");
        const btn = document.getElementById("syncNowBtn");
        if (!badge) return;
        const pending = scanQueue.length;
        if (isSyncing) {
          badge.style.color = "#fbbf24";
          badge.textContent = `Syncing ${pending} scan(s)...`;
        } else if (pending > 0) {
          badge.style.color =
            navigator.onLine === false ? "#94a3b8" : "#fbbf24";
          badge.textContent =
            navigator.onLine === false
              ? `Offline (${pending} queued)`
              : `Instant Mode • Pending: ${pending}`;
        } else if (snapshotReady) {
          badge.style.color = "#34d399";
          badge.textContent = `Instant Mode • Synced ✓ (${Object.keys(snapshotRoster).length} roster)`;
        } else {
          badge.style.color = "#94a3b8";
          badge.textContent = "Online Mode (loading snapshot...)";
        }
        if (btn) btn.disabled = isSyncing || pending === 0;
      }

      function applyStageLockUI(lockedStage, eventId) {
        const badgeEl = document.getElementById("eventIdBadge");
        if (badgeEl && eventId) badgeEl.textContent = eventId;
        const stageSelect = document.getElementById("stageSelect");
        const lockBadge = document.getElementById("stageLockBadge");
        if (stageSelect && lockBadge) {
          if (lockedStage && lockedStage !== "AUTO") {
            stageSelect.value = lockedStage;
            stageSelect.disabled = true;
            lockBadge.style.display = "inline-block";
          } else {
            stageSelect.disabled = false;
            lockBadge.style.display = "none";
          }
          syncStagePills();
        }
      }

      function getSnapshotCacheKey() {
        try {
          const hash = btoa(unescape(encodeURIComponent(API_URL)))
            .replace(/[^A-Za-z0-9]/g, "")
            .slice(-16);
          return `${SNAPSHOT_CACHE_KEY}_${hash}`;
        } catch (e) {
          return SNAPSHOT_CACHE_KEY;
        }
      }

      function saveOfflineSnapshot(snap) {
        if (!snap || !snap.roster) return;
        try {
          localStorage.setItem(
            getSnapshotCacheKey(),
            JSON.stringify({
              eventTitle: snap.eventTitle || "",
              eventId: snap.eventId || activeEventId,
              lockedStage: snap.lockedStage || "AUTO",
              enforceStageOrder: !!snap.enforceStageOrder,
              requireMidEvent: snap.requireMidEvent !== false,
              v1Retired: !!snap.v1Retired,
              v1CompatEventId: snap.v1CompatEventId || "DEFAULT",
              roster: snap.roster,
              seen: snap.seen || {},
              savedAt: Date.now(),
            }),
          );
        } catch (e) {}
      }

      function loadOfflineSnapshot() {
        try {
          const raw = localStorage.getItem(getSnapshotCacheKey());
          if (!raw) return null;
          const snap = JSON.parse(raw);
          if (!snap || !snap.roster) return null;
          if (snap.savedAt && Date.now() - Number(snap.savedAt) > SNAPSHOT_TTL_MS) {
            localStorage.removeItem(getSnapshotCacheKey());
            return null;
          }
          return snap;
        } catch (e) {
          return null;
        }
      }

      function clearOfflineSnapshot() {
        try {
          localStorage.removeItem(getSnapshotCacheKey());
        } catch (e) {}
      }

      function applySnapshotData(snap) {
        const prevEventId = activeEventId;
        snapshotRoster = snap.roster || {};
        snapshotSeen = snap.seen || {};
        snapshotEnforceOrder = !!snap.enforceStageOrder;
        snapshotRequireMidEvent = snap.requireMidEvent !== false;
        const midPill = document.querySelector('.stage-pill[data-stage="Mid-Event"]');
        if (midPill) {
          midPill.textContent = snapshotRequireMidEvent
            ? "Mid-Event"
            : "Mid-Event (Optional)";
        }
        snapshotV1Retired = !!snap.v1Retired;
        snapshotV1CompatEventId = snap.v1CompatEventId || "DEFAULT";
        snapshotLockedStage = snap.lockedStage || "AUTO";
        activeEventId = snap.eventId || activeEventId;
        if (activeEventId !== prevEventId) {
          loadScanQueue();
        }
        snapshotReady = true;
        applyStageLockUI(snapshotLockedStage, activeEventId);
        updateSyncUI();
      }

      async function loadSnapshot() {
        if (!sessionToken) return;
        if (!snapshotReady) {
          const cached = loadOfflineSnapshot();
          if (cached) applySnapshotData(cached);
        }
        try {
          const snap = await apiCall({ action: "snapshot", sessionToken });
          if (snap && snap.ok) {
            applySnapshotData(snap);
            saveOfflineSnapshot(snap);
          }
        } catch (e) {
          updateSyncUI();
        }
      }

      function startSyncLoop() {
        if (syncTimer) return;
        syncTimer = setInterval(() => {
          if (
            sessionToken &&
            scanQueue.length > 0 &&
            !isSyncing &&
            navigator.onLine !== false
          ) {
            flushScanQueue(false);
          }
        }, SYNC_INTERVAL_MS);
      }

      function stopSyncLoop() {
        if (syncTimer) {
          clearInterval(syncTimer);
          syncTimer = null;
        }
      }

      async function flushScanQueue(manualTrigger) {
        const eligible = scanQueue.filter(
          (x) => !x.eventId || x.eventId === activeEventId,
        );
        if (!sessionToken || isSyncing || eligible.length === 0) return;
        isSyncing = true;
        updateSyncUI();
        const batch = eligible.slice(0, 50);
        const batchIds = new Set(batch.map((x) => x.clientId));
        const wireScans = batch.map((x) => ({
          clientId: x.clientId,
          payload: x.payload,
          stage: x.stage,
          scannedAt: x.scannedAt,
        }));
        try {
          const res = await apiCall({
            action: "scanBatch",
            sessionToken,
            scans: wireScans,
          });
          if (res && res.status === "UNAUTHORIZED") {
            isSyncing = false;
            updateSyncUI();
            returnToPinScreen(
              res.message ||
                "Session expired. Log in again to sync queued scans.",
            );
            return;
          }
          if (res && res.ok) {
            if (res.lockedStage || res.eventId) {
              snapshotLockedStage = res.lockedStage || snapshotLockedStage;
              activeEventId = res.eventId || activeEventId;
              applyStageLockUI(snapshotLockedStage, activeEventId);
            }
            scanQueue = scanQueue.filter((x) => !batchIds.has(x.clientId));
            saveScanQueue();
            if (res.seen) {
              const merged = Object.assign({}, res.seen);
              for (const item of scanQueue) {
                if (
                  (!item.eventId || item.eventId === activeEventId) &&
                  item.normId &&
                  item.bit
                ) {
                  merged[item.normId] = (merged[item.normId] || 0) | item.bit;
                }
              }
              snapshotSeen = merged;
            }
            const rejected = (res.results || []).filter(
              (r) => r.status && r.status !== "OK",
            );
            if (rejected.length > 0) {
              playTone("bad");
              acceptedCount = Math.max(0, acceptedCount - rejected.length);
              const countEl = document.getElementById("scanCount");
              if (countEl) countEl.textContent = String(acceptedCount);
              syncAlerts += rejected.length;
              const alertEl = document.getElementById("syncAlertNote");
              if (alertEl) {
                alertEl.style.display = "block";
                const last = rejected[rejected.length - 1];
                alertEl.textContent = `ALERT — Sync rejected (${syncAlerts}): ${last.studentId || "Scan"} -> ${last.status}`;
              }
            }
          }
        } catch (err) {
          if (manualTrigger) {
            const alertEl = document.getElementById("syncAlertNote");
            if (alertEl) {
              alertEl.style.display = "block";
              alertEl.textContent =
                "Sync delayed (offline/network). Scans remain safely queued.";
            }
          }
        } finally {
          isSyncing = false;
          updateSyncUI();
        }
      }

      window.addEventListener("online", () => {
        updateSyncUI();
        if (sessionToken && scanQueue.length > 0) flushScanQueue(false);
      });
      window.addEventListener("offline", () => updateSyncUI());

      function validateScanLocally(payloadText, stage) {
        if (
          snapshotLockedStage &&
          snapshotLockedStage !== "AUTO" &&
          stage !== snapshotLockedStage
        ) {
          return {
            ok: false,
            status: "REJECTED_STAGE_LOCKED",
            message: `Scanner is locked to ${snapshotLockedStage}.`,
          };
        }
        const raw = String(payloadText || "");
        const parts = raw.split("|");
        let rawId = "";
        if (parts[0] === "v2") {
          if (parts.length !== 4 || !parts[1] || !parts[2] || !parts[3]) {
            return {
              ok: false,
              status: "REJECTED_MALFORMED",
              message: "Malformed v2 QR payload.",
            };
          }
          if (parts[1] !== activeEventId) {
            return {
              ok: false,
              status: "REJECTED_WRONG_EVENT",
              message: `Pass belongs to event "${parts[1]}", not "${activeEventId}".`,
            };
          }
          rawId = parts[2];
        } else {
          if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
            return {
              ok: false,
              status: "REJECTED_MALFORMED",
              message: "Malformed QR payload.",
            };
          }
          if (snapshotV1Retired) {
            return {
              ok: false,
              status: "REJECTED_V1_RETIRED",
              message: "Legacy v1 passes have been permanently retired.",
            };
          }
          if (activeEventId !== snapshotV1CompatEventId) {
            return {
              ok: false,
              status: "REJECTED_WRONG_EVENT",
              message: `Legacy v1 passes are only valid for ${snapshotV1CompatEventId}.`,
            };
          }
          rawId = parts[0].trim().toUpperCase();
        }

        const normId = normalizeIdLocal(rawId);
        const tuple = snapshotRoster[normId];
        if (!tuple) {
          return { ok: false, fallbackOnline: true }; // Walk-in student not in snapshot -> verify live online
        }
        const [studentId, fullName, section] = tuple;
        const mask = snapshotSeen[normId] || 0;
        const bit = STAGE_BITS[stage] || 0;
        if (mask & bit) {
          return {
            ok: false,
            status: "DUPLICATE",
            studentId,
            fullName,
            section,
            message: `Already scanned for ${stage}.`,
          };
        }
        if (snapshotEnforceOrder) {
          if (stage === "Mid-Event" && !(mask & STAGE_BITS["Check-In"])) {
            return {
              ok: false,
              status: "REJECTED_STAGE_ORDER",
              studentId,
              fullName,
              message: "Must complete Check-In before Mid-Event.",
            };
          }
          if (stage === "Check-Out") {
            if (snapshotRequireMidEvent && !(mask & STAGE_BITS["Mid-Event"])) {
              return {
                ok: false,
                status: "REJECTED_STAGE_ORDER",
                studentId,
                fullName,
                message: "Must complete Mid-Event before Check-Out.",
              };
            }
            if (!snapshotRequireMidEvent && !(mask & STAGE_BITS["Check-In"])) {
              return {
                ok: false,
                status: "REJECTED_STAGE_ORDER",
                studentId,
                fullName,
                message: "Must complete Check-In before Check-Out.",
              };
            }
          }
        }
        return { ok: true, normId, studentId, fullName, section, bit };
      }

      function loadLocalSeen() {
        try {
          const raw = sessionStorage.getItem(LOCAL_SEEN_KEY);
          localSeen = raw ? JSON.parse(raw) : {};
        } catch (e) {
          localSeen = {};
        }
      }

      function rememberLocalSeen(eventId, stage, payload, res) {
        const key = `${eventId}|${stage}|${payload}`;
        localSeen[key] = {
          studentId: res.studentId || "",
          fullName: res.fullName || "",
          section: res.section || "",
        };
        try {
          sessionStorage.setItem(LOCAL_SEEN_KEY, JSON.stringify(localSeen));
        } catch (e) {}
      }

      async function refreshRosterSnapshot() {
        const btn = document.getElementById("refreshRosterBtn");
        const origText = btn ? btn.textContent : "Refresh Roster";
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Refreshing...";
        }
        try {
          await loadSnapshot();
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = origText;
          }
        }
      }

      function startKeepWarm() {
        if (keepWarmTimer) return;
        keepWarmTimer = setInterval(async () => {
          if (!sessionToken || document.hidden || isProcessing) return;
          try {
            const ping = await apiCall({ action: "ping" });
            if (ping && ping.ok && (ping.lockedStage || ping.eventId)) {
              snapshotLockedStage = ping.lockedStage || snapshotLockedStage;
              activeEventId = ping.eventId || activeEventId;
              applyStageLockUI(snapshotLockedStage, activeEventId);
            }
          } catch (e) {}
        }, KEEP_WARM_INTERVAL_MS);
      }

      function stopKeepWarm() {
        if (keepWarmTimer) {
          clearInterval(keepWarmTimer);
          keepWarmTimer = null;
        }
      }

      async function apiCall(body) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          const resp = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(body),
            redirect: "follow",
            signal: ctrl.signal,
          });
          if (!resp.ok) {
            throw new Error("Server HTTP " + resp.status);
          }
          return await resp.json();
        } catch (err) {
          if (err && err.name === "AbortError") {
            throw new Error(
              "Request timed out after 15s. Check Wi-Fi and try again.",
            );
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }

      function playTone(type) {
        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return;
          if (!audioCtx) audioCtx = new Ctx();
          if (audioCtx.state === "suspended") audioCtx.resume();

          const beep = (freq, startOffset, duration) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.value = 0.15;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            const t = audioCtx.currentTime + startOffset;
            osc.start(t);
            osc.stop(t + duration);
          };

          if (type === "ok") {
            beep(880, 0, 0.14);
            if (navigator.vibrate) navigator.vibrate(80);
          } else if (type === "dup") {
            beep(520, 0, 0.1);
            beep(520, 0.15, 0.1);
            if (navigator.vibrate) navigator.vibrate([70, 50, 70]);
          } else {
            beep(220, 0, 0.28);
            if (navigator.vibrate) navigator.vibrate(250);
          }
        } catch (e) {}
      }

      function applyScannerState(res) {
        startKeepWarm();
        startSyncLoop();
        activeEventId = res.eventId || "DEFAULT";
        loadLocalSeen();
        loadScanQueue();
        loadSnapshot();
        if (scanQueue.length > 0) flushScanQueue(false);
        document.getElementById("pinScreen").style.display = "none";
        document.getElementById("scannerScreen").style.display = "block";
        document.getElementById("eventTitle").textContent =
          res.eventTitle || "Event Scanner";
        applyStageLockUI(res.lockedStage, activeEventId);
      }

      function syncStagePills() {
        const sel = document.getElementById("stageSelect");
        const pills = document.querySelectorAll("#stagePills .stage-pill");
        pills.forEach((btn) => {
          const active = btn.dataset.stage === sel.value;
          btn.setAttribute("aria-pressed", active ? "true" : "false");
          btn.disabled = sel.disabled;
        });
      }

      function selectStagePill(stage) {
        const sel = document.getElementById("stageSelect");
        if (sel.disabled) return;
        sel.value = stage;
        syncStagePills();
      }

      function returnToPinScreen(msg) {
        stopKeepWarm();
        stopSyncLoop();
        stopCamera();
        pendingConfirm = null;
        const confirmCard = document.getElementById("confirmCard");
        if (confirmCard) confirmCard.style.display = "none";
        sessionToken = "";
        snapshotReady = false;
        localSeen = {};
        try {
          sessionStorage.removeItem(SESSION_KEY);
          sessionStorage.removeItem(LOCAL_SEEN_KEY);
        } catch (e) {}
        clearOfflineSnapshot();
        document.getElementById("scannerScreen").style.display = "none";
        document.getElementById("pinScreen").style.display = "block";
        document.getElementById("pinInput").value = "";
        document.getElementById("pinError").textContent = msg || "";
      }

      async function logoutScanner() {
        if (scanQueue.length > 0) {
          await flushScanQueue(true);
          if (scanQueue.length > 0) {
            const proceed = confirm(
              `${scanQueue.length} scan(s) are still queued offline and will remain saved on this device until you log back in. Log out anyway?`,
            );
            if (!proceed) return;
          }
        }
        returnToPinScreen("Logged out.");
      }

      async function unlockScanner(ev) {
        if (ev) ev.preventDefault();
        const pin = document.getElementById("pinInput").value;
        const usherName =
          document.getElementById("usherNameInput").value.trim() || "Usher";
        const btn = document.getElementById("unlockBtn");
        const errEl = document.getElementById("pinError");

        errEl.textContent = "Verifying...";
        btn.disabled = true;

        try {
          const res = await apiCall({ action: "login", pin, usherName });
          if (res && res.ok) {
            sessionToken = res.sessionToken;
            try {
              sessionStorage.setItem(SESSION_KEY, sessionToken);
            } catch (e) {}
            errEl.textContent = "";
            applyScannerState(res);
          } else {
            errEl.textContent = (res && res.message) || "Login failed.";
          }
        } catch (err) {
          errEl.textContent = (err && err.message) || "Connection error.";
        } finally {
          btn.disabled = false;
        }
      }

      let userSelectedCameraId = "";

      async function populateCameraList() {
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
          const all = await navigator.mediaDevices.enumerateDevices();
          const cams = all.filter((d) => d.kind === "videoinput");
          const select = document.getElementById("cameraSelect");
          const wrap = document.getElementById("cameraPickerWrap");
          if (!select || !wrap || cams.length === 0) return;

          const prev = userSelectedCameraId || select.value;
          while (select.firstChild) select.removeChild(select.firstChild);
          cams.forEach((d, idx) => {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || "Camera " + (idx + 1);
            select.appendChild(opt);
          });
          if (prev && cams.some((c) => c.deviceId === prev)) {
            select.value = prev;
          }
          if (cams.length > 1) wrap.style.display = "block";
        } catch (e) {
          // ignore device enumeration errors
        }
      }

      async function startCamera() {
        if (isStarting) return;
        isStarting = true;
        const btn = document.getElementById("startCamBtn");
        if (btn) btn.disabled = true;
        const statusEl = document.getElementById("statusNote");

        try {
          if (typeof Html5Qrcode === "undefined") {
            statusEl.textContent =
              "Camera library still loading, tap Start Camera again in a second.";
            return;
          }
          if (!html5QrCode) {
            const qrOpts = { useBarCodeDetectorIfSupported: true };
            if (
              typeof Html5QrcodeSupportedFormats !== "undefined" &&
              Html5QrcodeSupportedFormats.QR_CODE !== undefined
            ) {
              qrOpts.formatsToSupport = [Html5QrcodeSupportedFormats.QR_CODE];
            }
            html5QrCode = new Html5Qrcode("reader", qrOpts);
          }
          if (html5QrCode.isScanning) {
            await stopCamera();
            await new Promise((r) => setTimeout(r, 250));
          }

          statusEl.textContent = "Starting camera...";
          const scanConfig = {
            fps: 15,
            qrbox: (vw, vh) => {
              const s = Math.max(
                140,
                Math.min(240, Math.floor(Math.min(vw, vh) * 0.72)),
              );
              return { width: s, height: s };
            },
          };

          // Build ordered fallback candidates: avoid getCameras() pre-open race & macro/depth lens traps
          const candidates = [];
          if (userSelectedCameraId) {
            candidates.push(userSelectedCameraId);
          }
          candidates.push({ facingMode: "environment" });
          candidates.push({ facingMode: "user" });

          let started = false;
          let lastErr = null;
          for (let i = 0; i < candidates.length; i++) {
            if (!sessionToken) return;
            try {
              await html5QrCode.start(
                candidates[i],
                scanConfig,
                onScanSuccess,
                () => {},
              );
              started = true;
              break;
            } catch (err) {
              lastErr = err;
              const msg = String(err && err.message ? err.message : err);
              if (/NotAllowedError|Permission/i.test(msg)) throw err;
              try {
                if (html5QrCode.isScanning) await html5QrCode.stop();
              } catch (e) {}
              await new Promise((r) => setTimeout(r, 250));
            }
          }

          // Final fallback: enumerate available videoinput IDs and try any untested camera
          if (!started && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            try {
              const all = await navigator.mediaDevices.enumerateDevices();
              const cams = all.filter((d) => d.kind === "videoinput" && d.deviceId);
              for (let i = 0; i < cams.length; i++) {
                if (!sessionToken) return;
                if (cams[i].deviceId === userSelectedCameraId) continue;
                try {
                  await html5QrCode.start(
                    cams[i].deviceId,
                    scanConfig,
                    onScanSuccess,
                    () => {},
                  );
                  started = true;
                  break;
                } catch (err) {
                  lastErr = err;
                  await new Promise((r) => setTimeout(r, 200));
                }
              }
            } catch (e) {}
          }

          if (!started) {
            throw lastErr || new Error("Could not start video source");
          }

          if (!sessionToken) {
            await stopCamera();
            return;
          }
          await populateCameraList();
          statusEl.textContent = "Scanning active.";
        } catch (err) {
          const msg = String(err && err.message ? err.message : err);
          if (/NotAllowedError|Permission/i.test(msg)) {
            statusEl.textContent =
              "Camera permission denied. Allow camera in browser site settings or use Manual Check-In below.";
          } else if (/NotReadableError|Could not start video|TrackStartError|AbortError/i.test(msg)) {
            statusEl.textContent =
              "Camera is busy or unavailable (close other apps/tabs using the camera and tap Start Camera again, or use Manual Check-In below).";
          } else {
            statusEl.textContent = "Camera error: " + msg;
          }
        } finally {
          isStarting = false;
          if (btn) btn.disabled = false;
        }
      }

      async function switchCamera() {
        const select = document.getElementById("cameraSelect");
        userSelectedCameraId = select ? select.value : "";
        if (html5QrCode && html5QrCode.isScanning) {
          await stopCamera();
          await startCamera();
        }
      }

      async function stopCamera() {
        if (html5QrCode && html5QrCode.isScanning) {
          try {
            await html5QrCode.stop();
            document.getElementById("statusNote").textContent =
              "Camera paused.";
          } catch (e) {}
        }
      }

      function setStatusReady() {
        isProcessing = false;
        const statusEl = document.getElementById("statusNote");
        if (statusEl) {
          statusEl.textContent =
            html5QrCode && html5QrCode.isScanning
              ? "Scanning active."
              : "Ready.";
        }
      }

      function showConfirmCard(pending) {
        pendingConfirm = pending;
        isProcessing = false;
        const banner = document.getElementById("resultBanner");
        if (banner) banner.style.display = "none";
        const card = document.getElementById("confirmCard");
        document.getElementById("confirmTitle").textContent =
          pending.mode === "manual"
            ? "MANUAL CHECK-IN — VERIFY SCHOOL ID"
            : "CHECK PHYSICAL SCHOOL ID";
        document.getElementById("confirmName").textContent =
          pending.fullName || pending.studentId;
        document.getElementById("confirmSub").textContent =
          `ID: ${pending.studentId} | ${pending.section || "No Section"} | Stage: ${pending.stage}`;
        card.style.display = "block";
        document.getElementById("statusNote").textContent =
          "Check physical School ID, then Confirm or Cancel.";
      }

      function cancelPendingScan() {
        pendingConfirm = null;
        lastCameraPayload = "";
        const card = document.getElementById("confirmCard");
        if (card) card.style.display = "none";
        isProcessing = false;
        document.getElementById("statusNote").textContent =
          "Scan cancelled (School ID not confirmed).";
      }

      async function confirmPendingScan() {
        if (!pendingConfirm || isProcessing) return;
        isProcessing = true;
        const pending = pendingConfirm;
        pendingConfirm = null;
        const card = document.getElementById("confirmCard");
        if (card) card.style.display = "none";

        if (pending.mode === "queue") {
          commitQueuedScan(pending.payload, pending.stage, pending.check);
          setTimeout(setStatusReady, 250);
        } else if (pending.mode === "manual") {
          await executeManualScanOnline(pending.studentId, pending.stage);
        } else {
          await executeOnlineScan(pending.payload, pending.stage);
        }
      }

      function commitQueuedScan(payloadText, stage, check) {
        snapshotSeen[check.normId] =
          (snapshotSeen[check.normId] || 0) | check.bit;
        const nowIso = new Date().toISOString();
        const nowTime = new Date().toTimeString().slice(0, 8);
        scanQueue.push({
          clientId: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          payload: payloadText,
          stage,
          scannedAt: nowIso,
          eventId: activeEventId,
          normId: check.normId,
          bit: check.bit,
        });
        saveScanQueue();
        rememberLocalSeen(activeEventId, stage, payloadText, check);
        showResult({
          status: "OK",
          studentId: check.studentId,
          fullName: check.fullName,
          section: check.section,
          stage,
          time: `${nowTime} • queued`,
        });
        if (scanQueue.length >= SYNC_BATCH_THRESHOLD && !isSyncing) {
          flushScanQueue(false);
        }
      }

      async function executeOnlineScan(payloadText, stage) {
        const statusEl = document.getElementById("statusNote");
        statusEl.textContent = "Checking pass...";
        try {
          const res = await apiCall({
            action: "scan",
            sessionToken,
            payload: payloadText,
            stage,
          });
          if (res && res.status === "UNAUTHORIZED") {
            isProcessing = false;
            playTone("bad");
            returnToPinScreen(
              res.message || "Session expired. Please log in again.",
            );
            return;
          }
          if (res && (res.status === "OK" || res.status === "DUPLICATE")) {
            rememberLocalSeen(
              res.eventId || activeEventId,
              stage,
              payloadText,
              res,
            );
          }
          showResult(
            res || { status: "ERROR", message: "Empty server response." },
          );
          setTimeout(setStatusReady, 300);
        } catch (err) {
          showResult({
            status: "ERROR",
            message: (err && err.message) || "Network error.",
          });
          setTimeout(setStatusReady, 600);
        }
      }

      async function executeManualScanOnline(studentId, stage) {
        const statusEl = document.getElementById("statusNote");
        statusEl.textContent = "Recording manual check-in...";
        try {
          const res = await apiCall({
            action: "manualScan",
            sessionToken,
            studentId,
            stage,
          });
          if (res && res.status === "UNAUTHORIZED") {
            isProcessing = false;
            playTone("bad");
            returnToPinScreen(
              res.message || "Session expired. Please log in again.",
            );
            return;
          }
          if (res && res.status === "OK" && snapshotReady) {
            const nid = normalizeIdLocal(res.studentId || studentId);
            snapshotSeen[nid] =
              (snapshotSeen[nid] || 0) | (STAGE_BITS[stage] || 0);
          }
          showResult(
            res || { status: "ERROR", message: "Empty server response." },
          );
          setTimeout(setStatusReady, 300);
        } catch (err) {
          showResult({
            status: "ERROR",
            message: (err && err.message) || "Network error.",
          });
          setTimeout(setStatusReady, 600);
        }
      }

      function onScanSuccess(decodedText) {
        if (pendingConfirm || isProcessing) return;
        const now = Date.now();
        if (
          decodedText === lastCameraPayload &&
          now - lastCameraTime < CAMERA_COOLDOWN_MS
        ) {
          return;
        }
        lastCameraPayload = decodedText;
        lastCameraTime = now;
        submitScan(decodedText, false);
      }

      async function submitManualCode(ev) {
        if (ev) ev.preventDefault();
        if (pendingConfirm || isProcessing) return;
        const input = document.getElementById("manualInput");
        const code = input.value.trim();
        if (!code) return;
        input.value = "";

        if (code.includes("|")) {
          submitScan(code, true);
          return;
        }

        const stage = document.getElementById("stageSelect").value;
        if (
          snapshotLockedStage &&
          snapshotLockedStage !== "AUTO" &&
          stage !== snapshotLockedStage
        ) {
          showResult({
            status: "REJECTED_STAGE_LOCKED",
            message: `Scanner is locked to ${snapshotLockedStage}.`,
          });
          return;
        }

        const verifyFirst = Boolean(
          document.getElementById("verifyIdToggle") &&
          document.getElementById("verifyIdToggle").checked,
        );
        const normId = normalizeIdLocal(code);
        const tuple = snapshotReady ? snapshotRoster[normId] : null;
        if (tuple) {
          const [studentId, fullName, section] = tuple;
          const mask = snapshotSeen[normId] || 0;
          const bit = STAGE_BITS[stage] || 0;
          if (mask & bit) {
            showResult({
              status: "DUPLICATE",
              studentId,
              fullName,
              section,
              message: `Already scanned for ${stage}.`,
            });
            return;
          }
          if (snapshotEnforceOrder) {
            if (stage === "Mid-Event" && !(mask & STAGE_BITS["Check-In"])) {
              showResult({
                status: "REJECTED_STAGE_ORDER",
                studentId,
                fullName,
                message: "Must complete Check-In before Mid-Event.",
              });
              return;
            }
            if (stage === "Check-Out") {
              if (snapshotRequireMidEvent && !(mask & STAGE_BITS["Mid-Event"])) {
                showResult({
                  status: "REJECTED_STAGE_ORDER",
                  studentId,
                  fullName,
                  message: "Must complete Mid-Event before Check-Out.",
                });
                return;
              }
              if (!snapshotRequireMidEvent && !(mask & STAGE_BITS["Check-In"])) {
                showResult({
                  status: "REJECTED_STAGE_ORDER",
                  studentId,
                  fullName,
                  message: "Must complete Check-In before Check-Out.",
                });
                return;
              }
            }
          }
          if (verifyFirst) {
            showConfirmCard({
              mode: "manual",
              studentId,
              fullName,
              section,
              stage,
            });
            return;
          }
          isProcessing = true;
          await executeManualScanOnline(studentId, stage);
          return;
        }

        if (verifyFirst) {
          showConfirmCard({
            mode: "manual",
            studentId: code,
            fullName: "Manual Check-In: " + code,
            section: snapshotReady
              ? "Not in local snapshot (server will verify)"
              : "Server will verify Roster",
            stage,
          });
          return;
        }
        isProcessing = true;
        await executeManualScanOnline(code, stage);
      }

      async function submitScan(payloadText, fromManual) {
        if (pendingConfirm || isProcessing) return;
        isProcessing = true;

        const stage = document.getElementById("stageSelect").value;
        const verifyFirst = Boolean(
          document.getElementById("verifyIdToggle") &&
          document.getElementById("verifyIdToggle").checked,
        );
        const strictOnline = Boolean(
          document.getElementById("strictOnlineToggle") &&
          document.getElementById("strictOnlineToggle").checked,
        );

        // Offline-First Batch Mode when snapshot is loaded and Strict Online is OFF
        if (!strictOnline && snapshotReady) {
          const check = validateScanLocally(payloadText, stage);
          if (!check.fallbackOnline) {
            if (check.ok) {
              if (verifyFirst) {
                showConfirmCard({
                  mode: "queue",
                  payload: payloadText,
                  studentId: check.studentId,
                  fullName: check.fullName,
                  section: check.section,
                  stage,
                  check,
                });
                return;
              }
              commitQueuedScan(payloadText, stage, check);
              setTimeout(setStatusReady, 250);
              return;
            } else {
              showResult(check);
              setTimeout(setStatusReady, 250);
              return;
            }
          }
        } else if (strictOnline && snapshotReady) {
          const check = validateScanLocally(payloadText, stage);
          if (!check.fallbackOnline && !check.ok) {
            showResult(check);
            setTimeout(setStatusReady, 250);
            return;
          }
          if (verifyFirst && !check.fallbackOnline && check.ok) {
            showConfirmCard({
              mode: "online",
              payload: payloadText,
              studentId: check.studentId,
              fullName: check.fullName,
              section: check.section,
              stage,
            });
            return;
          }
        }

        // Instant (<5ms) O(1) local duplicate short-circuit for online fallback mode
        const localKey = `${activeEventId}|${stage}|${payloadText}`;
        if (!fromManual && localSeen[localKey]) {
          const hit = localSeen[localKey];
          showResult({
            status: "DUPLICATE",
            studentId: hit.studentId,
            fullName: hit.fullName,
            section: hit.section,
            message: `Already scanned for ${stage} (instant local check).`,
          });
          setTimeout(setStatusReady, 300);
          return;
        }

        await executeOnlineScan(payloadText, stage);
      }

      let resultBannerTimer = null;

      function showResult(res) {
        const banner = document.getElementById("resultBanner");
        const title = document.getElementById("resTitle");
        const name = document.getElementById("resName");
        const sub = document.getElementById("resSub");

        if (resultBannerTimer) {
          clearTimeout(resultBannerTimer);
          resultBannerTimer = null;
        }
        banner.style.display = "block";
        banner.className = "result-banner";
        banner.onclick = () => {
          banner.style.display = "none";
        };
        resultBannerTimer = setTimeout(() => {
          banner.style.display = "none";
          resultBannerTimer = null;
        }, 3200);

        if (res.status === "OK") {
          acceptedCount++;
          document.getElementById("scanCount").textContent =
            String(acceptedCount);
          banner.classList.add("res-ok");
          title.textContent =
            "VERIFIED - " + String(res.stage || "").toUpperCase();
          name.textContent = res.fullName || res.studentId || "Participant";
          sub.textContent = `ID: ${res.studentId} | ${res.section || "No Section"} | ${res.time}`;
          playTone("ok");
        } else if (res.status === "DUPLICATE") {
          banner.classList.add("res-dup");
          title.textContent = "ALREADY SCANNED";
          name.textContent = res.fullName || "Duplicate Scan";
          sub.textContent = `${res.studentId || ""} - ${res.message || ""}`;
          playTone("dup");
        } else {
          const labels = {
            REJECTED_FORGED: "FORGED TOKEN",
            REJECTED_MALFORMED: "MALFORMED QR",
            REJECTED_NOT_IN_ROSTER: "NOT IN ROSTER",
            REJECTED_STAGE_LOCKED: "STAGE LOCKED",
            REJECTED_STAGE_ORDER: "OUT OF ORDER",
            REJECTED_WRONG_EVENT: "WRONG EVENT",
            REJECTED_V1_RETIRED: "LEGACY PASS RETIRED",
            INTERNAL_ERROR: "SERVER ERROR",
          };
          banner.classList.add("res-bad");
          title.textContent = "REJECTED";
          name.textContent = labels[res.status] || res.status || "ERROR";
          sub.textContent = res.message || "Invalid QR code.";
          playTone("bad");
        }
      }

      // Check backend health & auto-restore session on page reload
      (async function initSession() {
        if (UNTRUSTED_API_WARNING) {
          document.getElementById("pinError").textContent =
            "Ignored untrusted ?api= URL; using default official endpoint.";
        }
        try {
          const ping = await apiCall({ action: "ping" });
          const note = document.getElementById("apiVersionNote");
          if (ping && ping.ok && note) {
            note.textContent = `Backend: ${ping.version || "connected"} (Event: ${ping.eventId || "DEFAULT"})`;
          }
        } catch (e) {}

        let saved = "";
        try {
          saved = sessionStorage.getItem(SESSION_KEY) || "";
        } catch (e) {}
        if (!saved) return;
        document.getElementById("pinError").textContent =
          "Restoring session...";
        try {
          const res = await apiCall({ action: "state", sessionToken: saved });
          if (res && res.ok) {
            sessionToken = saved;
            document.getElementById("pinError").textContent = "";
            applyScannerState(res);
          } else {
            returnToPinScreen("");
          }
        } catch (e) {
          const cached = loadOfflineSnapshot();
          if (cached) {
            sessionToken = saved;
            document.getElementById("pinError").textContent = "";
            applyScannerState({
              ok: true,
              eventTitle: cached.eventTitle || "Event Scanner",
              eventId: cached.eventId || "DEFAULT",
              lockedStage: cached.lockedStage || "AUTO",
            });
            applySnapshotData(cached);
          } else {
            returnToPinScreen("");
          }
        }
      })();

      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
      }

      // Lightweight :user-invalid <-> aria-invalid sync after interaction
      (function initFieldValidationAria() {
        const sync = (el) => {
          if (!el || !el.matches || !el.matches("input, select, textarea"))
            return;
          let bad = false;
          try {
            bad = el.matches(":user-invalid");
          } catch (e) {
            bad = !el.validity.valid;
          }
          el.setAttribute("aria-invalid", bad ? "true" : "false");
          const errId = el.dataset.error;
          if (errId) {
            const hintId = el.id === "pinInput" ? "pin-hint" : "";
            const ids = [];
            if (hintId) ids.push(hintId);
            if (bad) ids.push(errId);
            if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
          }
        };
        document.addEventListener("blur", (e) => sync(e.target), true);
        document.addEventListener("input", (e) => {
          if (e.target && e.target.getAttribute("aria-invalid") === "true")
            sync(e.target);
        });
        document.addEventListener("invalid", (e) => sync(e.target), true);
      })();
    
// CSP-safe declarative handler binding (replaces inline on* attributes; no eval).
(function bindDeclarativeHandlers() {
  function parseCall(spec) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?\s*$/.exec(spec || "");
    if (!m) return null;
    const args = m[2].trim()
      ? m[2].split(",").map((a) => {
          const t = a.trim();
          if (t === "event") return { ev: true };
          if (t === "true") return { v: true };
          if (t === "false") return { v: false };
          const s = /^'([^']*)'$/.exec(t) || /^"([^"]*)"$/.exec(t);
          return { v: s ? s[1] : t };
        })
      : [];
    return { fn: m[1], args };
  }
  ["click", "submit", "change"].forEach((evName) => {
    document.querySelectorAll("[data-on-" + evName + "]").forEach((el) => {
      const call = parseCall(el.getAttribute("data-on-" + evName));
      if (!call) return;
      el.addEventListener(evName, (ev) => {
        const fn = window[call.fn];
        if (typeof fn === "function") {
          fn.apply(null, call.args.map((a) => (a.ev ? ev : a.v)));
        }
      });
    });
  });
})();

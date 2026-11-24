  const { apiUrl: API_URL, untrustedWarning } = window.CSSOCommon.resolveApiUrl();
  if (untrustedWarning) {
    document.getElementById('errorText').textContent = 'Ignored untrusted ?api= URL; using default official endpoint.';
  }
  const FETCH_TIMEOUT_MS = 15000;
  const SAVED_PASS_KEY = 'csso_saved_pass_v1';
  const SAVED_PASS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  let currentPass = null;

  function getSavedPassKey() {
    return window.CSSOCommon.scopedKey(SAVED_PASS_KEY, API_URL);
  }

  function renderPassCard(res) {
    currentPass = res;
    document.getElementById('eventBadge').textContent = res.eventId || 'EVENT';
    document.getElementById('eventTitle').textContent = res.eventTitle || 'Event Attendance Pass';
    document.getElementById('studentName').textContent = res.fullName || res.studentId;
    document.getElementById('studentMeta').textContent = `${res.studentId}${res.section ? ' | ' + res.section : ''}`;
    document.getElementById('qrImg').src = res.qrDataUri;
    const stageEl = document.getElementById('stageReminder');
    if (stageEl) {
      stageEl.textContent =
        res.requireMidEvent === false
          ? 'Check-In and Check-Out (Mid-Event optional)'
          : 'Check-In, Mid-Event, and Check-Out';
    }
    document.getElementById('lookupCard').style.display = 'none';
    document.getElementById('passCard').style.display = 'block';
  }

  (function restoreSavedPass() {
    try {
      const raw = localStorage.getItem(getSavedPassKey());
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && saved.savedAt && Date.now() - Number(saved.savedAt) > SAVED_PASS_TTL_MS) {
        localStorage.removeItem(getSavedPassKey());
        return;
      }
      if (saved && saved.ok && saved.qrDataUri && saved.studentId) {
        renderPassCard(saved);
      }
    } catch (e) {}
  })();

  async function fetchPass(ev) {
    if (ev) ev.preventDefault();
    const idEl = document.getElementById('studentIdInput');
    const emailEl = document.getElementById('emailInput');
    const pinEl = document.getElementById('pinInput');
    const studentId = idEl.value.trim();
    const email = emailEl.value.trim();
    const passPin = pinEl ? pinEl.value.trim() : '';
    idEl.value = studentId;
    emailEl.value = email;
    if (pinEl) pinEl.value = passPin;
    const btn = document.getElementById('submitBtn');
    const errEl = document.getElementById('errorText');

    errEl.textContent = 'Generating your signed QR pass...';
    btn.disabled = true;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'lookupPass', studentId, email, passPin }),
        redirect: 'follow',
        signal: ctrl.signal
      });
      if (!resp.ok) throw new Error('Server HTTP ' + resp.status);
      const res = await resp.json();

      if (!res || !res.ok) {
        errEl.textContent = (res && res.message) || 'Could not find a matching registration.';
        return;
      }

      errEl.textContent = '';
      renderPassCard(res);
      try {
        localStorage.setItem(getSavedPassKey(), JSON.stringify({
          ok: true,
          eventId: res.eventId,
          eventTitle: res.eventTitle,
          requireMidEvent: res.requireMidEvent !== false,
          studentId: res.studentId,
          fullName: res.fullName,
          section: res.section,
          qrDataUri: res.qrDataUri,
          savedAt: Date.now()
        }));
      } catch (e) {}
    } catch (err) {
      if (err && err.name === 'AbortError') {
        errEl.textContent = 'Request timed out after 15s. Check Wi-Fi and try again.';
      } else {
        errEl.textContent = (err && err.message) || 'Connection error. Please try again.';
      }
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
    }
  }

  function downloadQr() {
    if (!currentPass || !currentPass.qrDataUri) return;
    const filename = `QR_Pass_${currentPass.studentId}_${currentPass.eventId}.png`;
    const triggerDownload = (href) => {
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };

    try {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 860;
          const ctx = canvas.getContext('2d');
          if (!ctx) { triggerDownload(currentPass.qrDataUri); return; }

          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Accent header bar
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, canvas.width, 130);
          ctx.fillStyle = '#93c5fd';
          ctx.font = '700 20px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(currentPass.eventId || 'EVENT'), 320, 48);
          ctx.fillStyle = '#ffffff';
          ctx.font = '800 26px system-ui, -apple-system, sans-serif';
          ctx.fillText(String(currentPass.eventTitle || 'Event Attendance Pass').slice(0, 38), 320, 92);

          // Student identity baked directly into saved image
          ctx.fillStyle = '#0f172a';
          ctx.font = '800 32px system-ui, -apple-system, sans-serif';
          ctx.fillText(String(currentPass.fullName || currentPass.studentId).slice(0, 32), 320, 195);
          ctx.fillStyle = '#475569';
          ctx.font = '600 24px system-ui, -apple-system, sans-serif';
          const meta = `${currentPass.studentId}${currentPass.section ? '  |  ' + currentPass.section : ''}`;
          ctx.fillText(meta, 320, 236);

          // Crisp QR code + white quiet zone border
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = 3;
          ctx.strokeRect(75, 266, 490, 490);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 90, 281, 460, 460);

          // Footer reminder
          ctx.fillStyle = '#334155';
          ctx.font = '600 20px system-ui, -apple-system, sans-serif';
          ctx.fillText('Present with physical School ID', 320, 800);
          ctx.fillStyle = '#64748b';
          ctx.font = '500 18px system-ui, -apple-system, sans-serif';
          ctx.fillText(
            currentPass.requireMidEvent === false
              ? 'Check-In  •  Check-Out (Mid-Event Optional)'
              : 'Check-In  •  Mid-Event  •  Check-Out',
            320,
            832
          );

          triggerDownload(canvas.toDataURL('image/png'));
        } catch (err) {
          triggerDownload(currentPass.qrDataUri);
        }
      };
      img.onerror = () => triggerDownload(currentPass.qrDataUri);
      img.src = currentPass.qrDataUri;
    } catch (e) {
      triggerDownload(currentPass.qrDataUri);
    }
  }

  function resetForm() {
    currentPass = null;
    try { localStorage.removeItem(getSavedPassKey()); } catch (e) {}
    const form = document.getElementById('lookupForm');
    if (form) form.reset();
    const hintMap = {
      studentIdInput: 'id-hint',
      emailInput: 'email-hint',
      pinInput: 'pin-hint'
    };
    Object.keys(hintMap).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.setAttribute('aria-invalid', 'false');
      el.setAttribute('aria-describedby', hintMap[id]);
    });
    document.getElementById('passCard').style.display = 'none';
    document.getElementById('lookupCard').style.display = 'block';
    document.getElementById('errorText').textContent = '';
  }

  window.CSSOCommon.initFieldValidationAria(
    { studentIdInput: 'id-hint', emailInput: 'email-hint', pinInput: 'pin-hint' },
    ['studentIdInput', 'pinInput']
  );
  window.CSSOCommon.bindDeclarativeHandlers();
  window.CSSOCommon.registerServiceWorker();

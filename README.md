# CvSU CSSO Event QR Attendance System

A hardened Google Sheets + Google Apps Script + GitHub Pages QR attendance system for campus events, supporting zero-email pass issuance, 2-step physical ID verification, and offline-first batch scanning.

---

## Architecture

- **Google Sheets (`Config`, `Roster`, `Attendance Log`, `Verified Attendance`)** — Event settings, registered participants (with HMAC-SHA256 tokens and salted `Pass PIN Hash`), append-only scan ledger, and per-student qualification summary.
- **Google Apps Script (`Code.js`, `QrEncoder.js`, `Index.html`)** — `doPost(e)` JSON API, stateless HMAC-SHA256 usher sessions, `v2|EVENT_ID|STUDENT_ID|HMAC` + legacy `v1` verification, locally bundled 1-bit monochrome QR PNG generation (`qrcode-generator@2.0.4`, MIT), Google Form sync trigger, and optional `GmailApp` email dispatch.
- **Standalone HTTPS Frontend (`docs/`)** — Hosted on GitHub Pages with self-hosted `docs/vendor/html5-qrcode.min.js` (`2.3.8`) and single-file endpoint config (`docs/config.js`) so Chrome and Safari grant rear-camera access without Apps Script iframe restrictions:
  - **`docs/index.html`** — Usher QR Scanner (2-step ID verification, offline-first batch sync, manual check-in by Student ID).
  - **`docs/pass.html`** — Student QR Pass Portal (zero-email self-service pass lookup, device-local saved pass, downloadable composite ID + QR card PNG).

---

## What to Open & Use (Quick Reference)

### 1. Event Organizers / Admins (Google Spreadsheet)
Open the bound **Google Spreadsheet** and use the custom **`Attendance Scanner`** menu:

| Menu Action | When to Use |
| :--- | :--- |
| **🚀 Implement New Features / Apply All Upgrades** | Run once after copying or updating code. Initializes `Config` keys, auto-generates a 32-char `SECRET_SALT` if blank, repairs headers (including `Pass PIN Hash` in Col O), backfills missing tokens, audits `Roster` integrity, applies formatting, and installs the 5-min + `onEdit` triggers. |
| **📝 Setup Registration Form & Portal Sync** | Creates/updates the registration Google Form (collects verified Email, limits to 1 response per Google user, validates `Student ID`, `Full Name`, `Section`, and a private 4–6 digit `Personal Pass PIN`) and saves `REGISTRATION_FORM_URL` + `REGISTRATION_FORM_EDIT_URL` in `Config`. |
| **🗑️ Replace Registration Form** | Safely unlinks and trashes the old Form, removes old response tabs across locales, and creates a fresh validated Form. |
| **Rebuild Verified Attendance** | Manually refreshes `Verified Attendance` (`QUALIFIED` = 3/3 stages, `INCOMPLETE` otherwise) for the active `EVENT_ID`. |
| **🧹 Clear Attendance Log & Verified Attendance (Keep Roster)** | Clears scan logs and verified summaries between test runs or events while preserving registered students (`Roster`) and `Config` (requires typing `CLEAR LOGS`). |
| **🧹 Clear All Data Rows (Keep Headers & Config)** | Full event reset across `Roster`, `Attendance Log`, and `Verified Attendance` (requires typing `CLEAR ALL`). |
| **Generate & Email QR Passes (All Pending)** _(optional)_ | Emails inline QR passes via `GmailApp` (`https://mail.google.com/` scope) for rows entered manually instead of the zero-email Pass Portal. |

### 2. Students (Registration & QR Pass)
1. **Open the Google Form** (`Config` $\to$ `REGISTRATION_FORM_URL`).
   - Students enter their Email, **Student ID**, **Full Name**, **Section**, and choose a private 4–6 digit **Personal Pass PIN**.
   - `onRegistrationFormSubmit` enforces **strict 1-submission-per-student** (ignores duplicates matching an existing normalized `Student ID` or `Email`) and stores only an HMAC hash of the Pass PIN in `Roster` Col O.
2. **Open the Student Pass Portal (`docs/pass.html`)** linked directly on the Form confirmation screen:
   - Production: `https://drinkboooz.github.io/CVSU-CSSO-ATTENDANCE/pass.html`
   - Forks / Staging: `https://<your-user>.github.io/<your-repo>/pass.html` (or `?api=<WEB_APP_URL>`)
   - Enter **Student ID + Email + Personal Pass PIN** $\to$ **View My QR Pass**.
   - The pass is saved locally on the student's phone for quick reopening, raw `v2|...` payloads are hidden, and **Download QR Pass Card (PNG)** generates a composite card PNG containing Event Title, Full Name, Student ID, Section, and crisp QR code.

### 3. Ushers (Venue Gate Scanning)
1. **Open the Usher Scanner (`docs/index.html`)** in mobile Chrome or Safari:
   - Production: `https://drinkboooz.github.io/CVSU-CSSO-ATTENDANCE/`
   - Forks / Staging: `https://<your-user>.github.io/<your-repo>/` (or `?api=<WEB_APP_URL>`)
2. Enter **`USHER_PIN`** (from `Config` / `ScriptProperties`) and your gate label (e.g., `Gate A`).
3. Choose the checkpoint stage (`Check-In`, `Mid-Event`, or `Check-Out` — auto-locked if `Config.LOCKED_STAGE` is set and synced automatically via `ping` / `scanBatch`).
4. **Verify Physical ID First (`Verify ID First` ON by default):**
   - Tap **Start Camera** and scan the student's QR pass.
   - The scanner pauses new scans and shows a confirmation card (**Full Name**, **Student ID**, **Section**, **Stage**).
   - Check the student's **physical School ID**, then tap **`✓ Confirm & Record`** (or **`✕ Cancel / Mismatch`** to discard).
5. **Fallback Controls:**
   - **Manual Check-In by Student ID:** For dead batteries or cracked screens, enter the Student ID, verify their physical School ID, and confirm (recorded with `[MANUAL]` in `Usher Label`).
   - **Strict Online:** Forces live server HMAC verification on every scan when venue Wi-Fi is strong (when OFF, scans queue locally in `<10ms` and batch-sync every 5 seconds with loud audio alert if the server later rejects any item).
   - **Refresh Roster:** Pulls newly registered walk-in students into the local snapshot on demand.

---

## Using Your Own GitHub Repository & GitHub Pages URL (Fork Guide)

Anyone can deploy this system under their own GitHub account and Google Sheet with zero app-code hunting:

1. **Fork this repo** (or copy `docs/`) and enable **Settings $\to$ Pages** serving from `main` / `/docs` $\to$ your live site is `https://<your-username>.github.io/<your-repo>/`.
2. **Copy the Google Sheet & deploy Apps Script** (see detailed walkthrough in [docs/FORK_SETUP.md](file:///c:/Users/danjo/OneDrive/CVSU-CSSO-ATTENDANCE/docs/FORK_SETUP.md)), and copy your Web App `/exec` URL (`Execute as: Me`, `Who has access: Anyone`).
3. **Edit 1 line in [`docs/config.js`](docs/config.js):**
   ```js
   window.CSSO_CONFIG = {
     DEFAULT_API_URL: 'https://script.google.com/macros/s/<YOUR_DEPLOYMENT_ID>/exec'
   };
   ```
   Commit and push to `main` — both your Usher Scanner (`https://<your-username>.github.io/<your-repo>/`) and Pass Portal (`.../pass.html`) automatically point to your spreadsheet without needing `?api=` in the URL.
4. **Set `PORTAL_BASE_URL` in your Google Sheet `Config` tab:**
   - Run **Attendance Scanner $\to$ 🚀 Implement New Features / Apply All Upgrades** so `PORTAL_BASE_URL` (and optional `WEB_APP_URL`) rows appear in `Config`.
   - Set `PORTAL_BASE_URL` to `https://<your-username>.github.io/<your-repo>`.
   - Click **Attendance Scanner $\to$ 📝 Setup Registration Form & Portal Sync** — the Form's confirmation message now links directly to your own GitHub Pages `/pass.html`.

> Alternatively, without even editing `docs/config.js`, forks can pass `?api=<YOUR_WEB_APP_URL>` in the URL query string (validated strictly against `^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$`).

---

## Security, Event Lifecycle & Rollback Notes

- **Streamlined Secret Management (`Attendance Scanner → 🔐 Security & Secrets`):** Manage all secrets directly from the spreadsheet menu without opening Apps Script Project Settings:
  - **🔒 Migrate Secrets to Private Storage:** Moves `USHER_PIN`, `SECRET_SALT`, and `V1_COMPAT_EVENT_ID` out of the plaintext `Config` tab into private `ScriptProperties`.
  - **🔑 Change Usher PIN:** Prompts for a new 6+ digit numeric PIN, updates `ScriptProperties` (or `Config` if not yet migrated) without leaving plaintext in `Config`, and immediately invalidates all previous usher sessions.
  - **🔄 Rotate Secret Salt (Zero-Downtime):** Auto-generates a fresh 32-character hex salt (or accepts a custom 16+ char salt) and moves the previous salt into `LEGACY_SECRET_SALT` so existing same-event `v1`/`v2` passes remain valid during transition.
  - **🧹 Retire Legacy Secret Salt:** Removes `LEGACY_SECRET_SALT` once legacy-signed passes are no longer needed.
- **`DEFAULT` Reservation & 7-Step Transition:** `DEFAULT` is reserved exclusively for legacy `v1` passes. Use `setTargetEventId('CSSO-2026-EVENT')` then `transitionToTargetEvent()` to activate a new event and permanently retire `v1`.
- **Protocol-Aware Rollback:** Never roll back to pre-`v2` deployment `@5` once `v2` or `V1_COMPAT_RETIRED = TRUE` is active; recover via forward-fix.
- **Honest Email Semantics (`DISPATCHED`):** When using optional `GmailApp` emails, `DISPATCHED` means `GmailApp.sendEmail()` accepted the request without throwing — not proof of inbox delivery.

---

## Testing Guide (Everything Covered)

### 1. Local Automated Verification (Syntax, Unit & Browser)
Run from the repository root in PowerShell:
```powershell
node -c Code.js
node -c QrEncoder.js
node -c docs/config.js
$fail=0; Get-ChildItem tests/*.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { $fail=1 } }; exit $fail
node tests/browser/scanner.spec.js
clasp status
```
- **Expected:** All 11 suites in `tests/*.js` print `PASS:`, Playwright `tests/browser/scanner.spec.js` prints `PASS:` (verifies PIN login, session restore, zero external CDN requests, mobile 375px layout, `#confirmCard` cancel & confirm, `manualScan`, and `UNAUTHORIZED` recovery), and `clasp status` tracks only `Code.js`, `QrEncoder.js`, `Index.html`, and `appsscript.json`.

### 2. Automated Live Staging API E2E
See [tests/e2e/E2E_RUNBOOK.md](tests/e2e/E2E_RUNBOOK.md) (strictly refuses to execute against the production spreadsheet):
```powershell
$env:CSSO_STAGING_SHEET_ID = "<STAGING_SHEET_ID>"
$env:CSSO_STAGING_API_URL  = "<STAGING_EXEC_URL>"
$env:CSSO_E2E_PIN          = "<STAGING_6_DIGIT_PIN>"
$env:CSSO_E2E_TOK1         = "<STAGING_E2ETEST001_TOKEN>"
$env:CSSO_E2E_TOK2         = "<STAGING_E2ETEST002_TOKEN>"
node tests/e2e/run-live-e2e.js
```

### 3. Manual End-to-End Staging Checklist
1. **Sheet Upgrades & Form Setup:** Click **🚀 Implement New Features / Apply All Upgrades**, then **📝 Setup Registration Form & Portal Sync** (verify `REGISTRATION_FORM_URL` and `REGISTRATION_FORM_EDIT_URL` appear in `Config`).
2. **Form $\to$ Portal Flow:** Submit the Google Form with a test student + 4–6 digit Pass PIN $\to$ confirm duplicate submission with same ID or Email is ignored $\to$ click the confirmation `pass.html` link $\to$ confirm wrong PIN fails, correct ID + Email + PIN renders the pass, **Download QR Pass Card (PNG)** includes Full Name + ID + Section + QR, and reopening `pass.html` restores the saved pass.
3. **Usher Scanner Gate Flow:** Log into `docs/index.html` with staging `USHER_PIN` $\to$ scan the QR under `Check-In` $\to$ verify `#confirmCard` appears before logging $\to$ test Cancel/Mismatch (no row written) and Confirm (`ACCEPTED` logged) $\to$ test Manual Check-In by Student ID (`[MANUAL]` in `Usher Label`) $\to$ test Offline queuing + reconnect flush + `Clear Attendance Log & Verified Attendance` reset.

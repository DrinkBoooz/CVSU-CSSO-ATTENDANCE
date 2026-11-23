# Live Staging E2E Verification Runbook

> **SAFETY GUARD:** `tests/e2e/run-live-e2e.js` strictly refuses to run against the production spreadsheet (`16NSuhDLinZQf9fpkrZYBu2ZyPM7Fq3dhutPZ78iDuWA`). Always use a dedicated staging spreadsheet copy and staging Apps Script deployment.

## Prerequisites
1. Local verification passes:
   ```powershell
   node -c Code.js
   node -c QrEncoder.js
   $fail=0; Get-ChildItem tests/*.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { $fail=1 } }; exit $fail
   node tests/browser/scanner.spec.js
   clasp status
   ```
2. Dedicated staging spreadsheet ID (`CSSO_STAGING_SHEET_ID`) and staging web app URL (`CSSO_STAGING_API_URL`) are provisioned and authorized.

## Staging E2E Execution
1. Set environment variables:
   ```powershell
   $env:CSSO_STAGING_SHEET_ID = "<STAGING_SHEET_ID>"
   $env:CSSO_STAGING_API_URL = "<STAGING_EXEC_URL>"
   $env:CSSO_E2E_PIN = "<STAGING_6_DIGIT_PIN>"
   $env:CSSO_E2E_TOK1 = "<STAGING_E2ETEST001_TOKEN>"
   $env:CSSO_E2E_TOK2 = "<STAGING_E2ETEST002_TOKEN>"
   ```
2. Run:
   ```powershell
   node tests/e2e/run-live-e2e.js
   ```
   The runner resolves `Config` keys dynamically by name and restores backed-up values in `finally`.

## Additional Staging Checklist (Manual / Browser)
1. **Browser CORS & Camera QA:** Open the hosted HTTPS scanner (`?api=<STAGING_EXEC_URL>`) in real mobile Chrome and Safari, verify camera permission prompt, live rear-camera QR scan, and `fetch()` POST across Google's 302 redirect.
2. **Controlled `GmailApp` Dispatch:** Select one staging test row (`E2ETEST001`) $\to$ **Send QR Pass to Selected Row(s)** $\to$ confirm `DISPATCHED` status, attempt counter, Gmail Sent folder copy, and readable inline QR PNG + plain-text fallback.
3. **`TARGET_EVENT_ID` & 7-Step Transition:** Verify pre-issuance rejection before activation, resumable `transitionToTargetEvent()`, post-activation `v2` acceptance, and permanent `v1` rejection.
4. **Protocol-Aware Rollback Check:** Record both the previous deployment version and minimum rollback-compatible version; verify rollback compatibility before sign-off.

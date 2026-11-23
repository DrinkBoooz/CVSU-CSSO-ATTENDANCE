# Live Chrome E2E Verification Runbook

Run this checklist against the deployed web app (`AKfycbwUMbXFKERYyNEWdGgDavVR4miCPD7OsDPBud_YsjSe3FbPdW-UiN26gclamX8UD_ou`) before any live CSSO event.

## Prerequisites
1. Local checks pass:
   ```powershell
   node -c Code.js
   $fail=0; Get-ChildItem tests/*.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { $fail=1 } }; exit $fail
   clasp status
   ```
2. Deployed latest code:
   ```powershell
   clasp push
   clasp update-deployment AKfycbwUMbXFKERYyNEWdGgDavVR4miCPD7OsDPBud_YsjSe3FbPdW-UiN26gclamX8UD_ou --description "e2e deploy"
   ```
3. Do **not** run during an active event (~20 min window).

## Setup (via `gsheets`)
1. Record original `Config` values (`EVENT_ID`, `LOCKED_STAGE`, `USHER_PIN`).
2. Ensure `USHER_PIN` is a 6+ digit numeric PIN (never commit to git).
3. Set `EVENT_ID = E2E-TEST` and `LOCKED_STAGE = AUTO`.
4. Append two test rows to `Roster`:
   - `E2ETEST001` | `danjosephortega3@gmail.com` | `E2E Qualified Student` | `BSCS 4-2`
   - `E2ETEST002` | `test-skip@example.com` | `E2E Incomplete Student` | `BSCS 4-2`
5. In the Google Sheet, run `Attendance Scanner` $\to$ `🚀 Implement New Features / Apply All Upgrades` (authorizes triggers if first run, backfills tokens in Col E).
6. Read generated tokens for `E2ETEST001` and `E2ETEST002` from `Roster` Col E.

## Live Chrome Tests
Target URL: `https://script.google.com/macros/s/AKfycbwUMbXFKERYyNEWdGgDavVR4miCPD7OsDPBud_YsjSe3FbPdW-UiN26gclamX8UD_ou/exec`

| # | Action | Expected Result |
|---|---|---|
| T1 | Enter PIN `000000` | `"Incorrect Usher PIN."` |
| T2 | Enter live 6-digit PIN, usher name `=E2E Gate` | Scanner unlocks; `E2E-TEST` badge shown; stage dropdown enabled |
| T3 | Submit `E2ETEST001|<tok1>` at `Check-In` via Manual Pass Code | Green `VERIFIED - CHECK-IN` banner |
| T4 | Submit `E2ETEST001|<tok1>` at `Check-In` again | Amber `ALREADY SCANNED` banner |
| T5 | Submit `E2ETEST001|AAAAAAAAAA` | Red `REJECTED` (`FORGED TOKEN`) |
| T6 | Submit `garbage` | Red `REJECTED` (`MALFORMED QR`) |
| T7 | Submit `E2ETEST001|<tok1>` at `Mid-Event`, then `Check-Out` | Green $\times 2$ |
| T8 | Submit `E2ETEST002|<tok2>` at `Check-In` | Green |
| T9 | Temporarily rotate `USHER_PIN` in `Config` via `gsheets`, then submit `E2ETEST002|<tok2>` at `Check-Out` | Server returns `UNAUTHORIZED`, **0 log rows added**, UI returns to PIN screen; restore `USHER_PIN` |
| T10 | Log in while `LOCKED_STAGE=AUTO`, pick `Check-Out`; change `LOCKED_STAGE=Mid-Event` via `gsheets`; click Submit; then reload | Submit returns Red `REJECTED` (`STAGE LOCKED`); reload locks dropdown to `Mid-Event` |
| T11 | In Google Sheet, select `E2ETEST001` row $\to$ `Attendance Scanner` $\to$ `Send QR Pass to Selected Row(s)` | `Roster` Col F becomes `SENT`; email received with QR + fallback code |

## Sheet Assertions (`gsheets`)
- `Attendance Log` rows with `Event ID = E2E-TEST`:
  - 4 `ACCEPTED`, 1 `DUPLICATE`, 1 `REJECTED_FORGED`, 1 `REJECTED_MALFORMED`, 1 `REJECTED_STAGE_LOCKED`, and 0 rows from T9.
  - Usher column F shows `=E2E Gate` as literal text (not `#ERROR!`).
- Run `Rebuild Verified Attendance` $\to$ `Verified Attendance`:
  - `E2ETEST001` = `QUALIFIED`, `Stage Count = 3`
  - `E2ETEST002` = `INCOMPLETE`, `Stage Count = 1`
  - Header `H1` remains `Stage Count`.

## Guaranteed Cleanup (Always Run)
1. Delete `Attendance Log` rows where `Event ID = E2E-TEST` (bottom-up).
2. Delete `Roster` rows where `Student ID` starts with `E2ETEST` (bottom-up).
3. Restore backed-up `Config` values (`EVENT_ID`, `LOCKED_STAGE`, live 6-digit `USHER_PIN`).
4. Run `Rebuild Verified Attendance`.
5. Confirm via `gsheets` that zero `E2E-TEST` / `E2ETEST*` rows remain.

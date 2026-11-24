# Antigravity Workspace Rules & System Directives
- **System Version:** Phase 1.0 Standard
- **Last Audited:** 2026-11-23
- **Controlled File:** `agents.md` (Canonical lowercase on disk; POSIX/Windows unified)

## 0. Agent Governance & Rule Modification
- **Controlled Artifact**: `agents.md` defines the immutable meta-governance and operational directives for all agents in this workspace.
- **Bifurcated Hierarchy Principle**:
  - *Meta-Governance Authority (Priority 0)*: Directives in `agents.md` governing agent behavior, commit formatting, branch permissions, approval boundaries, and clasp workflows are absolute and strictly override all other files.
  - *Approved Plan & Baseline Separation*: An explicitly approved implementation plan governs target-state architecture, locked decisions, phase ordering, and acceptance criteria. Existing code, tests, and live spreadsheet data (Section 1) establish the current-state baseline and do not automatically override an approved migration target.
- **No Unauthorized Modifications**: Agents must NEVER modify `agents.md` simply because they believe instructions could be improved. Any modification to `agents.md` requires explicit user instruction naming `agents.md` directly or approving an implementation plan with an explicit `agents.md` edit milestone.
- **No Silent Updates**: Documentation audits, script refactors, or feature implementations must not silently alter agent governance.
- **Reporting Issues & Non-Recursive Execution**: If a task exposes a genuine governance contradiction or missing rule, report it to the user in a dedicated audit deliverable rather than editing governance rules unilaterally. However, a completed forensic audit must not be repeated merely because an approved plan intentionally differs from the current implementation, and test failures initiate the prescribed debugging and regression workflow rather than automatic replanning.

## 1. Source-of-Truth Hierarchy & Anti-Fabrication
When inspecting the **current-state baseline**, agents must observe this hierarchy:
1. **Live Google Spreadsheet** (when inspection is authorized): Active columns, key-value settings, formulas, and data validations in `Config`, `Roster`, `Attendance Log`, and `Verified Attendance`.
2. **Google Apps Script & Frontend Codebase (`Code.js`, `Index.html`, `docs/index.html`, `appsscript.json`)**: Current local `dev` workspace files (never overwrite local changes with an unconditional `clasp pull`; serves as Tier 1 baseline in offline/sandbox environments).
3. **Automated Verification Suites & Tests (`tests/`)**: Node.js and browser test suites validating current and target contracts.
4. **CSSO-Specific Skills & Prompts (`./skills/` or `./skills-to-edit/`)**: Domain skills and operational templates (reserved per Section 6).
5. **Companion Documentation (`docs/`)**: Human-readable knowledge repository for event workflows, usher guides, and architecture.
6. **Workspace Rules**: `agents.md`.

- **Approved Implementation Plan Precedence**: When executing an explicitly approved implementation plan, that plan governs target-state architecture, locked decisions, phase ordering, and acceptance criteria. Existing code, tests, and live spreadsheet data establish the current-state baseline and do not automatically override an approved migration target.
- **Anti-Replanning & Debugging Rule**: A completed forensic audit must not be repeated merely because an approved plan intentionally differs from the current implementation. Test failures initiate the prescribed debugging and regression workflow, never automatic replanning.

> **Anti-Fabrication Rule**: Agents must never guess or fabricate column coordinates, sheet names, QR payload formats, config keys, or OAuth scopes. Always inspect `Code.js`, `Index.html`, `docs/index.html`, and (when authorized) live sheet headers.

## 2. Workspace Context & External Assets
- **Application Workspace:** `c:\Users\BooozMini\OneDrive\CVSU-CSSO-ATTENDANCE`
- **Google Apps Script Project:**
  - Script ID: `1cUsCC5SrGTkR1hiMXpjuTQPqbEfNhzOAB28_xW5rn7EyCgrODgkXMNc8`
  - Test/Active Deployment ID: `AKfycbwUMbXFKERYyNEWdGgDavVR4miCPD7OsDPBud_YsjSe3FbPdW-UiN26gclamX8UD_ou` (`CSSO Web Attendance Test`)
  - Web App URL: https://script.google.com/macros/s/AKfycbwUMbXFKERYyNEWdGgDavVR4miCPD7OsDPBud_YsjSe3FbPdW-UiN26gclamX8UD_ou/exec
  - Runtime: `V8` (`timeZone`: `Asia/Singapore`)
  - Web App (`Index.html` via `doGet()`): Usher QR Attendance Scanner (`executeAs: USER_DEPLOYING`, `access: ANYONE`, default `SAMEORIGIN` framing)
- **Target Google Spreadsheet:**
  - Spreadsheet ID: `16NSuhDLinZQf9fpkrZYBu2ZyPM7Fq3dhutPZ78iDuWA`
  - URL: https://docs.google.com/spreadsheets/d/16NSuhDLinZQf9fpkrZYBu2ZyPM7Fq3dhutPZ78iDuWA/edit?gid=0#gid=0
  - Primary Tabs:
    - `Config` — Key-value settings (`USHER_PIN`, `SECRET_SALT`, `EVENT_TITLE`).
    - `Roster` — Registered participants, signed QR tokens, and pass email status (`SENT`).
    - `Attendance Log` — Append-only scan log across checkpoint stages (`Check-In`, `Mid-Event`, `Check-Out`).
    - `Verified Attendance` — Rebuilt per-student summary and qualification status (`QUALIFIED` / `INCOMPLETE`).
  - Purpose: Manages CvSU CSSO event attendance via signed QR passes emailed to participants, scanned by ushers at three checkpoint stages (`Check-In`, `Mid-Event`, `Check-Out`), and aggregated into verified qualification records.
- **External Services:**
  - QR Image Generator: `https://quickchart.io/qr` (used by `generateAndEmailQRPasses()` to generate inline QR PNGs for participant emails).

## 3. Git Commit Formatting & Branching Protocols
- **Commit Format**: All git commit messages must strictly follow the format:
  `<commit_number>: <type>: <description based on chat changes>`
  - `<commit_number>`: Sequential repository commit count. In Windows PowerShell, MUST use explicit integer casting:
    `$([int](git rev-list --count HEAD) + 1)`
  - `<type>`: `feat`, `fix`, `refactor`, `docs`, `chore`, or `test`.
  - Example: `2: feat: add applyAllSystemUpgrades master menu action`
- **Pre-Commit Verification**: Before committing on `dev`, agents must execute `node -c Code.js` and verify any affected test suites in `tests/`.
- **Branching Workflow**:
  - **Development on `dev`**: All active work, feature implementations, tests, script edits, and task commits belong strictly on the `dev` branch.
  - **Do NOT Auto-Merge to `main`**: Merging into `main` must **NEVER** happen automatically at the end of a task or chat. Merging to `main` requires an explicit user prompt or request.
  - **Merging into `main` (Only When Prompted by User)**:
    - **Always use `--no-ff` (No Fast-Forward)**: Never perform fast-forward merges into `main`. Always force a dedicated merge commit using `git merge --no-ff <branch>` to preserve a distinct visual branch tree.
    - **Merge Commit Numbering**: Calculate `<commit_number>` from `dev` BEFORE checking out `main`:
      `$mergeNum = [int](git rev-list --count dev) + 1`
    - **Standard Merge Workflow**:
      1. Ensure all work is committed and pushed on `dev`.
      2. `$commitNum = [int](git rev-list --count dev) + 1`
      3. `git checkout main`
      4. `git merge --no-ff dev -m "$commitNum: merge dev into main - <description of merged changes>"`
      5. `git push origin main` (if remote is configured)
      6. `git checkout dev`

## 4. Google Apps Script & Clasp Development Lifecycle
1. **Safe Synchronization Check:** Do NOT run `clasp pull` unconditionally (and never during read-only audits or active local `dev` implementation). Before any synchronization, check `git status`, preserve local changes, and inspect remote/local differences.
2. **File Modifications:**
   - Write standard modern JavaScript supported by the V8 runtime.
   - Maintain modular organization across functions with clean JSDoc comments.
   - Do not edit `.clasp.json` or remove essential `webapp` settings or OAuth scopes from `appsscript.json`.
3. **Pre-Push Multi-Phase Verification:**
   - Step 1 (Syntax): `node -c Code.js` must exit with code 0.
   - Step 2 (Regression Tests): Execute `$fail=0; Get-ChildItem tests/*.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { $fail=1 } }; exit $fail` and ensure all test suites pass.
   - Step 3 (Deploy Status): Verify tracked files via `clasp status` (only `Code.js`, `Index.html`, and `appsscript.json` tracked; Markdown/docs/tests excluded via `.claspignore`).
4. **Authorized Push, Deploy & Staging E2E:**
   - `clasp push`, `clasp update-deployment`, GitHub Pages publication (`docs/`), production spreadsheet mutations, and live E2E execution each require their respective explicit user authorization (never execute automatically after local verification).
   - When authorized to update the versioned web app deployment:
     `clasp update-deployment AKfycbwUMbXFKERYyNEWdGgDavVR4miCPD7OsDPBud_YsjSe3FbPdW-UiN26gclamX8UD_ou --description "<summary>"`
   - When authorized to run live E2E verification (`tests/e2e/run-live-e2e.js` / `tests/e2e/E2E_RUNBOOK.md`), use isolated staging resources only and enforce the production-sheet safety guard.

## 5. Google Sheets Schema & Integrity Standards
1. **Formulas vs. Scripts:**
   - Prefer native, traditional spreadsheet formulas over custom Apps Script functions whenever standard formulas achieve the desired outcome, ensuring cross-platform compatibility.
   - All summary/dashboard KPI formulas must use bounded ranges (e.g., `'Attendance Log'!A2:A5000`) rather than open-ended ranges (`A2:A`) for Microsoft Excel compatibility.
   - **Formula Overlap Guard**: Formulas using wildcards must never overlap; count distinct status strings explicitly to prevent double-counting.
2. **Canonical Tab Schemas (Observed in `Code.js` and Live Sheet):**
   - **`Config`** (Key-Value pairs in Cols A–C: `Key`, `Value`, `Notes`):
     - `USHER_PIN` (required 6+ digit numeric PIN; never hardcode or commit production PINs)
     - `SECRET_SALT` (required 16+ char secret; never hardcode or commit production secrets)
     - `EVENT_TITLE` (default fallback: `Event QR Attendance Scanner`)
     - `EVENT_ID` (default fallback: `DEFAULT`; scopes duplicate detection and `Verified Attendance`)
     - `LOCKED_STAGE` (`AUTO`, `Check-In`, `Mid-Event`, or `Check-Out`; enforced server-side and in UI)
     - `ENFORCE_STAGE_ORDER` (`TRUE` or `FALSE`; if `TRUE`, requires `Check-In` $\to$ `Mid-Event` $\to$ `Check-Out`)
   - **`Roster` (7 columns A–G):**
     - **Col A (1):** `Student ID` (formatted as plain text `@`)
     - **Col B (2):** `Email`
     - **Col C (3):** `Full Name`
     - **Col D (4):** `Section`
     - **Col E (5):** `Token` (10-char uppercase SHA-256 prefix of `STUDENTID|SECRET_SALT`)
     - **Col F (6):** `Pass Status` (`SENT` or `ERROR: ...`)
     - **Col G (7):** `QR Preview` (preserved by script; untouched on writes)
   - **`Attendance Log` (8 columns A–H):**
     - **Col A (1):** `Timestamp`
     - **Col B (2):** `Stage` (`Check-In`, `Mid-Event`, `Check-Out`)
     - **Col C (3):** `Student ID`
     - **Col D (4):** `Full Name`
     - **Col E (5):** `Section`
     - **Col F (6):** `Usher Label` (from verified session token; sanitized via `safeCell_()`)
     - **Col G (7):** `Scan Status` (`ACCEPTED`, `DUPLICATE`, `REJECTED_FORGED`, `REJECTED_MALFORMED`, `REJECTED_NOT_IN_ROSTER`, `REJECTED_STAGE_LOCKED`, `REJECTED_STAGE_ORDER`)
     - **Col H (8):** `Event ID`
   - **`Verified Attendance` (8 columns A–H):**
     - **Col A (1):** `Student ID`
     - **Col B (2):** `Full Name`
     - **Col C (3):** `Section`
     - **Col D (4):** `Check-In` (time string `HH:mm:ss` or `—`)
     - **Col E (5):** `Mid-Event` (time string `HH:mm:ss` or `—`)
     - **Col F (6):** `Check-Out` (time string `HH:mm:ss` or `—`)
     - **Col G (7):** `Qualification` (`QUALIFIED` if all 3 stages present, else `INCOMPLETE`)
     - **Col H (8):** `Stage Count` (`0`–`3`)
3. **Security, Concurrency & Data Handling:**
   - All `recordScan(sessionToken, payloadStr, stage)` calls MUST validate the stateless HMAC-signed `sessionToken` server-side against `SECRET_SALT` and `USHER_PIN`; invalid sessions return `UNAUTHORIZED` without writing any log row.
   - Always sanitize user-supplied strings with `safeCell_()` before writing to any sheet to prevent formula injection (`=`, `+`, `-`, `@`).
   - Always guard scan writes (`recordScan`), email sending (`sendPasses_`), and summary rebuilds (`rebuildVerifiedAttendance`) with `LockService.getScriptLock()`. Never rebuild `Verified Attendance` inside `recordScan()`; rely on the 5-minute installable trigger and manual menu rebuild.
   - Use batch reads (`getValues()`) and batch writes (`setValues()`) rather than cell-by-cell loops to avoid Apps Script 6-minute execution timeouts.
   - Normalize Student IDs consistently via `normalizeId_()` when matching `Roster` and `Attendance Log` entries.

## 6. CSSO-Specific Skills & Automation Suite (Placeholder)
This section is reserved for future CSSO Attendance skills, prompt templates, and operational playbooks (e.g., `./skills/` or `./skills-to-edit/`).
- **Contract Lockstep**: Any future skill or prompt that references sheet columns, QR payload formats (`STUDENTID|TOKEN`), or checkpoint stages (`Check-In`, `Mid-Event`, `Check-Out`) must remain synchronized with `Code.js` and `Index.html`.

## 7. Master System Upgrades Action ("Implement New Features" Protocol)
- **Mandatory Master Entry Point**: Maintain a dedicated master function `applyAllSystemUpgrades()` in `Code.js` wired to the very top of the custom spreadsheet menu (`Attendance Scanner` $\to$ `🚀 Implement New Features / Apply All Upgrades`).
- **Scope of Master Action**: Whenever any applicable workbook, schema, data validation, conditional formatting rule, installable trigger, or new sheet/tab change is created or updated:
  - Agents MUST update `applyAllSystemUpgrades()` in `Code.js` so that clicking this single menu item immediately applies those spreadsheet updates in one go.
  - Execute steps with per-step `try/catch` fault isolation (e.g., tab/header initialization, conditional formatting, installable triggers, `rebuildVerifiedAttendance_()`, and a consolidated status modal alert summarizing applied updates).
  - This requirement applies to workbook/schema/validation/formatting/trigger changes only; it is not an automatic requirement for unrelated backend-only, frontend-only, or test-only work, and does not authorize restricted production operations.
- **Agent Governance Directive**: The user should never have to manually run multiple script functions or search through submenus to apply newly deployed workbook capabilities.

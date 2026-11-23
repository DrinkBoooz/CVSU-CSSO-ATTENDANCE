# Antigravity Workspace Rules & System Directives
- **System Version:** Phase 1.0 Standard
- **Last Audited:** 2026-11-23
- **Controlled File:** `agents.md` (Canonical lowercase on disk; POSIX/Windows unified)

## 0. Agent Governance & Rule Modification
- **Controlled Artifact**: `agents.md` defines the immutable meta-governance and operational directives for all agents in this workspace.
- **Bifurcated Hierarchy Principle**:
  - *Meta-Governance Authority (Priority 0)*: Directives in `agents.md` governing agent behavior, commit formatting, branch permissions, and clasp workflows are absolute and strictly override all other files.
  - *Domain Technical Truth (Priority 1–6)*: Technical data structures, column schemas, and formula specifications are subordinate to live sheets, `Code.js`, `Index.html`, and test suites as defined in Section 1.
- **No Unauthorized Modifications**: Agents must NEVER modify `agents.md` simply because they believe instructions could be improved. Any modification to `agents.md` requires explicit user instruction naming `agents.md` directly or approving an implementation plan with an explicit `agents.md` edit milestone.
- **No Silent Updates**: Documentation audits, script refactors, or feature implementations must not silently alter agent governance.
- **Reporting Issues**: If a task exposes a governance contradiction or missing rule, report it to the user in a dedicated audit deliverable rather than editing governance rules unilaterally.

## 1. Source-of-Truth Hierarchy & Anti-Fabrication
When resolving discrepancies or ambiguous technical specifications, agents must strictly observe this hierarchy:
1. **Live Google Spreadsheet**: Active columns, key-value settings, formulas, and data validations in `Config`, `Roster`, `Attendance Log`, and `Verified Attendance`.
2. **Google Apps Script Codebase (`Code.js`, `Index.html`, `appsscript.json`)**: Pulled directly via `clasp pull`. (Serves as Tier 1 ground truth in offline/sandbox environments).
3. **Automated Verification Suites & Tests (`tests/`)**: Node.js test suites (when present) validating QR signature generation, duplicate-scan prevention, ID normalization, and attendance rebuilds.
4. **CSSO-Specific Skills & Prompts (`./skills/` or `./skills-to-edit/`)**: Domain skills and operational templates (reserved per Section 6).
5. **Companion Documentation (`docs/`)**: Human-readable knowledge repository for event workflows, usher guides, and architecture.
6. **Workspace Rules**: `agents.md`.

> **Anti-Fabrication Rule**: Agents must never guess or fabricate column coordinates, sheet names, QR payload formats, config keys, or OAuth scopes. Always inspect `Code.js`, `Index.html`, and live sheet headers.

## 2. Workspace Context & External Assets
- **Application Workspace:** `c:\Users\BooozMini\OneDrive\CVSU-CSSO-ATTENDANCE`
- **Google Apps Script Project:**
  - Script ID: `1cUsCC5SrGTkR1hiMXpjuTQPqbEfNhzOAB28_xW5rn7EyCgrODgkXMNc8`
  - Runtime: `V8` (`timeZone`: `Asia/Singapore`)
  - Web App (`Index.html` via `doGet()`): Usher QR Attendance Scanner (`executeAs: USER_DEPLOYING`, `access: ANYONE`)
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
1. **Pull First:** Always run `clasp pull` before reading or editing any script file (`Code.js`, `Index.html`, or `appsscript.json`) to prevent overwriting edits made directly in the Apps Script online editor.
2. **File Modifications:**
   - Write standard modern JavaScript supported by the V8 runtime.
   - Maintain modular organization across functions with clean JSDoc comments.
   - Do not edit `.clasp.json` or remove essential `webapp` settings or OAuth scopes from `appsscript.json`.
3. **Pre-Push Multi-Phase Verification:**
   - Step 1 (Syntax): `node -c Code.js` must exit with code 0.
   - Step 2 (Regression Tests): If `tests/` exists, execute `Get-ChildItem tests/*.js | ForEach-Object { node $_.FullName }` to ensure all test suites pass.
   - Step 3 (Deploy Status): Verify tracked files via `clasp status` (only `Code.js`, `Index.html`, and `appsscript.json` tracked; Markdown/docs excluded via `.claspignore`).
4. **Push & Deploy:**
   - After passing all verification phases, execute `clasp push` in terminal.
   - Inspect terminal output to verify all files pushed successfully. Never push Markdown or documentation files to Apps Script.

## 5. Google Sheets Schema & Integrity Standards
1. **Formulas vs. Scripts:**
   - Prefer native, traditional spreadsheet formulas over custom Apps Script functions whenever standard formulas achieve the desired outcome, ensuring cross-platform compatibility.
   - All summary/dashboard KPI formulas must use bounded ranges (e.g., `'Attendance Log'!A2:A5000`) rather than open-ended ranges (`A2:A`) for Microsoft Excel compatibility.
   - **Formula Overlap Guard**: Formulas using wildcards must never overlap; count distinct status strings explicitly to prevent double-counting.
2. **Canonical Tab Schemas (Observed in `Code.js`):**
   - **`Config`** (Key-Value pairs in Cols A–B):
     - `USHER_PIN` (default fallback: `4829`)
     - `SECRET_SALT` (must be overridden in live sheet; never hardcode production secrets in `Code.js`)
     - `EVENT_TITLE` (default fallback: `Event QR Attendance Scanner`)
   - **`Roster` (6 columns A–F):**
     - **Col A (1):** `Student ID`
     - **Col B (2):** `Email`
     - **Col C (3):** `Full Name`
     - **Col D (4):** `Section`
     - **Col E (5):** `Token` (10-char uppercase SHA-256 prefix of `STUDENTID|SECRET_SALT`)
     - **Col F (6):** `Pass Status` (`SENT` once emailed)
   - **`Attendance Log` (7 columns A–G):**
     - **Col A (1):** `Timestamp`
     - **Col B (2):** `Stage` (`Check-In`, `Mid-Event`, `Check-Out`)
     - **Col C (3):** `Student ID`
     - **Col D (4):** `Full Name`
     - **Col E (5):** `Section`
     - **Col F (6):** `Usher Label` (truncated to 40 chars)
     - **Col G (7):** `Status` (`ACCEPTED`)
   - **`Verified Attendance` (7 columns A–G):**
     - **Col A (1):** `Student ID`
     - **Col B (2):** `Full Name`
     - **Col C (3):** `Section`
     - **Col D (4):** `Check-In` (time string `HH:mm:ss` or `—`)
     - **Col E (5):** `Mid-Event` (time string `HH:mm:ss` or `—`)
     - **Col F (6):** `Check-Out` (time string `HH:mm:ss` or `—`)
     - **Col G (7):** `Qualification` (`QUALIFIED` if all 3 stages present, else `INCOMPLETE`)
3. **Security, Concurrency & Data Handling:**
   - Always guard scan writes (`recordScan`) and summary rebuilds (`rebuildVerifiedAttendance`) with `LockService.getScriptLock()`.
   - Use batch reads (`getValues()`) and batch writes (`setValues()`) rather than cell-by-cell loops to avoid Apps Script 6-minute execution timeouts.
   - Normalize Student IDs consistently via `normalizeId_()` when matching `Roster` and `Attendance Log` entries.

## 6. CSSO-Specific Skills & Automation Suite (Placeholder)
This section is reserved for future CSSO Attendance skills, prompt templates, and operational playbooks (e.g., `./skills/` or `./skills-to-edit/`).
- **Contract Lockstep**: Any future skill or prompt that references sheet columns, QR payload formats (`STUDENTID|TOKEN`), or checkpoint stages (`Check-In`, `Mid-Event`, `Check-Out`) must remain synchronized with `Code.js` and `Index.html`.

## 7. Master System Upgrades Action ("Implement New Features" Protocol)
- **Mandatory Master Entry Point**: Maintain a dedicated master function `applyAllSystemUpgrades()` in `Code.js` wired to the very top of the custom spreadsheet menu (`Attendance Scanner` $\to$ `🚀 Implement New Features / Apply All Upgrades`).
- **Scope of Master Action**: Whenever any new feature, schema upgrade, data validation, conditional formatting rule, trigger, or new workbook sheet/tab is created or updated:
  - Agents MUST update `applyAllSystemUpgrades()` in `Code.js` so that clicking this single menu item immediately applies all new sheet, config, trigger, and data updates in one go.
  - Execute steps with per-step `try/catch` fault isolation (e.g., tab/header initialization, conditional formatting, installable triggers, `rebuildVerifiedAttendance_()`, and a consolidated status modal alert summarizing applied updates).
- **Agent Governance Directive**: The user should never have to manually run multiple script functions or search through submenus to apply newly deployed capabilities.

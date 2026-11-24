# Quick-Start Fork Guide (Google Sheets & Optional GitHub Pages)

Follow this setup to launch your own isolated, **zero-email** Event QR Attendance System from the Master Template — either using the shared static frontend (`?api=...`) or under your **own GitHub Pages fork**.

---

## Step 1: Make Your Own Copy

1. Open the shared Master Template `/copy` link while signed in to a **personal `@gmail.com` account** _(recommended so your Web App runs with anonymous access — university Workspace accounts often block anonymous Web Apps)_.
2. Click **Make a copy**. This clones all 4 tabs (`Config`, `Roster`, `Attendance Log`, `Verified Attendance`) and the bound Apps Script backend with **zero** shared data, triggers, or secrets.

---

## Step 2: Configure & Initialize (1 Click)

1. Open the **`Config`** tab and update:
   - **`USHER_PIN`** — set your own 6+ digit numeric PIN for ushers.
   - **`EVENT_TITLE`** — your event name (shown on the QR Pass Portal, composite PNG card & scanner).
   - **`EVENT_ID`** — a unique event code (e.g., `CSSO-GA-2026`).
   - _(Leave `SECRET_SALT` as-is — the next step auto-generates a unique 32-character random secret for your copy.)_
2. Click **Attendance Scanner → 🚀 Implement New Features / Apply All Upgrades** in the top menu.
   - Approve the Google permissions prompt (_Advanced → Go to project → Allow_).
   - Auto-generates `SECRET_SALT`, repairs headers (including `Pass PIN Hash` in `Roster` Col O), adds `PORTAL_BASE_URL` / `WEB_APP_URL` rows to `Config`, applies formatting, and installs triggers.

---

## Step 3: Deploy Your Web App (15 Seconds)

1. Open **Extensions → Apps Script**.
2. Click **Deploy → New deployment**:
   - **Type:** `Web app`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
3. Click **Deploy** and copy your **Web app URL** (`https://script.google.com/macros/s/<YOUR_DEPLOYMENT_ID>/exec`).

---

## Step 4: Connect Your Frontend (Choose Option A or Option B)

### Option A: Use Your Own Forked GitHub Pages URL (Recommended for Organizations)
1. Fork this repository on GitHub and enable **Settings → Pages** from branch `main` / folder `/docs`.
2. Edit 1 line in **`docs/config.js`**:
   ```js
   window.CSSO_CONFIG = {
     DEFAULT_API_URL: 'https://script.google.com/macros/s/<YOUR_DEPLOYMENT_ID>/exec'
   };
   ```
3. Commit and push to `main`. Your permanent links are now:
   - **Usher Scanner:** `https://<YOUR-GITHUB-USER>.github.io/<YOUR-REPO>/`
   - **Student Pass Portal:** `https://<YOUR-GITHUB-USER>.github.io/<YOUR-REPO>/pass.html`
4. In your Google Sheet **`Config`** tab, set **`PORTAL_BASE_URL`** to `https://<YOUR-GITHUB-USER>.github.io/<YOUR-REPO>` (and optionally **`WEB_APP_URL`** to your `/exec` URL).

### Option B: Zero-GitHub Setup (Pass `?api=` in the Link)
Set **`WEB_APP_URL`** in your Google Sheet **`Config`** tab to your `/exec` URL and access:
- **Usher Scanner:** `<PORTAL_BASE_URL>/?api=<YOUR_WEB_APP_URL>`
- **Student Pass Portal:** `<PORTAL_BASE_URL>/pass.html?api=<YOUR_WEB_APP_URL>`

---

## Step 5: Create Your Registration Form & Portal Sync (1 Click)

1. Click **Attendance Scanner → 📝 Setup Registration Form & Portal Sync**.
   - Creates/updates a Google Form with **verified email collection**, **1 response per Google account**, and required fields (`Student ID`, `Full Name`, `Section`, and a private 4–6 digit **`Personal Pass PIN`**).
   - Installs `onFormSubmit` enforcing strict **1 submission per Student ID / Email** (`READY_ON_PORTAL` in `Roster`, `Pass PIN Hash` in Col O, **0 emails used**).
   - Saves both **`REGISTRATION_FORM_URL`** (shareable link) and **`REGISTRATION_FORM_EDIT_URL`** (admin edit link) in `Config`, and automatically writes your Pass Portal link into the Form confirmation screen.

---

## Helpful Maintenance Actions (`Attendance Scanner` Menu)

- **`🧹 Clear Attendance Log & Verified Attendance (Keep Roster)`** — clears test/prior scan logs and verified summaries while keeping your registered `Roster` and `Config` (requires typing `CLEAR LOGS`).
- **`🧹 Clear All Data Rows (Keep Headers & Config)`** — full wipe across `Roster`, `Attendance Log`, and `Verified Attendance` (requires typing `CLEAR ALL`).
- **`Rebuild Verified Attendance`** — manually refreshes `QUALIFIED` (3/3 stages) / `INCOMPLETE` summary tab.

---

## Optional Security Hardening (Recommended Before Public Event)
- Open **Extensions → Apps Script**, select **`migrateSecretsToProperties`**, and click **Run** once.
- Moves `USHER_PIN` and `SECRET_SALT` out of the plaintext `Config` tab into private **`ScriptProperties`** so spreadsheet Viewers/Editors cannot see your secrets.
- Both `docs/index.html` and `docs/pass.html` enforce a strict Content Security Policy (CSP) and reject any untrusted `?api=` URL not matching `https://script.google.com/macros/s/.../exec`.

# Quick-Start Fork Guide (Google Sheets `/copy` Template)

Follow this 2-minute setup to launch your own isolated, **zero-email** Event QR Attendance System from the Master Template — **no GitHub fork, no coding, and no daily email quota limits**.

---

## Step 1: Make Your Own Copy
1. Open the shared Master Template `/copy` link while signed in to a **personal `@gmail.com` account** *(recommended so your Web App runs with anonymous access — university Workspace accounts often block anonymous Web Apps)*.
2. Click **Make a copy**. This clones all 4 tabs (`Config`, `Roster`, `Attendance Log`, `Verified Attendance`) and the entire bound Apps Script backend with **zero** shared data, triggers, or secrets.

---

## Step 2: Configure & Initialize (1 Click)
1. Open the **`Config`** tab and update:
   - **`USHER_PIN`** — set your own 6+ digit numeric PIN for ushers.
   - **`EVENT_TITLE`** — your event name (shown on the QR Pass Portal & scanner).
   - **`EVENT_ID`** — a unique event code (e.g., `CSSO-GA-2026`).
   - *(Leave `SECRET_SALT` as-is — the next step auto-generates a unique 32-character random secret for your copy.)*
2. Click **Attendance Scanner → 🚀 Implement New Features / Apply All Upgrades** in the top menu.
   - Approve the Google permissions prompt (*Advanced → Go to project → Allow*).
   - Automatically generates your `SECRET_SALT`, repairs headers, applies formatting, and installs the 5-minute `Verified Attendance` + `onEdit` triggers.

---

## Step 3: Deploy Your Web App (15 Seconds)
1. Open **Extensions → Apps Script**.
2. Click **Deploy → New deployment**:
   - **Type:** `Web app`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
3. Click **Deploy** and copy your **Web app URL** (`https://script.google.com/macros/s/.../exec`).

You now have both live hosted URLs connected directly to **your** spreadsheet:
- **Usher Scanner (Instant Mode + Offline Batch Sync):**
  ```text
  https://drinkboooz.github.io/CVSU-CSSO-ATTENDANCE/?api=<YOUR_WEB_APP_URL>
  ```
- **Student QR Pass Portal (Zero-Email Download):**
  ```text
  https://drinkboooz.github.io/CVSU-CSSO-ATTENDANCE/pass.html?api=<YOUR_WEB_APP_URL>
  ```

---

## Step 4: Create Your Registration Form & Portal Sync (1 Click)
1. Click **Attendance Scanner → 📝 Setup Registration Form & Portal Sync**.
   - Creates a Google Form with **verified email collection**, **1 response per student**, and **all required fields** (`Student ID`, `Full Name`, `Section`).
   - Installs the `onFormSubmit` trigger so every submission immediately syncs into `Roster` (`READY_ON_PORTAL`) with **0 emails used** (unlimited daily registrations).
   - Saves the shareable Form URL in `Config` (`REGISTRATION_FORM_URL`).
2. Open the Form's **Edit URL** → **Settings → Presentation → Confirmation message** and paste your **Student QR Pass Portal** link from Step 3 (`...pass.html?api=<YOUR_WEB_APP_URL>`) so students can immediately view and download their signed QR PNG right after submitting.

---

## Helpful Maintenance Actions (Attendance Scanner Menu)
- **`🧹 Clear All Data Rows (Keep Headers & Config)`** — safely wipes `Roster`, `Attendance Log`, and `Verified Attendance` (requires typing `CLEAR ALL`) when resetting for a fresh event.
- **`Rebuild Verified Attendance`** — manually refreshes the `QUALIFIED` (3/3 stages) / `INCOMPLETE` summary tab anytime.
- **`Generate & Email QR Passes (All Pending)`** *(optional)* — only needed if you manually paste rows into `Roster` and prefer emailing passes instead of using the zero-email QR Pass Portal.

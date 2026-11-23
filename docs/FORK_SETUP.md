# Quick-Start Fork Guide (Google Sheets `/copy` Template)

Follow this 2-minute setup to launch your own isolated Event QR Attendance System from the Master Template — **no GitHub fork or coding required**.

---

## Step 1: Make Your Own Copy
1. Open the shared Master Template `/copy` link while signed in to a **personal `@gmail.com` account** *(recommended so your scanner Web App can run with anonymous access — university Workspace accounts often block anonymous Web Apps)*.
2. Click **Make a copy**. This clones all 4 tabs (`Config`, `Roster`, `Attendance Log`, `Verified Attendance`) and the entire bound Apps Script backend with **zero** shared data, triggers, or secrets.

---

## Step 2: Configure & Initialize (1 Click)
1. Open the **`Config`** tab and update:
   - **`USHER_PIN`** — set your own 6+ digit numeric PIN for ushers.
   - **`EVENT_TITLE`** — your event name (shown on QR emails & scanner).
   - **`EVENT_ID`** — a unique event code (e.g., `CSSO-GA-2026`).
   - *(Leave `SECRET_SALT` as-is — the next step auto-generates a unique 32-character random secret for your copy.)*
2. Click **Attendance Scanner → 🚀 Implement New Features / Apply All Upgrades** in the top menu.
   - Approve the Google permissions prompt (*Advanced → Go to project → Allow*).
   - This automatically generates your `SECRET_SALT`, repairs headers, applies formatting, and installs the 5-minute `Verified Attendance` + `onEdit` triggers.

---

## Step 3: Create Your Auto-Registration Form & Emailer (1 Click)
1. *(Optional — for 1,500 emails/day Workspace quota instead of 100/day Gmail quota)*:
   - Share your copied spreadsheet as **Editor** with your **`@cvsu.edu.ph`** (or Google Workspace) account.
   - Open the spreadsheet while signed in as that **`@cvsu.edu.ph`** account.
2. Click **Attendance Scanner → 📝 Setup Registration Form & Auto-Email Trigger**.
   - Creates a Google Form with **verified email collection**, **1 response per student**, and **all required fields** (`Student ID`, `Full Name`, `Section`).
   - Installs the automatic `onFormSubmit` trigger so every student receives their signed QR Attendance Pass via email immediately upon submitting.
   - Saves the shareable Form URL in `Config` (`REGISTRATION_FORM_URL`).

---

## Step 4: Deploy Your Scanner Web App (15 Seconds)
1. Back in your **personal `@gmail.com`** account, open **Extensions → Apps Script**.
2. Click **Deploy → New deployment**:
   - **Type:** `Web app`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
3. Click **Deploy** and copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`).
4. Give your ushers the hosted mobile scanner link with your URL attached:
   ```text
   https://drinkboooz.github.io/CVSU-CSSO-ATTENDANCE/?api=<YOUR_WEB_APP_URL>
   ```
   *(Ushers log in with your `USHER_PIN` and scan in **Instant Mode** with automatic offline-safe batch syncing!)*

---

## Helpful Maintenance Actions (Attendance Scanner Menu)
- **`🧹 Clear All Data Rows (Keep Headers & Config)`** — safely wipes `Roster`, `Attendance Log`, and `Verified Attendance` (requires typing `CLEAR ALL`) when resetting for a fresh event.
- **`Generate & Email QR Passes (All Pending)`** — bulk-emails QR passes if you also paste manual rows into `Roster`.
- **`Rebuild Verified Attendance`** — manually refreshes the `QUALIFIED` (3/3 stages) / `INCOMPLETE` summary tab anytime.

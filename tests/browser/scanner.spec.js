'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function startTestServer() {
  const docsDir = path.resolve(__dirname, '..', '..', 'docs');
  let forceUnauthorized = false;
  let forceServerFail = false;

  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];

    if (req.method === 'POST' && urlPath === '/api') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        if (forceServerFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, status: 'INTERNAL_ERROR', message: 'Simulated outage' }));
          return;
        }
        const body = JSON.parse(raw || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (body.action === 'ping') {
          res.end(JSON.stringify({ ok: true, status: 'OK', version: 'test-v1', eventId: 'CSSO-2026' }));
          return;
        }
        if (body.action === 'login') {
          if (body.pin === '619482') {
            res.end(JSON.stringify({
              ok: true,
              sessionToken: 'tok.123',
              usherLabel: body.usherName || 'Usher',
              eventTitle: 'CSSO Test',
              eventId: 'CSSO-2026',
              lockedStage: 'AUTO'
            }));
          } else {
            res.end(JSON.stringify({ ok: false, message: 'Incorrect Usher PIN.' }));
          }
          return;
        }
        if (body.action === 'state') {
          if (forceUnauthorized || body.sessionToken !== 'tok.123') {
            res.end(JSON.stringify({ ok: false, status: 'UNAUTHORIZED', message: 'Session expired.' }));
          } else {
            res.end(JSON.stringify({ ok: true, eventTitle: 'CSSO Test', eventId: 'CSSO-2026', lockedStage: 'AUTO' }));
          }
          return;
        }
        if (body.action === 'scan') {
          if (forceUnauthorized || body.sessionToken !== 'tok.123') {
            res.end(JSON.stringify({ status: 'UNAUTHORIZED', message: 'Session expired.' }));
            return;
          }
          if (body.payload === 'VALID_PASS') {
            res.end(JSON.stringify({ status: 'OK', fullName: 'Juan Dela Cruz', studentId: '202310001', section: 'BSCS 4-2', stage: body.stage, time: '10:00:00' }));
          } else if (body.payload === 'WRONG_EVT') {
            res.end(JSON.stringify({ status: 'REJECTED_WRONG_EVENT', message: 'Pass belongs to another event.' }));
          } else if (body.payload === 'V1_RET') {
            res.end(JSON.stringify({ status: 'REJECTED_V1_RETIRED', message: 'Legacy pass retired.' }));
          } else {
            res.end(JSON.stringify({ status: 'REJECTED_FORGED', message: 'Forged token.' }));
          }
          return;
        }
        res.end(JSON.stringify({ status: 'ERROR', message: 'Unknown action' }));
      });
      return;
    }

    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.join(docsDir, rel);
    if (!filePath.startsWith(docsDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const mime = ext === '.js' ? 'application/javascript' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  });

  return {
    server,
    setForceUnauthorized: v => { forceUnauthorized = v; },
    setForceServerFail: v => { forceServerFail = v; }
  };
}

async function run() {
  const srv = startTestServer();
  await new Promise(resolve => srv.server.listen(0, '127.0.0.1', resolve));
  const port = srv.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/?api=${encodeURIComponent(`http://127.0.0.1:${port}/api`)}`;

  let browser;
  try {
    const sysChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const launchOpts = (!process.env.CI && fs.existsSync(sysChrome))
      ? { headless: true, executablePath: sysChrome }
      : { headless: true };
    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();

    const externalRequests = [];
    page.on('request', req => {
      const u = req.url();
      if (!u.startsWith(`http://127.0.0.1:${port}`)) externalRequests.push(u);
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // 1. Zero external CDN requests (self-hosted vendor/html5-qrcode.min.js)
    assert.strictEqual(externalRequests.length, 0, 'Unexpected external requests: ' + externalRequests.join(', '));

    // 2. Wrong PIN then valid PIN
    await page.fill('#pinInput', '000000');
    await page.click('#unlockBtn');
    await page.waitForFunction(() => document.getElementById('pinError').textContent.includes('Incorrect Usher PIN'));

    await page.fill('#pinInput', '619482');
    await page.fill('#usherNameInput', 'Gate A');
    await page.click('#unlockBtn');
    await page.waitForSelector('#scannerScreen', { state: 'visible' });
    assert.strictEqual(await page.textContent('#eventIdBadge'), 'CSSO-2026');
    assert.ok((await page.textContent('#apiVersionNote')).includes('test-v1'));

    // 3. Mobile 375px layout has no horizontal overflow
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.strictEqual(overflow, false, 'Mobile 375px layout overflowed horizontally');

    // 4. Reload restores session
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#scannerScreen', { state: 'visible' });

    // 5. Manual scans: OK, WRONG_EVENT, V1_RETIRED
    await page.fill('#manualInput', 'VALID_PASS');
    await page.click('#manualSubmit');
    await page.waitForFunction(() => document.getElementById('resTitle').textContent.includes('VERIFIED'));
    assert.strictEqual(await page.textContent('#scanCount'), '1');

    await page.waitForTimeout(350);
    await page.fill('#manualInput', 'WRONG_EVT');
    await page.click('#manualSubmit');
    await page.waitForFunction(() => document.getElementById('resName').textContent === 'WRONG EVENT');

    await page.waitForTimeout(350);
    await page.fill('#manualInput', 'V1_RET');
    await page.click('#manualSubmit');
    await page.waitForFunction(() => document.getElementById('resName').textContent === 'LEGACY PASS RETIRED');

    // 6. Server failure recovers cleanly without deadlocking isProcessing
    srv.setForceServerFail(true);
    await page.waitForTimeout(350);
    await page.fill('#manualInput', 'VALID_PASS');
    await page.click('#manualSubmit');
    await page.waitForFunction(() => document.getElementById('resTitle').textContent === 'REJECTED');
    srv.setForceServerFail(false);

    // 7. UNAUTHORIZED redirects back to PIN screen
    srv.setForceUnauthorized(true);
    await page.waitForTimeout(1300);
    await page.fill('#manualInput', 'VALID_PASS');
    await page.click('#manualSubmit');
    await page.waitForSelector('#pinScreen', { state: 'visible' });

    console.log('PASS: tests/browser/scanner.spec.js');
  } finally {
    if (browser) await browser.close();
    srv.server.close();
  }
}

run().catch(err => {
  console.error('BROWSER TEST FAILED:', err);
  process.exit(1);
});

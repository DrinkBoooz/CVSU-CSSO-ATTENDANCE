"use strict";

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function startTestServer() {
  const docsDir = path.resolve(__dirname, "..", "..", "docs");
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split("?")[0];
    if (req.method === "POST" && urlPath === "/api") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        res.writeHead(200, { "Content-Type": "application/json" });
        if (
          body.action === "lookupPass" &&
          body.studentId === "202310001" &&
          body.email === "juan@cvsu.edu.ph" &&
          body.passPin === "4829"
        ) {
          res.end(
            JSON.stringify({
              ok: true,
              eventTitle: "CSSO Test",
              eventId: "CSSO-2026",
              protocol: "v2",
              studentId: "202310001",
              fullName: "Juan Dela Cruz",
              section: "BSCS 4-2",
              payload: "v2|CSSO-2026|202310001|SECRETHMAC",
              qrDataUri: TINY_PNG,
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              ok: false,
              status: "NOT_FOUND",
              message: "No matching registration found.",
            }),
          );
        }
      });
      return;
    }
    const rel = urlPath === "/" ? "pass.html" : urlPath.replace(/^\/+/, "");
    const filePath = path.join(docsDir, rel);
    if (!filePath.startsWith(docsDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const mime =
      ext === ".js"
        ? "application/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : "text/html; charset=utf-8";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(filePath).pipe(res);
  });
  return { server };
}

async function run() {
  const srv = startTestServer();
  await new Promise((resolve) => srv.server.listen(0, "127.0.0.1", resolve));
  const port = srv.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const passUrl = `${origin}/pass.html?api=${encodeURIComponent(`${origin}/api`)}`;

  let browser;
  try {
    const sysChrome =
      "C:\\Program Files\\Google\\Chrome\\Application\\Chrome.exe";
    const launchOpts =
      !process.env.CI && fs.existsSync(sysChrome)
        ? { headless: true, executablePath: sysChrome }
        : { headless: true };
    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();

    const problems = [];
    page.on("pageerror", (err) => problems.push("pageerror: " + err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push("console: " + msg.text());
    });

    // 1. Loads under strict CSP (script-src 'self') with zero errors
    await page.goto(passUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("#lookupCard", { state: "visible" });
    assert.deepStrictEqual(problems, [], "Load errors: " + problems.join(" | "));

    const csp = await page.getAttribute(
      'meta[http-equiv="Content-Security-Policy"]',
      "content",
    );
    assert.ok(!/unsafe-inline/.test(csp), "CSP must not allow unsafe-inline anywhere");

    // 2. Wrong PIN -> clean error state, button re-enabled
    await page.fill("#studentIdInput", "202310001");
    await page.fill("#emailInput", "juan@cvsu.edu.ph");
    await page.fill("#pinInput", "0000");
    await page.click("#submitBtn");
    await page.waitForFunction(() =>
      document.getElementById("errorText").textContent.includes("No matching"),
    );
    assert.strictEqual(await page.isDisabled("#submitBtn"), false);

    // 3. Correct credentials -> pass card; storage has no raw payload and has savedAt
    await page.fill("#pinInput", "4829");
    await page.click("#submitBtn");
    await page.waitForSelector("#passCard", { state: "visible" });
    assert.strictEqual(await page.textContent("#studentName"), "Juan Dela Cruz");
    assert.strictEqual(await page.textContent("#eventBadge"), "CSSO-2026");

    const stored = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) =>
        x.startsWith("csso_saved_pass_v1"),
      );
      return k ? JSON.parse(localStorage.getItem(k)) : null;
    });
    assert.ok(stored, "pass not persisted");
    assert.strictEqual(stored.payload, undefined, "raw payload must not persist");
    assert.ok(Number(stored.savedAt) > 0, "savedAt TTL stamp missing");

    // 4. Reload restores saved pass
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#passCard", { state: "visible" });

    // 5. Expired (>7 days) saved pass is purged on load
    await page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) =>
        x.startsWith("csso_saved_pass_v1"),
      );
      const v = JSON.parse(localStorage.getItem(k));
      v.savedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
      localStorage.setItem(k, JSON.stringify(v));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#lookupCard", { state: "visible" });
    assert.strictEqual(await page.isVisible("#passCard"), false);

    // 6. Re-fetch then explicit clear
    await page.fill("#studentIdInput", "202310001");
    await page.fill("#emailInput", "juan@cvsu.edu.ph");
    await page.fill("#pinInput", "4829");
    await page.click("#submitBtn");
    await page.waitForSelector("#passCard", { state: "visible" });
    await page.click(".reset-link");
    await page.waitForSelector("#lookupCard", { state: "visible" });
    const left = await page.evaluate(
      () =>
        Object.keys(localStorage).filter((x) => x.startsWith("csso_saved_pass_v1"))
          .length,
    );
    assert.strictEqual(left, 0);

    // 7. Untrusted ?api= is ignored with a visible warning
    await page.goto(`${origin}/pass.html?api=${encodeURIComponent("https://evil.example/exec")}`, {
      waitUntil: "networkidle",
    });
    assert.ok(
      (await page.textContent("#errorText")).includes("Ignored untrusted"),
    );

    assert.deepStrictEqual(problems, [], "Runtime errors: " + problems.join(" | "));
    console.log("PASS: tests/browser/pass.spec.js");
  } finally {
    if (browser) await browser.close();
    srv.server.close();
  }
}

run().catch((err) => {
  console.error("BROWSER TEST FAILED:", err);
  process.exit(1);
});

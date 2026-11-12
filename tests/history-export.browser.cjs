// Run with Playwright available in NODE_PATH. Uses an isolated browser and temporary localhost origin.
const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const root = path.resolve(__dirname, "..");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file = path.join(root, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const content = await fs.readFile(file);
      res.setHeader("Content-Type", ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html",
        ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" })[path.extname(file)] || "application/octet-stream");
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin + "/#/settings");
    await page.locator("#history-export-count").waitFor();
    assert.equal(await page.locator('[data-action="export-history"]').isDisabled(), true);
    await page.evaluate(async () => {
      const { putOne } = await import("./js/db.js");
      for (const date of ["2026-09-01", "2026-11-12"]) {
        await putOne("workouts", { id: date, date, intensity: "light", completedAt: `${date}T10:00:00Z`,
          items: [{ exerciseId: "plank", name: "プランク", type: "time", muscleGroup: "core", equipment: ["mat"], restSeconds: 30,
            sets: [{ completed: true, durationSeconds: 25 }, { completed: false, durationSeconds: 30 }] }] });
      }
    });
    await page.reload();
    await page.locator("#history-export-count").waitFor();
    assert.match(await page.locator("#history-export-count").textContent(), /2回.*2種目.*2セット/);
    await page.locator('[data-history-export="period"]').selectOption("custom");
    await page.locator('[data-history-export="start"]').fill("2026-11-12");
    await page.locator('[data-history-export="end"]').fill("2026-11-11");
    await page.locator('[data-history-export="end"]').blur();
    assert.equal(await page.locator('[data-action="export-history"]').isDisabled(), true);
    await page.locator('[data-history-export="end"]').fill("2026-11-12");
    await page.locator('[data-history-export="end"]').blur();
    assert.match(await page.locator("#history-export-count").textContent(), /1回.*1種目.*1セット/);
    const download = async (action) => {
      const pending = page.waitForEvent("download");
      await page.locator(`[data-action="${action}"]`).click();
      const result = await pending;
      return { name: result.suggestedFilename(), bytes: await fs.readFile(await result.path()) };
    };
    const csv = await download("export-history");
    assert.equal(csv.name, "workout-history_2026-11-12_to_2026-11-12.csv");
    assert.deepEqual([...csv.bytes.subarray(0, 3)], [239, 187, 191]);
    assert.match(csv.bytes.toString("utf8"), /プランク/);
    await page.locator('[data-history-export="format"]').selectOption("json");
    const records = JSON.parse((await download("export-history")).bytes);
    assert.equal(records.records.length, 1);
    const backup = JSON.parse((await download("export-data")).bytes);
    assert.equal(backup.data.workouts.length, 2);
    // Record-only JSON must never be accepted as a full-data restore.
    await page.locator("#import-file").setInputFiles({ name: "records.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(records)) });
    await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("対応していない"));
    assert.equal(await page.evaluate(async () => (await (await import("./js/db.js")).getAll("workouts")).length), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await page.locator("#history-export-count").waitFor();
    assert.match(await page.locator("#history-export-count").textContent(), /2回/);
    assert.deepEqual(errors, []);
    console.log("PASS: 390px UI, period validation/counts, CSV/JSON downloads, full backup, record-import rejection, IndexedDB preservation, offline reload");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

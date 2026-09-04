import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test as nodeTest } from "node:test";
import { chromium } from "playwright";

const baseUrl = process.env.PREVIEW_URL ?? "http://localhost:8087";
const email = process.env.PREVIEW_TEST_EMAIL;
const password = process.env.PREVIEW_TEST_PASSWORD;
const browserExecutable = [
  process.env.PREVIEW_BROWSER_PATH,
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((candidate) => candidate && existsSync(candidate))[0];
const runId = Date.now().toString();
const potentialMpns = [`UNIFIED-POTENTIAL-A-${runId}`, `UNIFIED-POTENTIAL-B-${runId}`];

const test = email && password && browserExecutable ? nodeTest : nodeTest.skip;

test("潜力型号批量导入统一进入智能导入并拆分截图入口", async () => {
  const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForTimeout(3_000);
    assert.equal(["/", "/users"].includes(new URL(page.url()).pathname), true);

    await page.goto(`${baseUrl}/watchlist`, { waitUntil: "domcontentloaded" });
    const importLink = page.getByRole("link", { name: "批量加入", exact: true });
    assert.equal(await importLink.getAttribute("href"), "/import?kind=potential");
    await importLink.click();
    await page.waitForTimeout(1_000);
    assert.equal(new URL(page.url()).pathname, "/import");
    assert.equal(new URL(page.url()).searchParams.get("kind"), "potential");

    const kindSelect = page.locator("select").first();
    await page.waitForFunction(() => document.querySelector("select")?.value === "potential", { timeout: 10_000 });
    assert.equal(await kindSelect.inputValue(), "potential");
    await assertVisible(page, "拍照");
    await assertVisible(page, "相册");
    await assertVisible(page, "粘贴截图");
    assert.equal(await page.getByRole("button", { name: "相册/截图", exact: true }).count(), 0);

    for (const viewport of [
      { width: 1440, height: 900, name: "potential-import-desktop" },
      { width: 390, height: 844, name: "potential-import-mobile-390" },
      { width: 360, height: 800, name: "potential-import-mobile-360" },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${viewport.name} 横向溢出`);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await page.locator("textarea").fill(`${potentialMpns[0]} 1K\n${potentialMpns[1]} 2K`);
    await page.getByRole("button", { name: "识别预览", exact: true }).click();
    await page.getByText("预览 2 行", { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    const previewSection = page.locator("section").filter({ hasText: "预览 2 行" }).last();
    assert.equal(await previewSection.getByText("潜力型号", { exact: true }).count() >= 2, true);
    assert.equal(await previewSection.getByText("推货", { exact: true }).count(), 0);
    await assertVisible(page, "确认写入 2 行");
    await page.getByRole("button", { name: "确认写入 2 行", exact: true }).click();
    await page.getByText("已加入 2 个潜力型号", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const potentialBatch = page.locator("li").filter({ hasText: "潜力型号" }).first();
    await potentialBatch.getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByText("批次已撤销", { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
  } finally {
    assert.deepEqual(errors, []);
    await browser.close();
  }
});

async function assertVisible(page, name) {
  await page.getByRole("button", { name, exact: true }).waitFor({ state: "visible", timeout: 5_000 });
}

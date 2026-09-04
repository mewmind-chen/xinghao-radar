import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const baseUrl = process.env.PREVIEW_URL ?? "http://localhost:8087";
const email = process.env.PREVIEW_TEST_EMAIL;
const password = process.env.PREVIEW_TEST_PASSWORD;
const evidenceDir = process.env.PREVIEW_EVIDENCE_DIR ?? "C:\\Users\\13537\\AppData\\Local\\xinghao-radar\\preview-import-workbench-ux-8087-evidence";
const browserExecutable = [
  process.env.PREVIEW_BROWSER_PATH,
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((candidate) => candidate && existsSync(candidate))[0];
const runId = Date.now().toString();

assert.ok(browserExecutable, "找不到可用浏览器");
assert.ok(email && password, "请通过 PREVIEW_TEST_EMAIL/PREVIEW_TEST_PASSWORD 提供本地预览凭据");
mkdirSync(evidenceDir, { recursive: true });

const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.route("**/*", async (route) => {
  if (/\.(woff2?|ttf|otf)(?:\?|$)/i.test(route.request().url())) {
    await route.abort();
    return;
  }
  await route.continue();
});

async function saveScreenshot(name) {
  console.log(`CAPTURE_START=${name}`);
  const data = await page.screenshot({
    path: `${evidenceDir}\\${name}.png`,
    fullPage: false,
    animations: "disabled",
    timeout: 5_000,
  });
  if (!data.length) throw new Error(`截图为空: ${name}`);
  console.log(`CAPTURE_DONE=${name}`);
}

async function waitForPage() {
  await page.waitForTimeout(1_200);
  await page.waitForFunction(() => document.fonts?.status !== "loading", { timeout: 10_000 }).catch(() => undefined);
}

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForTimeout(3_000);
  assert.equal(["/", "/users"].includes(new URL(page.url()).pathname), true);

  await page.goto(`${baseUrl}/watchlist`, { waitUntil: "domcontentloaded" });
  await waitForPage();
  await saveScreenshot("potential-watchlist-desktop");

  await page.getByRole("link", { name: "批量加入", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("select")?.value === "potential", { timeout: 10_000 });
  await waitForPage();
  await saveScreenshot("potential-import-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await waitForPage();
  await saveScreenshot("potential-import-mobile-390");

  await page.setViewportSize({ width: 360, height: 800 });
  await waitForPage();
  await saveScreenshot("potential-import-mobile-360");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("textarea").fill(`UNIFIED-POTENTIAL-A-${runId} 1K\nUNIFIED-POTENTIAL-B-${runId} 2K`);
  await page.getByRole("button", { name: "识别预览", exact: true }).click();
  await page.getByText("预览 2 行", { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
  await waitForPage();
  await saveScreenshot("potential-import-preview");
  await page.locator("section").filter({ hasText: "预览 2 行" }).last().scrollIntoViewIfNeeded();
  await waitForPage();
  await saveScreenshot("potential-import-preview-rows");
} finally {
  await browser.close();
}

console.log(`EVIDENCE_DIR=${evidenceDir}`);

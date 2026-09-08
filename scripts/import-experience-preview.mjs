import { chromium } from "playwright";
import fs from "node:fs/promises";

const baseUrl = process.env.PREVIEW_URL || "http://localhost:8080";
const evidenceDir =
  process.env.EVIDENCE_DIR ||
  "C:/Users/13537/AppData/Local/xinghao-radar/evidence/import-experience-8080";
const email = process.env.PREVIEW_EMAIL;
const password = process.env.PREVIEW_PASSWORD;
if (!email || !password) {
  throw new Error("请通过 PREVIEW_EMAIL 和 PREVIEW_PASSWORD 提供本地预览账号");
}
await fs.mkdir(evidenceDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("requestfailed", (request) =>
  failedRequests.push(
    `${request.method()} ${request.url()} · ${request.failure()?.errorText || "failed"}`,
  ),
);

async function screenshot(name) {
  await page.screenshot({ path: `${evidenceDir}/${name}.png`, fullPage: false });
}

async function login() {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("input[type=email]").fill(email);
  await page.locator("input[type=password]").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page
    .waitForURL((url) => !new URL(url).pathname.endsWith("/login"), { timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  if (new URL(page.url()).pathname.endsWith("/login")) {
    throw new Error(`本地预览登录失败：${(await page.locator("body").innerText()).slice(0, 500)}`);
  }
}

async function go(path) {
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
}

await login();
await go("/import");
await screenshot("desktop-import-empty");
await page.getByRole("button", { name: "填入示例" }).click();
await page.getByRole("button", { name: "识别预览" }).click();
await page.getByText(/预览 \d+ 行/).waitFor({ timeout: 20000 });
await screenshot("desktop-import-preview");
await page.locator("table tbody tr").first().scrollIntoViewIfNeeded();
await screenshot("desktop-import-preview-rows");
const headers = await page.locator("table thead th").allTextContents();
const hasBrandField = headers.some((header) => header.includes("品牌"));
const hasAlignedTable =
  headers.length === 11 &&
  headers.join("|").includes("业务类型") &&
  headers.join("|").includes("价格 / 成本");

await page.locator("textarea").fill("TDA21472 / TDA21472AUMA1\nTI");
await page.getByRole("button", { name: "识别预览" }).click();
await page.locator("table tbody tr").first().waitFor({ timeout: 20000 });
const compositeEvidence = await page.getByText(/多个候选|需核对/).count();
const compositeCheckboxDisabled = await page
  .locator("table tbody tr")
  .first()
  .getByRole("checkbox")
  .isDisabled();
const compositeConfirmDisabled = await page
  .getByRole("button", { name: /确认写入/ })
  .first()
  .isDisabled();
await screenshot("composite-mpn-review");

await page.setViewportSize({ width: 390, height: 844 });
await go("/import");
await page.getByRole("button", { name: "填入示例" }).click();
await page.getByRole("button", { name: "识别预览" }).click();
await page.getByText(/预览 \d+ 行/).waitFor({ timeout: 20000 });
await screenshot("mobile-390-import-preview");
await page.locator("article").first().scrollIntoViewIfNeeded();
await screenshot("mobile-390-import-preview-rows");
const mobile390Overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
);

await page.setViewportSize({ width: 360, height: 800 });
await go("/import");
await page.getByRole("button", { name: "填入示例" }).click();
await page.getByRole("button", { name: "识别预览" }).click();
await page.getByText(/预览 \d+ 行/).waitFor({ timeout: 20000 });
await screenshot("mobile-360-import-preview");
await page.locator("article").first().scrollIntoViewIfNeeded();
await screenshot("mobile-360-import-preview-rows");
const mobile360Overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
);

await page.setViewportSize({ width: 1440, height: 900 });
await go("/channels");
await screenshot("desktop-channels");
await page.setViewportSize({ width: 390, height: 844 });
await go("/channels");
await screenshot("mobile-390-channels");
const mobileChannelsOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
);

const result = {
  url: baseUrl,
  loggedInPath: (await page.url()).replace(baseUrl, ""),
  tableHeaders: headers,
  hasBrandField,
  hasAlignedTable,
  compositeEvidence,
  compositeCheckboxDisabled,
  compositeConfirmDisabled,
  mobile390Overflow,
  mobile360Overflow,
  mobileChannelsOverflow,
  consoleErrors,
  pageErrors,
  failedRequests,
  screenshots: (await fs.readdir(evidenceDir)).filter((name) => name.endsWith(".png")),
};
if (!compositeEvidence || !compositeCheckboxDisabled || !compositeConfirmDisabled) {
  throw new Error(
    `组合型号行为校验失败：${JSON.stringify({ compositeEvidence, compositeCheckboxDisabled, compositeConfirmDisabled })}`,
  );
}
await fs.writeFile(`${evidenceDir}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
await browser.close();

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.PREVIEW_URL || "http://127.0.0.1:8083";
const email = process.env.PREVIEW_EMAIL;
const password = process.env.PREVIEW_PASSWORD;
const evidenceDir =
  process.env.EVIDENCE_DIR ||
  "C:/Users/13537/AppData/Local/xinghao-radar/evidence/import-target-first-8083";
await mkdir(evidenceDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const runId = Date.now().toString().slice(-6);
const firstCustomer = `甲方公司${runId}`;
const secondCustomer = `乙方公司${runId}`;
const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  if (email && password) {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.locator("input[type=email]").fill(email);
    await page.locator("input[type=password]").fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForURL((url) => !new URL(url).pathname.endsWith("/login"), {
      timeout: 20_000,
    });
  }
  await page.goto(`${baseUrl}/import`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "智能导入" }).waitFor();
  assert.equal(await page.locator("textarea").count(), 0, "选择类型前不应出现来源输入");
  for (const label of ["渠道推货", "客户询价", "入库", "在途", "潜力型号"]) {
    await page.getByRole("button", { name: label, exact: true }).waitFor();
  }

  await page.getByRole("button", { name: "客户询价", exact: true }).click();
  const source = page.locator("textarea");
  await source.fill(
    `客户：${firstCustomer} TPS7A4700RGWR 20K TP 1.08 USD\n客户：${secondCustomer} STM32F103C8T6 10K TP 1.05 USD`,
  );
  await page.getByRole("button", { name: "识别预览", exact: true }).click();
  await page.getByText(/询价预览 · 共 \d+ 条/).waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll('input[aria-label$="客户"]')).some(
        (input) => input.value === expected,
      ),
    firstCustomer,
    { timeout: 20_000 },
  );

  const inquiryHeaders = (await page.locator("table thead th").allTextContents()).map((item) =>
    item.trim(),
  );
  assert(inquiryHeaders.includes("客户"));
  assert(inquiryHeaders.includes("数量"));
  assert(inquiryHeaders.includes("TP（接受价）"));
  assert.equal(inquiryHeaders.includes("DC"), false);
  assert.equal(inquiryHeaders.includes("仓库"), false);
  assert.equal(
    inquiryHeaders.some((item) => item.includes("成本")),
    false,
  );
  assert.equal(
    await page.locator("table tbody input[type=checkbox]:checked").count(),
    0,
    "新预览不能替用户自动确认",
  );
  const inquiryRows = page.locator("table tbody tr");
  const customerValues = await inquiryRows
    .locator('input[aria-label$="客户"]')
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  const priceValues = await inquiryRows
    .locator('input[aria-label*="TP（接受价）"]')
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.deepEqual(customerValues, [firstCustomer, secondCustomer]);
  assert.deepEqual(priceValues, ["1.08", "1.05"]);
  await page.screenshot({ path: `${evidenceDir}/desktop-inquiry.png`, fullPage: false });

  await page.getByRole("button", { name: "入库", exact: true }).click();
  assert.equal(await page.getByText(/询价预览 · 共 \d+ 条/).count(), 0, "换类型后旧预览必须失效");
  assert.match(await source.inputValue(), /TPS7A4700RGWR/, "换类型后应保留原始来源供重新识别");
  await page.getByRole("button", { name: "识别预览", exact: true }).click();
  await page.getByText(/入库预览 · 共 \d+ 条/).waitFor({ timeout: 20_000 });
  const stockHeaders = (await page.locator("table thead th").allTextContents()).map((item) =>
    item.trim(),
  );
  assert(stockHeaders.includes("仓库"));
  assert(stockHeaders.includes("成本"));
  assert.equal(stockHeaders.includes("客户"), false);
  assert.equal(stockHeaders.includes("TP（接受价）"), false);

  await page.getByRole("button", { name: "渠道推货", exact: true }).click();
  await source.fill("渠道：现货商 TPS7A4700RGWR 20K 2615 1.20 USD");
  await page.getByRole("button", { name: "识别预览", exact: true }).click();
  await page.getByText(/推货预览 · 共 \d+ 条/).waitFor({ timeout: 20_000 });
  const offerHeaders = (await page.locator("table thead th").allTextContents()).map((item) =>
    item.trim(),
  );
  assert(offerHeaders.includes("渠道"));
  assert(offerHeaders.includes("报价"));
  assert.equal(offerHeaders.includes("客户"), false);
  assert.equal(offerHeaders.includes("仓库"), false);
  assert.equal(offerHeaders.includes("成本"), false);

  await page.getByRole("button", { name: "在途", exact: true }).click();
  await source.fill("供应商甲 TPS7A4700RGWR 20K 2615 9/30 HK");
  await page.getByRole("button", { name: "识别预览", exact: true }).click();
  await page.getByText(/在途预览 · 共 \d+ 条/).waitFor({ timeout: 20_000 });
  const transitHeaders = (await page.locator("table thead th").allTextContents()).map((item) =>
    item.trim(),
  );
  assert(transitHeaders.includes("供应商 / 来源"));
  assert(transitHeaders.includes("仓库"));
  assert(transitHeaders.includes("预计到货"));
  assert.equal(transitHeaders.includes("客户"), false);
  assert.equal(transitHeaders.includes("报价"), false);
  assert.equal(transitHeaders.includes("成本"), false);

  await page.getByRole("button", { name: "潜力型号", exact: true }).click();
  await source.fill("TPS7A4700RGWR");
  await page.getByRole("button", { name: "识别预览", exact: true }).click();
  await page.getByText(/潜力型号预览 · 共 \d+ 条/).waitFor({ timeout: 20_000 });
  const potentialHeaders = (await page.locator("table thead th").allTextContents()).map((item) =>
    item.trim(),
  );
  assert.deepEqual(potentialHeaders, ["", "型号", "品牌", "状态"]);

  const overflows = {};
  for (const viewport of [
    { name: "390x844", width: 390, height: 844 },
    { name: "360x800", width: 360, height: 800 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/import`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "客户询价", exact: true }).click();
    await page.locator("textarea").fill(`客户：${firstCustomer} TPS7A4700RGWR 20K TP 1.08 USD`);
    await page.getByRole("button", { name: "识别预览", exact: true }).click();
    await page.getByText(/询价预览 · 共 \d+ 条/).waitFor({ timeout: 20_000 });
    overflows[viewport.name] = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    await page.screenshot({
      path: `${evidenceDir}/mobile-${viewport.name}.png`,
      fullPage: false,
    });
  }
  assert.deepEqual(overflows, { "390x844": false, "360x800": false });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

  const result = {
    baseUrl,
    inquiryHeaders,
    customerValues,
    priceValues,
    stockHeaders,
    offerHeaders,
    transitHeaders,
    potentialHeaders,
    overflows,
    consoleErrors,
    pageErrors,
  };
  await writeFile(`${evidenceDir}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidenceDir}/failure.png`, fullPage: false });
  console.error(
    JSON.stringify(
      {
        textarea: await page
          .locator("textarea")
          .inputValue()
          .catch(() => null),
        customers: await page
          .locator('input[aria-label$="客户"]')
          .evaluateAll((inputs) => inputs.map((input) => input.value))
          .catch(() => []),
        body: (await page.locator("body").innerText()).slice(0, 2000),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}

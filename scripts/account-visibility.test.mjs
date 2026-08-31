import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test as nodeTest } from "node:test";
import { chromium } from "playwright";

const baseUrl = process.env.PREVIEW_URL ?? "http://localhost:8086";
const email = process.env.PREVIEW_TEST_EMAIL ?? "owner.preview@local.test";
const password = process.env.PREVIEW_TEST_PASSWORD;
const browserExecutable = [
  process.env.PREVIEW_BROWSER_PATH,
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((candidate) => candidate && existsSync(candidate))[0];
const test = password && browserExecutable ? nodeTest : nodeTest.skip;

const forbiddenIdentityText = [
  "本地预览老板",
  "owner.preview@local.test",
  "老板",
  "老板权限组",
];
const longName = "本地验收这是一个非常长的被检查人姓名用于省略号验收";
const longEmail = "longname.preview@local.test";
const longPassword = "Pview-Long-260901!";

async function waitForBossUsersPage(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/users`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "用户与权限", exact: true }).waitFor({ state: "visible" });
}

async function assertNoHorizontalOverflow(page, viewport) {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(layout.scrollWidth, layout.clientWidth, `${viewport.width}px has horizontal overflow`);
}

async function assertIconOnlyAccount(page, viewport) {
  const headerText = (await page.locator("header").allTextContents()).join("");
  for (const text of forbiddenIdentityText) {
    assert.equal(headerText.includes(text), false, `${viewport.width}px header leaked: ${text}`);
  }

  const trigger = page.locator('button[aria-label="账户菜单"]');
  assert.equal(await trigger.count(), 1);
  assert.equal((await trigger.textContent()).trim(), "");
  assert.equal(await page.locator("[aria-label^='账户：']").count(), 0);
  assert.equal(await page.locator('[data-testid="identity-check-pill"]').count(), 0);
  if (viewport.width < 768) {
    assert.equal(await page.getByRole("button", { name: "检查权限", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "退出检查", exact: true }).count(), 0);
  }

  await trigger.click();
  const menu = page.locator('[role="menu"]');
  assert.equal(await menu.count(), 1);
  assert.deepEqual(
    (await menu.locator('[role="menuitem"]').allTextContents()).map((text) => text.trim()),
    ["修改密码", "退出登录"],
  );
  const menuText = await menu.innerText();
  for (const text of forbiddenIdentityText) {
    assert.equal(menuText.includes(text), false, `${viewport.width}px menu leaked: ${text}`);
  }
  await page.keyboard.press("Escape");
  await assertNoHorizontalOverflow(page, viewport);
}

async function ensureLongNameUser(page) {
  if (await page.getByText(longName, { exact: true }).count() > 0) return;
  await page.getByRole("button", { name: "新建用户", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("姓名", { exact: true }).fill(longName);
  await dialog.getByLabel("登录账号", { exact: true }).fill(longEmail);
  await dialog.getByLabel("密码", { exact: true }).fill(longPassword);
  await dialog.getByLabel("确认密码", { exact: true }).fill(longPassword);
  await dialog.getByRole("button", { name: "创建用户", exact: true }).click();
  await page.getByText(longName, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
}

async function startCheck(page, targetName) {
  const row = page.locator("tr").filter({ hasText: targetName });
  await row.getByRole("button", { name: "检查权限", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
  const pill = page.getByTestId("identity-check-pill");
  await pill.waitFor({ state: "visible", timeout: 10_000 });
  return pill;
}

test("account identity is icon-only, desktop checks use one compact pill, and mobile fails closed", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/" || url.pathname === "/users", { timeout: 10_000 });

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
      { width: 360, height: 800 },
    ]) {
      await waitForBossUsersPage(page, viewport);
      await assertIconOnlyAccount(page, viewport);
    }

    await waitForBossUsersPage(page, { width: 1024, height: 768 });
    const managerPill = await startCheck(page, "本地验收主管");
    const managerPillText = await managerPill.innerText();
    assert.equal(managerPillText.replace(/\s+/g, "").includes("检查中·本地验收主管"), true);
    assert.equal(managerPillText.includes("退出"), true);
    assert.equal(await page.getByText("正在检查：本地验收主管", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "退出检查", exact: true }).count(), 0);
    const pillBox = await managerPill.boundingBox();
    assert.ok(pillBox && pillBox.height >= 32 && pillBox.height <= 36, "identity pill height must stay compact");

    for (const path of ["/", "/parts", "/stock", "/channels", "/inquiries", "/watchlist", "/import", "/settings", "/users"]) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
      await page.getByTestId("identity-check-pill").waitFor({ state: "visible", timeout: 10_000 });
    }

    await page.goto(`${baseUrl}/users`, { waitUntil: "networkidle" });
    await page.getByTestId("identity-check-pill").getByRole("button", { name: "退出", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/users", { timeout: 10_000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="identity-check-pill"]'), undefined, { timeout: 10_000 });
    await page.getByRole("button", { name: "新建用户", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    await waitForBossUsersPage(page, { width: 1440, height: 900 });
    await ensureLongNameUser(page);
    const longPill = await startCheck(page, longName);
    const longNameNode = longPill.locator(`span[title="${longName}"]`);
    assert.equal(await longNameNode.count(), 1);
    const longNameLayout = await longNameNode.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      whiteSpace: getComputedStyle(node).whiteSpace,
      textOverflow: getComputedStyle(node).textOverflow,
    }));
    assert.equal(longNameLayout.whiteSpace, "nowrap");
    assert.equal(longNameLayout.textOverflow, "ellipsis");
    assert.ok(longNameLayout.scrollWidth > longNameLayout.clientWidth, "long identity name should be truncated");

    await longPill.getByRole("button", { name: "退出", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/users", { timeout: 10_000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="identity-check-pill"]'), undefined, { timeout: 10_000 });

    await waitForBossUsersPage(page, { width: 1024, height: 768 });
    await startCheck(page, "本地验收主管");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/users`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "用户与权限", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    const mobileBodyText = await page.locator("body").innerText();
    assert.equal(mobileBodyText.includes("检查中"), false);
    assert.equal(mobileBodyText.includes("退出检查"), false);
    assert.equal(mobileBodyText.includes("本地验收主管"), true, "user list may show names, but top identity state must not");
    assert.equal(await page.locator('[data-testid="identity-check-pill"]').count(), 0);
    assert.equal(await page.getByRole("button", { name: "新建用户", exact: true }).count(), 1, "mobile must regain boss permissions before business UI");
    await assertIconOnlyAccount(page, { width: 390, height: 844 });

    await waitForBossUsersPage(page, { width: 360, height: 800 });
    assert.equal(await page.locator('[data-testid="identity-check-pill"]').count(), 0);
    assert.equal(await page.getByRole("button", { name: "新建用户", exact: true }).count(), 1);
    await assertIconOnlyAccount(page, { width: 360, height: 800 });

    assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(" | ")}`);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  } finally {
    await browser.close();
  }
});

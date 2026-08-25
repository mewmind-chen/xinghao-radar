import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const radarUrl = (process.env.RADAR_URL || "http://127.0.0.1:8082").replace(/\/$/, "");
const textWaitMs = Number(process.env.TEXT_WAIT_MS || 25_000);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-sandbox"],
});

async function runText() {
  const page = await browser.newPage();
  await page.goto(`${radarUrl}/import`, { waitUntil: "networkidle" });
  await page.locator("textarea").fill(
    "客户今天问两个料：TPS54560DDAR 1000pcs，比较急，STM32F103C8T6 500pcs。都是要现货，前一个最好 24+，后一个批次没有特别要求。",
  );
  await page.getByRole("button", { name: /识别预览/ }).click();
  await page.waitForTimeout(textWaitMs);
  const body = await page.locator("body").innerText();
  const result = { case: "Narrative Text", preview: /预览 \d+ 行/.test(body), platformLabel: body.includes("AI 识别（Platform）"), bodyTail: body.slice(-1200) };
  await page.screenshot({ path: join(here, "production-text-preview.png"), fullPage: true });
  await page.close();
  return result;
}

async function runFile(name, index, label) {
  const page = await browser.newPage();
  await page.goto(`${radarUrl}/import`, { waitUntil: "networkidle" });
  await page.locator("input[type=file]").nth(index).setInputFiles(join(here, name));
  await page.waitForTimeout(35_000);
  const body = await page.locator("body").innerText();
  const result = { case: label, preview: /预览 \d+ 行/.test(body), platformLabel: body.includes("AI 识别（Platform）"), bodyTail: body.slice(-1200) };
  await page.screenshot({ path: join(here, `production-${label.toLowerCase().replaceAll(" ", "-")}-preview.png`), fullPage: true });
  await page.close();
  return result;
}

const results = process.env.ONLY_TEXT === "1"
  ? [await runText()]
  : [
      await runText(),
      await runFile("unknown-en.xlsx", 0, "Unknown Excel EN"),
      await runFile("unknown-en.csv", 0, "CSV Unknown"),
      await runFile("unknown-image.png", 1, "Image"),
    ];
console.log(JSON.stringify({ radarUrl, results }, null, 2));
await browser.close();

import { chromium } from "playwright";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const radarUrl = (process.env.RADAR_URL || "https://radar.newmindchen.com").replace(/\/$/, "");
const waitMs = Number(process.env.SMOKE_WAIT_MS || 160_000);
const narrativeRuns = Number(process.env.NARRATIVE_RUNS || 5);
const narrative =
  "客户今天问两个料：TPS54560DDAR 1000pcs，比较急，STM32F103C8T6 500pcs。都是要现货，前一个最好 24+，后一个批次没有特别要求。";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-sandbox"],
});

async function waitForOutcome(page) {
  await page.waitForFunction(
    () => {
      const body = document.body.innerText;
      return /预览 \d+ 行|智能抽取暂不可用|Platform 暂不可用|没有识别到型号/.test(body);
    },
    undefined,
    { timeout: waitMs },
  );
}

function summarize(caseName, run, startedAt, body, error = null) {
  const preview = body.match(/预览 (\d+) 行/);
  const platform = body.includes("AI 识别（Platform）");
  const localFallback = body.includes("本地降级") || body.includes("本地视觉降级");
  return {
    case: caseName,
    ...(run == null ? {} : { run }),
    elapsedMs: Date.now() - startedAt,
    viaHarness: platform,
    route: platform ? "harness" : localFallback ? "local_fallback" : null,
    previewRows: preview ? Number(preview[1]) : 0,
    timeout: localFallback || Boolean(error),
    fallbackFrom: body.includes("本地文本降级") ? "platform_unavailable" : body.includes("本地视觉降级") ? "vision_unavailable" : null,
    error,
  };
}

async function runNarrative(run) {
  const page = await browser.newPage();
  const startedAt = Date.now();
  try {
    await page.goto(`${radarUrl}/import`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("textarea").fill(narrative);
    await page.getByRole("button", { name: /识别预览/ }).click();
    await waitForOutcome(page);
    return summarize("Narrative Text", run, startedAt, await page.locator("body").innerText());
  } catch (err) {
    return summarize("Narrative Text", run, startedAt, "", err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}

async function runFile(filename, inputIndex, caseName) {
  const page = await browser.newPage();
  const startedAt = Date.now();
  try {
    await page.goto(`${radarUrl}/import`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("input[type=file]").nth(inputIndex).setInputFiles(join(here, filename));
    await waitForOutcome(page);
    return summarize(caseName, null, startedAt, await page.locator("body").innerText());
  } catch (err) {
    return summarize(caseName, null, startedAt, "", err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}

const results = [];
for (let run = 1; run <= narrativeRuns; run += 1) results.push(await runNarrative(run));
results.push(await runFile("unknown-en.xlsx", 0, "Unknown Excel"));
results.push(await runFile("unknown-en.csv", 0, "Unknown CSV"));
results.push(await runFile("unknown-image.png", 1, "Image"));

console.log(JSON.stringify({ radarUrl, waitMs, narrativeRuns, results }, null, 2));
await browser.close();

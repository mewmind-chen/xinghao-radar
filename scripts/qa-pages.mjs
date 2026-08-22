import { chromium } from "playwright";
const pages = [
  ["/", "home"],
  ["/parts", "parts"],
  ["/parts/p_tps", "part-tps"],
  ["/stock", "stock"],
  ["/channels", "channels"],
  ["/inquiries", "inquiries"],
  ["/watchlist", "watchlist"],
  ["/import", "import"],
  ["/settings", "settings"],
];
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
for (const [path, name] of pages) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push(`${path} pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${path} console ${m.text()}`); });
  await page.goto("http://127.0.0.1:8080" + path, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `/workspace/screenshots/${name}-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/workspace/screenshots/${name}-mobile.png`, fullPage: true });
  await page.close();
}
await browser.close();
console.log(JSON.stringify(errors, null, 2));

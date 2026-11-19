import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, writeFileSync, statSync } from "node:fs";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4173/";
mkdirSync("out", { recursive: true });

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push({ text: msg.text(), location: msg.location()?.url });
});
page.on("pageerror", (err) => pageErrors.push(String(err)));
page.on("requestfailed", (req) => failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText}`));
page.on("response", (res) => {
  if (res.status() >= 400) failedRequests.push(`${res.request().method()} ${res.url()} -> ${res.status()}`);
});

const started = Date.now();
const response = await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 30000 });
const loadMs = Date.now() - started;
const title = await page.title();
const rootChildren = await page.locator("#root > *").count();

await page.screenshot({ path: "out/home.png", fullPage: true });
await page.screenshot({ path: "out/home-thumb.jpeg", type: "jpeg", quality: 30, scale: "css", clip: { x: 0, y: 0, width: 640, height: 400 } });

const axe = await new AxeBuilder({ page }).analyze();
const violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
writeFileSync("out/axe.json", JSON.stringify(axe.violations, null, 2));

await browser.close();

const summary = {
  url: BASE_URL,
  status: response?.status(),
  title,
  rootChildren,
  loadMs,
  consoleErrors,
  pageErrors,
  failedRequests,
  axe: { violations: violations.length, byImpact: violations.reduce((acc, v) => ({ ...acc, [v.impact]: (acc[v.impact] ?? 0) + 1 }), {}), list: violations, passes: axe.passes.length, incomplete: axe.incomplete.length },
  screenshotBytes: statSync("out/home.png").size,
  thumbBytes: statSync("out/home-thumb.jpeg").size,
};
writeFileSync("out/summary.json", JSON.stringify(summary, null, 2));
console.log("SMOKE_SUMMARY " + JSON.stringify(summary));

const smokeOk = response?.ok() && rootChildren > 0 && consoleErrors.length === 0 && pageErrors.length === 0;
console.log(`SMOKE_RESULT ${smokeOk ? "pass" : "fail"}`);
process.exit(smokeOk ? 0 : 1);

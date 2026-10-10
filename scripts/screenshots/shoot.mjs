// Retakes the screenshots in docs/imagens/. See README.md in this folder.
//
//   node shoot.mjs                      every shot in shots.json
//   node shoot.mjs painel-lead.png      only the named ones
//
// Runs on the host against the running stack, with the host's Google Chrome
// (CHROME_PATH to override). Logs in with the seeded, dev-only demo user.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../../docs/imagens");
const APP = process.env.APP_URL ?? "http://localhost:3100";
const LANGFUSE = process.env.LANGFUSE_URL ?? "http://localhost:3102";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Next's dev-mode badge is not part of the product.
const HIDE_DEV_BADGE = "nextjs-portal{display:none!important}";

const only = process.argv.slice(2);
const shots = JSON.parse(fs.readFileSync(path.join(here, "shots.json"), "utf8")).filter(
  (shot) => only.length === 0 || only.includes(shot.file),
);

function target(file) {
  const out = path.join(OUT, file);
  return file.endsWith(".jpg") ? { path: out, type: "jpeg", quality: 80 } : { path: out };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = { locale: "pt-BR", timezoneId: "America/Sao_Paulo" };

let panel = null;
async function panelPage() {
  if (panel !== null) return panel;
  const ctx = await browser.newContext({ ...context, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  panel = await ctx.newPage();
  await panel.goto(`${APP}/login`);
  await panel.fill('input[type="email"]', "carla@demo.com.br");
  await panel.fill('input[type="password"]', "demo1234");
  await Promise.all([panel.waitForURL(/\/leads/), panel.keyboard.press("Enter")]);
  return panel;
}

async function chat(shot) {
  const ctx = await browser.newContext({
    ...context,
    viewport: { width: shot.width ?? 430, height: shot.height ?? 1300 },
    deviceScaleFactor: 2,
  });
  // The widget restores a conversation from the session id in localStorage.
  await ctx.addInitScript(([key, value]) => localStorage.setItem(key, value), ["sdr.chat.session.demo", shot.session]);
  const page = await ctx.newPage();
  await page.goto(`${APP}/chat/demo`);
  await page.waitForTimeout(4000);
  // Images load after the widget's own scroll, so scroll again: to the end by default.
  await page.evaluate((top) => {
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY !== "visible") el.scrollTop = top;
    }
  }, shot.scrollTop ?? 1e7);
  await page.waitForTimeout(500);
  await page.addStyleTag({ content: HIDE_DEV_BADGE });
  await page.screenshot(target(shot.file));
  await ctx.close();
}

async function dashboard(shot) {
  const page = await panelPage();
  await page.goto(`${APP}${shot.url}`);
  await page.waitForTimeout(2500);
  if (shot.openFirstLead) {
    await page.locator('a[href*="lead="]').first().click();
    await page.waitForTimeout(2500);
  }
  await page.addStyleTag({ content: HIDE_DEV_BADGE });
  await page.screenshot(target(shot.file));
}

async function langfuse(shot) {
  const ctx = await browser.newContext({ ...context, viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  // The local Langfuse's init user, from docker-compose.yml.
  await page.goto(`${LANGFUSE}/auth/sign-in`);
  await page.fill('input[name="email"]', "dev@example.com");
  await page.fill('input[type="password"]', "langfuse-local-dev");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(5000);
  await page.goto(`${LANGFUSE}/project/sdr-imobiliario/traces`);
  await page.waitForTimeout(6000);
  await page.locator("table tbody tr", { hasText: shot.trace }).nth(shot.nth ?? 0).click();
  await page.waitForTimeout(6000);
  await page.screenshot(target(shot.file));
  await ctx.close();
}

for (const shot of shots) {
  if (shot.kind === "chat") await chat(shot);
  else if (shot.kind === "langfuse") await langfuse(shot);
  else await dashboard(shot);
  console.log("ok", shot.file);
}
await browser.close();

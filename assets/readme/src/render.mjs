// 重新生成 README 配图：node assets/readme/src/render.mjs（需要能 import 到 playwright）
// 真实界面直接截 portable/*.html；头图 / 流程 / 生态图由本目录 HTML 渲染。改文字改 HTML，别手 P 图。
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const src = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(src, '..');
const portable = path.resolve(src, '../../../portable');

const browser = await chromium.launch();
async function shot(file, name, width, height, scale = 1.5) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.goto(pathToFileURL(file).href);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, name) });
  await page.close();
}

// 1) 真实界面（先截：hero.html 引用 config-ui.png）
await shot(path.join(portable, 'Config.html'), 'config-ui.png', 680, 760);
await shot(path.join(portable, 'SkillHub.html'), 'skillhub-ui.png', 1280, 760);
// 2) HTML 渲染图
await shot(path.join(src, 'hero.html'), 'hero.png', 1280, 640);
await shot(path.join(src, 'how-it-works.html'), 'how-it-works.png', 1280, 400);
await shot(path.join(src, 'ecosystem.html'), 'ecosystem.png', 1280, 460);

await browser.close();
console.log('rendered to', out);

// icons/icon.svg から PNG を作る (Playwright と Chromium が必要)。使い方: node icons/make-icons.js icons
//  icon-192/512: 角を丸めた通常のアイコン (purpose any)
//  maskable-192/512: 全面の背景 + 絵を中央80%に縮小 (Android の丸・角丸の切り抜き用)
//  apple-touch-icon (180): iPhone 用 (iOS が自分で角を丸めるので四角のまま)
const { chromium } = require('playwright');
const fs = require('fs');
const dir = process.argv[2] || __dirname;
const svg = fs.readFileSync(dir + '/icon.svg', 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const bg = inner.match(/<rect width="512" height="512"[^>]*\/>/)[0];
const cut = inner.indexOf(bg) + bg.length;
const head = inner.slice(0, cut), art = inner.slice(cut);   // head = 色の定義と背景 / art = 手帳と家
const variants = {
  any: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><clipPath id="c"><rect width="512" height="512" rx="112"/></clipPath><g clip-path="url(#c)">${inner}</g></svg>`,
  maskable: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${head}<g transform="translate(256 256) scale(.78) translate(-256 -262)">${art}</g></svg>`,
  square: svg,
};
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage();
  const out = [['any', 192, 'icon-192.png'], ['any', 512, 'icon-512.png'], ['maskable', 192, 'maskable-192.png'], ['maskable', 512, 'maskable-512.png'], ['square', 180, 'apple-touch-icon.png']];
  for (const [v, size, name] of out) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${variants[v].replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: dir + '/' + name, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await b.close();
})();

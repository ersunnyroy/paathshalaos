import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
let overflow = [];

async function tour(label, { width, height }, scheme, email) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(`${label}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label}: ${e}`));

  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `/tmp/ui-${label}-login.png`, fullPage: true });
  if (email) await page.fill('#email', email);
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/tmp/ui-${label}-dashboard.png`, fullPage: true });

  for (const [href, heading] of [['/students','Learners'],['/attendance','Attendance'],['/fees','Fees']]) {
    await page.click(`a[href="${href}"]`);
    await page.waitForFunction((h) => document.querySelector('.page-head h1')?.textContent === h, heading, { timeout: 20000 });
    await page.waitForTimeout(1100);
    await page.screenshot({ path: `/tmp/ui-${label}-${heading.toLowerCase()}.png`, fullPage: true });
    // A horizontal page scrollbar on a phone is the classic responsive failure.
    const wide = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    if (wide) overflow.push(`${label}/${heading}`);
  }
  await ctx.close();
}

await tour('light', { width: 1280, height: 900 }, 'light');
await tour('dark', { width: 1280, height: 900 }, 'dark');
await tour('mobile', { width: 390, height: 844 }, 'light');
await tour('mobile-dark', { width: 360, height: 780 }, 'dark');
await tour('tablet', { width: 834, height: 1112 }, 'light');
await tour('teacher', { width: 1280, height: 900 }, 'light', 'teacher@demo.school');

console.log('horizontal overflow:', overflow.length ? overflow : 'none');
console.log('console errors:', errors.length ? errors : 'none');
await browser.close();

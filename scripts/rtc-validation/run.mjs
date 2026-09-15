import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('./browser.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', target: 'chrome110',
  define: { 'import.meta.env': '{}' },
});
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/browser.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(compiled.outputFiles[0].text);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><script type="module" src="/browser.js"></script>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    ...(process.env.VOXA_TEST_BROWSER ? { executablePath: process.env.VOXA_TEST_BROWSER } : {}),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection',
      '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(String(err)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.runRtcValidation === 'function');
  const result = await page.evaluate(() => window.runRtcValidation(2));
  const report = { browser: browser.version(), timestamp: new Date().toISOString(), errors, ...result };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/rtc.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: result.passed, failed: result.failed, errors,
    cases: result.cases.map(c => ({ scenario: c.scenario, ok: c.ok, failure: c.failure, errors: c.errors })) }, null, 2));
  process.exitCode = result.failed || errors.length ? 1 : 0;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const name = (await readdir('dist/assets')).find(name => /^pcmWorklet-.*\.js$/.test(name));
assert.ok(name, 'Build precisa conter o worklet independente');
const source = await readFile(`dist/assets/${name}`);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/worklet.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/worklet.js' ? source : '<!doctype html><title>Voxa PCM test</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? {executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'} : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('/worklet.js');
    const processor = new AudioWorkletNode(ctx, 'fila-pcm', {outputChannelCount:[2]});
    const gain = ctx.createGain(); gain.gain.value = 0;
    processor.connect(gain).connect(ctx.destination);
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Processor nao retornou quadros')), 6000);
      processor.onprocessorerror = () => {clearTimeout(timeout);reject(new Error('processorerror'));};
      processor.port.onmessage = ({data}) => { if(data.comSom > 0) {clearTimeout(timeout); resolve(data);} };
    });
    await ctx.resume();
    const block = new Float32Array(4800 * 2).fill(0.25);
    const timer = setInterval(() => processor.port.postMessage(block.buffer.slice(0)), 80);
    try { return await result; }
    finally { clearInterval(timer); processor.disconnect(); await ctx.close(); }
  });
  assert.ok(result.quadros >= 48000);
  assert.ok(result.comSom > 24000, 'PCM precisa atravessar o processador minificado');
  console.log(JSON.stringify({ worklet:name, ...result, status:'PASS' }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

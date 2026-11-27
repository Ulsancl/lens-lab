import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import { chromium } from 'playwright';
import { verifyWindowsRelease } from '../scripts/verify-windows-release.mjs';

const executable = path.resolve('release/windows/win-unpacked/Lens Lab.exe');
const { version } = JSON.parse(await readFile('package.json'));
const wire = await getCurrentFuseWire(executable);
const ON = 0x31, OFF = 0x30; // Fuse wire ASCII '1' and '0'.
for (const [option, value] of Object.entries({
  RunAsNode: OFF,
  EnableNodeOptionsEnvironmentVariable: OFF,
  EnableNodeCliInspectArguments: OFF,
  EnableEmbeddedAsarIntegrityValidation: ON,
  OnlyLoadAppFromAsar: ON,
})) assert.equal(wire[FuseV1Options[option]], value, option);

const installer = path.resolve(`release/windows/Lens-Lab-Setup-${version}.exe`);
await assert.rejects(verifyWindowsRelease([installer], '0'.repeat(40)), /expected publisher required/);

// Verify the actual fused app through Chromium, without a Node inspector.
const child = spawn(executable, ['--remote-debugging-port=0'], {
  env: { ...process.env, LENS_LAB_DATA_DIR: 'ignored-test-override' },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
const ended = once(child, 'exit');
let browser;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Packaged Chromium did not start: ' + stderr)), 30000);
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-4096);
      const endpoint = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
      if (endpoint) { clearTimeout(timer); resolve(endpoint); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Packaged app exited with ${code}: ${stderr}`)); });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const [context] = browser.contexts();
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15000 });
  await page.waitForURL('app://lens/');
  await page.locator('#scene canvas').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#app-version').textContent(), version);
  assert.deepEqual(await page.evaluate(() => ({
    bridge: window.lensDesktop.isDesktop,
    globals: [window.lensLab, window.render_game_to_text, window.advanceTime].map(value => typeof value),
  })), { bridge: true, globals: ['undefined', 'undefined', 'undefined'] });
  await page.locator('#screen-distance').fill('425');
  await page.locator('#apply-settings').click();
  assert.equal(await page.locator('[data-range="screenDistanceMm"]').inputValue(), '425');
  console.log('Production Windows app started with verified fuses, matching version and no test globals');
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await ended;
}

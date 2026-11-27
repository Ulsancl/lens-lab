const path = require('node:path');
const { spawn } = require('node:child_process');

function runWindowsPowerShell(script, input) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:\\/i.test(systemRoot)) throw new Error('Windows system directory unavailable');
  const windowsPowerShell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  const executable = path.win32.join(windowsPowerShell, 'powershell.exe');
  // Do not load per-user modules or inherit PowerShell 7's module paths.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = path.win32.join(windowsPowerShell, 'Modules');
  const command = Buffer.from(script, 'utf16le').toString('base64');
  const payload = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      cwd: systemRoot, env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString(); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Windows operation failed (${code})`));
    });
    child.stdin.end(payload);
  });
}

module.exports = { runWindowsPowerShell };

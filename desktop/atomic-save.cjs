const fs = require('node:fs/promises');
const path = require('node:path');
const { runWindowsPowerShell } = require('./windows-powershell.cjs');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const WINDOWS_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400]);
const transientCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);

// A complete sibling replaces the destination only after it has been flushed.
// Some Windows readers/scanners briefly prevent replacement; retry only that
// operation, with the destination checked again before every attempt.
async function atomicWriteProject(target, contents, {
  validateTarget,
  operations = fs,
  platform = process.platform,
  wait = delay,
} = {}) {
  if (typeof validateTarget !== 'function') throw new TypeError('A target validator is required');
  const previous = await validateTarget(target);
  if (platform === 'win32' && operations === fs) {
    const script = await fs.readFile(path.join(__dirname, 'windows-save.ps1'), 'utf8');
    return runWindowsPowerShell(script, { target, contents });
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let ownsTemporary = false;
  try {
    const handle = await operations.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try {
      await handle.writeFile(contents, 'utf8');
      if (previous && platform !== 'win32') {
        const own = await handle.stat();
        if (own.uid !== previous.uid || own.gid !== previous.gid) await handle.chown(previous.uid, previous.gid);
        await handle.chmod(previous.mode & 0o777);
      }
      await handle.sync();
    }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      const current = await validateTarget(target);
      if (previous && (!current || previous.dev !== current.dev || previous.ino !== current.ino
        || previous.mode !== current.mode || previous.uid !== current.uid || previous.gid !== current.gid)) {
        throw new Error('Project permissions or identity changed while saving');
      }
      if (previous === null && current) throw new Error('Project target appeared while saving');
      try {
        await operations.rename(temporary, target);
        ownsTemporary = false;
        return;
      } catch (error) {
        if (platform !== 'win32' || !transientCodes.has(error.code) || attempt >= WINDOWS_RETRY_DELAYS_MS.length) throw error;
        await wait(WINDOWS_RETRY_DELAYS_MS[attempt]);
      }
    }
  } finally {
    if (ownsTemporary) await operations.unlink(temporary).catch(() => {});
  }
}

module.exports = { atomicWriteProject, WINDOWS_RETRY_DELAYS_MS };

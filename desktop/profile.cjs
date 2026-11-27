const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readFlags, sameFile } = require('./bounded-read.cjs');

const WINDOW_LIMIT = 4096;
const LOG_LIMIT = 256 * 1024;

function verifyProfileDirectory(directory) {
  const absolute = path.resolve(directory);
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(absolute)) throw new Error('Local profile required');
  for (let current = absolute; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Profile directory must be local and contain no links');
    if (current === path.dirname(current)) break;
  }
  return absolute;
}

function createProfileDirectory(directory) {
  if (!path.isAbsolute(directory) || (process.platform === 'win32' && !/^[a-z]:\\/i.test(directory))) {
    throw new Error('Local absolute profile directory required');
  }
  // Validate the existing ancestor before creating any missing directories.
  let ancestor = path.resolve(directory);
  while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = path.dirname(ancestor);
  verifyProfileDirectory(ancestor);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return verifyProfileDirectory(directory);
}

function regularEntry(filename) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Profile entry must be an unlinked regular file');
  return stat;
}

function readWindowState(directory) {
  try {
    const filename = path.join(verifyProfileDirectory(directory), 'window.json');
    const selected = regularEntry(filename);
    if (!selected || selected.size > WINDOW_LIMIT) return {};
    const fd = fs.openSync(filename, readFlags);
    try {
      if (!sameFile(selected, fs.fstatSync(fd)) || !sameFile(selected, regularEntry(filename))) return {};
      const bytes = Buffer.alloc(WINDOW_LIMIT + 1);
      let total = 0;
      while (total < bytes.length) {
        const count = fs.readSync(fd, bytes, total, bytes.length - total, total);
        if (!count) break;
        total += count;
      }
      if (total > WINDOW_LIMIT) return {};
      const parsed = JSON.parse(bytes.toString('utf8', 0, total));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } finally { fs.closeSync(fd); }
  } catch { /* Window placement is optional. */ }
  return {};
}

function writeWindowState(directory, state) {
  const filename = path.join(verifyProfileDirectory(directory), 'window.json');
  regularEntry(filename);
  const temporary = path.join(directory, '.window-' + randomUUID() + '.tmp');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    verifyProfileDirectory(directory);
    regularEntry(filename);
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Already published or no longer available. */ }
  }
}

function appendProfileLog(directory, message) {
  const filename = path.join(verifyProfileDirectory(directory), 'desktop.log');
  const selected = regularEntry(filename);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT
    | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(filename, flags, 0o600);
  try {
    const opened = fs.fstatSync(fd), current = regularEntry(filename);
    if (!opened.isFile() || !current || !sameFile(opened, current) || (selected && !sameFile(opened, selected))) return;
    const line = Buffer.from(`${new Date().toISOString()} ${message.slice(0, 2048)}\n`, 'utf8');
    const position = opened.size + line.length > LOG_LIMIT ? 0 : opened.size;
    if (position === 0 && opened.size > 0) fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, line, 0, line.length, position);
  } finally { fs.closeSync(fd); }
}

module.exports = { createProfileDirectory, verifyProfileDirectory, readWindowState, writeWindowState, appendProfileLog };

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readBounded, readCheckedFile } from '../desktop/bounded-read.cjs';
import { appendProfileLog, createProfileDirectory, readWindowState, writeWindowState } from '../desktop/profile.cjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-file-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

test('bounded reads accept the exact limit and request at most limit plus one byte', async () => {
  const file = Buffer.from('old-data-plus-extra');
  const readSizes = [];
  const handle = { read: async (buffer, offset, length, position) => {
    readSizes.push(length);
    return { bytesRead: file.copy(buffer, offset, position, Math.min(position + length, position + 3, file.length)) };
  } };
  await assert.rejects(readBounded(handle, 8), { code: 'FILE_TOO_LARGE' });
  assert.deepEqual(readSizes, [9, 6, 3]);
  assert.equal((await readBounded({ read: async (buffer, offset, length, position) => ({
    bytesRead: Buffer.from('old-data').copy(buffer, offset, position, Math.min(position + length, 8)),
  }) }, 8)).toString(), 'old-data');
});

test('native reader rejects a file that grew after selection', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'project.json');
  await fs.writeFile(file, 'old-data');
  const selected = await fs.lstat(file);
  await fs.appendFile(file, '-extra');
  await assert.rejects(readCheckedFile(file, selected, selected.size), { code: 'FILE_TOO_LARGE' });
});

test('profile window state is bounded and atomically restored; logs stay bounded', async t => {
  const directory = await fixture(t);
  const window = path.join(directory, 'window.json');
  const log = path.join(directory, 'desktop.log');
  await fs.writeFile(window, ' '.repeat(4097));
  assert.deepEqual(readWindowState(directory), {});
  writeWindowState(directory, { width: 1200, maximized: true });
  assert.deepEqual(readWindowState(directory), { width: 1200, maximized: true });
  await fs.writeFile(log, ' '.repeat(256 * 1024));
  appendProfileLog(directory, 'New session');
  assert.match(await fs.readFile(log, 'utf8'), /^\d{4}-.+ New session\n$/);
});

test('profile refuses linked directories and hard-linked state entries', async t => {
  const directory = await fixture(t);
  const outside = path.join(directory, 'original.json');
  await fs.writeFile(outside, '{"width":1300}');
  await fs.link(outside, path.join(directory, 'window.json'));
  await fs.link(outside, path.join(directory, 'desktop.log'));
  assert.deepEqual(readWindowState(directory), {});
  assert.throws(() => writeWindowState(directory, { width: 1200 }), /regular file/);
  assert.throws(() => appendProfileLog(directory, 'text'), /regular file/);
  const other = path.join(directory, 'other');
  await fs.mkdir(other);
  const linked = path.join(directory, 'linked');
  await fs.symlink(other, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(async () => createProfileDirectory(path.join(linked, 'profile')), /contain no links/);
  assert.equal(await fs.readFile(outside, 'utf8'), '{"width":1300}');
});

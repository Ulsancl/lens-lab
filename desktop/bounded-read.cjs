const fs = require('node:fs');
const fsp = require('node:fs/promises');

const readFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

async function readBounded(handle, limit) {
  const chunks = [];
  let total = 0;
  while (total <= limit) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > limit) break;
    chunks.push(buffer.subarray(0, bytesRead));
  }
  throw Object.assign(new Error('File size limit exceeded'), { code: 'FILE_TOO_LARGE' });
}

async function readCheckedFile(target, selected, limit) {
  if (selected.size > limit) throw Object.assign(new Error('File size limit exceeded'), { code: 'FILE_TOO_LARGE' });
  const handle = await fsp.open(target, readFlags);
  try {
    const opened = await handle.stat();
    const current = await fsp.lstat(target);
    if (!opened.isFile() || !current.isFile() || !sameFile(opened, selected) || !sameFile(opened, current)) {
      throw new Error('실험 파일이 변경되었습니다. 다시 선택해 주세요.');
    }
    return await readBounded(handle, limit);
  } finally { await handle.close(); }
}

module.exports = { readBounded, readCheckedFile, readFlags, sameFile };

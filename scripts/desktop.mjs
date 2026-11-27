import { checkedPath, readInput, copyInput, stagingDirectory, publishDirectory, writeArtifact, checkTree } from './safe-files.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildWeb } from './build-web.mjs';
import { verifyWindowsRelease } from './verify-windows-release.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['start', 'package', 'prepare-test', 'package-test'].includes(mode)) throw new Error('Use start, package, prepare-test or package-test');
if (mode === 'prepare-test' && process.env.LENS_DESKTOP_EXE) process.exit(0);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
delete env.electron_use_remote_checksums;
delete env.npm_config_electron_use_remote_checksums;
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`)));
  });
}
for (const input of ['src', 'public', 'desktop', 'docs', 'node_modules/electron']) checkTree(root, path.join(root, input));
const electronPackage = path.dirname(require.resolve('electron/package.json'));
await run(process.execPath, [path.join(electronPackage, 'install.js')]);
if (mode === 'start' || mode === 'prepare-test') {
  await buildWeb({ test: mode === 'prepare-test' });
  if (mode === 'start') await run(require('electron'), [root]);
} else {
  const test = mode === 'package-test';
  const requireSigned = !test && env.LENS_REQUIRE_SIGNED_INSTALLER === '1';
  const thumbprint = env.LENS_SIGNER_THUMBPRINT;
  if (requireSigned && (process.platform !== 'win32' || !/^[a-f\d]{40}$/i.test(thumbprint ?? ''))) {
    throw new Error('Signing verification requires Windows and LENS_SIGNER_THUMBPRINT');
  }
  const stage = stagingDirectory(root), app = path.join(stage, 'app'), output = path.join(stage, 'windows');
  const configuration = JSON.parse(readInput(root, path.join(root, 'electron-builder.json')));
  const packageInfo = JSON.parse(readInput(root, path.join(root, 'package.json')));
  try {
    const inputs = [...new Set(['desktop', 'package.json', configuration.directories.buildResources, ...configuration.files.filter(file => !file.includes('*')), ...configuration.extraResources.map(item => item.from)])];
    for (const input of inputs.filter(file => !inputs.some(parent => file !== parent && file.startsWith(parent + '/')))) {
      copyInput(root, path.join(root, input), path.join(app, input));
    }
    for (const dependency of Object.keys(packageInfo.dependencies || {})) {
      copyInput(root, path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency));
    }
    await buildWeb({ test, destination: path.join(app, 'dist') });
    const electronDist = checkedPath(root, path.join(root, 'node_modules', 'electron', 'dist'));
    checkTree(root, electronDist);
    const options = test ? ['--dir', '--config.extraMetadata.lensLabTestBuild=true', '--config.electronFuses.enableNodeCliInspectArguments=true'] : [];
    if (requireSigned) options.push('--config.forceCodeSigning=true');
    await run(process.execPath, [path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'),
      '--win', ...(test ? [] : ['nsis']), '--x64', '--config', path.join(root, 'electron-builder.json'), '--projectDir', app,
      `--config.electronDist=${electronDist}`, `--config.directories.output=${output}`, '--config.npmRebuild=false', '--publish', 'never', ...options]);
    if (!test) {
      const file = path.join(output, `Lens-Lab-Setup-${packageInfo.version}.exe`);
      if (requireSigned) await verifyWindowsRelease([file, path.join(output, 'win-unpacked', 'Lens Lab.exe')], thumbprint);
      writeArtifact(root, file + '.sha256', `${createHash('sha256').update(readInput(root, file)).digest('hex')}  ${path.basename(file)}\n`);
      console.log(`Installer: ${path.basename(file)}`);
    }
    publishDirectory(root, output, path.join(root, 'release', test ? 'desktop-test' : 'windows'));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

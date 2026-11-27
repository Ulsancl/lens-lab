import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { checkTree, copyInput, publishDirectory, readInput, secureDirectory, stagingDirectory } from './safe-files.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'none'; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'";

export async function buildWeb({ test = false, root = repository, destination = path.join(root, 'dist') } = {}) {
  secureDirectory(root, path.dirname(destination));
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
    checkTree(root, destination);
    if (!fs.statSync(destination).isDirectory()) throw new Error('Build output must be a directory');
  }
  const stage = stagingDirectory(root);
  try {
    const input = path.join(stage, 'input');
    for (const entry of ['index.html', 'src', 'public', 'desktop/assets/app.png', 'node_modules/three']) {
      copyInput(root, path.join(root, entry), path.join(input, entry));
    }
    const output = path.join(stage, 'bundle');
    const { version } = JSON.parse(readInput(root, path.join(root, 'package.json')));
    await build({
      configFile: false, envDir: false, root: input, base: './',
      mode: test ? 'test' : 'production',
      define: { 'import.meta.env.LENS_VERSION': JSON.stringify(version) },
      plugins: [{
        name: 'lens-content-security-policy',
        transformIndexHtml() {
          return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }];
        },
      }],
      build: { outDir: output, emptyOutDir: false },
    });
    publishDirectory(root, output, destination);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWeb();

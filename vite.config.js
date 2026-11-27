import { defineConfig, normalizePath } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
const root = normalizePath(fileURLToPath(new URL('.', import.meta.url))).replace(/\/$/, '').replace(/[\\()[\]{}*?!+@]/g, '\\$&');
const generated = ['.security-stage-*', '.security-write-*', 'dist', 'output', 'release'].map(name => `${root}/${name}/**`);

export default defineConfig({
  base: './',
  define: { 'import.meta.env.LENS_VERSION': JSON.stringify(version) },
  server: {
    host: '127.0.0.1', port: 5220, strictPort: true,
    watch: { ignored: generated },
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', ...generated],
    },
  },
});

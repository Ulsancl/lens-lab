const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, screen } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { atomicWriteProject } = require('./atomic-save.cjs');
const { readCheckedFile } = require('./bounded-read.cjs');
const { createProfileDirectory, verifyProfileDirectory, readWindowState, writeWindowState, appendProfileLog } = require('./profile.cjs');

const APP_URL = 'app://lens/';
const APP_NAME = 'Lens Lab';
const APP_ID = 'com.lenslab.app';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
let mainWindow, calculationBusy = false, nativeBusy = 0, closePrompt = false;
const downloads = new Set();
let codec;

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
// Stable profile and origin preserve user data across ordinary app updates.
const testBuild = require('../package.json').lensLabTestBuild === true;
const profileOverride = (!app.isPackaged || testBuild) && process.env.LENS_LAB_DATA_DIR;
const profile = createProfileDirectory(profileOverride || path.join(app.getPath('appData'), APP_NAME));
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

function log(message) {
  try { appendProfileLog(profile, message); } catch { /* Logging is optional. */ }
}
function trustedURL(value) {
  try { const url = new URL(value); return url.protocol === 'app:' && url.host === 'lens' && !url.username && !url.password; }
  catch { return false; }
}
function trustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !trustedURL(event.senderFrame?.url)) {
    throw new Error('Invalid application sender');
  }
}
function command(value) { mainWindow?.webContents.send('lens:command', value); }
function safeFileName(value) {
  let name = path.basename(typeof value === 'string' ? value : '렌즈 실험.lens.json')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 160);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `lens-${name}`;
  return name || '렌즈 실험.lens.json';
}
function projectCodec() {
  codec ??= import(pathToFileURL(path.join(__dirname, '..', 'src', 'project.js')).href);
  return codec;
}
async function projectTarget(target, allowMissing = false) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('실험 파일의 절대 경로를 확인해 주세요.');
  const parent = path.dirname(target), realParent = await fsp.realpath(parent);
  const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalized(parent) !== normalized(realParent)) throw new Error('연결된 폴더 대신 원래 실험 파일 폴더를 선택해 주세요.');
  let stat;
  try { stat = await fsp.lstat(target); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('폴더나 연결 파일 대신 일반 JSON 파일을 선택해 주세요.');
  return stat;
}

async function serveBundle(request) {
  if (!trustedURL(request.url)) return new Response('Not found', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  try {
    const root = path.join(app.getAppPath(), 'dist');
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || pathname.includes('\0')) {
      return new Response('Forbidden', { status: 403 });
    }
    const actual = await fsp.realpath(target), actualRelative = path.relative(root, actual);
    if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) {
      return new Response('Forbidden', { status: 403 });
    }
    const data = await fsp.readFile(actual);
    return new Response(request.method === 'HEAD' ? null : data, { headers: {
      'Content-Type': mime[path.extname(actual)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'none'; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    } });
  } catch { return new Response('Not found', { status: 404 }); }
}

function registerFileActions() {
  ipcMain.on('lens:busy', (event, busy) => {
    try { trustedSender(event); calculationBusy = busy === true; } catch { /* Ignore unrelated frames. */ }
  });
  ipcMain.handle('lens:open-project', async event => {
    trustedSender(event);
    if (nativeBusy) return { canceled: true };
    nativeBusy++;
    try {
      const result = await dialog.showOpenDialog(mainWindow, { title: '렌즈 실험 열기',
        properties: ['openFile'], filters: [{ name: '렌즈 실험 JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePaths[0]) return { canceled: true };
      const target = result.filePaths[0], stat = await projectTarget(target);
      const { parseProject, serializeProject, MAX_PROJECT_BYTES } = await projectCodec();
      let bytes;
      try { bytes = await readCheckedFile(target, stat, MAX_PROJECT_BYTES); }
      catch (error) {
        if (error.code === 'FILE_TOO_LARGE') throw new Error('실험 파일은 10 MiB 이하여야 합니다.');
        throw error;
      }
      const project = parseProject(bytes.toString('utf8'));
      return { canceled: false, content: serializeProject(project), path: target };
    } finally { nativeBusy--; }
  });
  ipcMain.handle('lens:save-project', async (event, payload) => {
    trustedSender(event);
    if (nativeBusy) return { canceled: true };
    if (!payload || typeof payload !== 'object') throw new Error('실험 파일 내용을 확인해 주세요.');
    nativeBusy++;
    try {
      const { parseProject, serializeProject } = await projectCodec();
      const contents = serializeProject(parseProject(payload.contents));
      const result = await dialog.showSaveDialog(mainWindow, { title: '렌즈 실험 저장',
        defaultPath: path.join(app.getPath('documents'), safeFileName(payload.name)),
        filters: [{ name: '렌즈 실험 JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return { canceled: true };
      await atomicWriteProject(result.filePath, contents, { validateTarget: target => projectTarget(target, true) });
      return { canceled: false, path: result.filePath };
    } finally {
      nativeBusy--;
    }
  });
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '파일', submenu: [
      { label: '새 실험', accelerator: 'CmdOrCtrl+N', click: () => command('new-project') },
      { label: '실험 열기…', accelerator: 'CmdOrCtrl+O', click: () => command('open-project') },
      { label: '실험 저장…', accelerator: 'CmdOrCtrl+S', click: () => command('save-project') },
      { type: 'separator' }, { label: '종료', accelerator: 'Alt+F4', click: () => mainWindow?.close() },
    ] },
    { label: '편집', submenu: [{ label: '실행 취소', role: 'undo' }, { label: '다시 실행', role: 'redo' },
      { type: 'separator' }, { label: '잘라내기', role: 'cut' }, { label: '복사', role: 'copy' },
      { label: '붙여넣기', role: 'paste' }, { label: '전체 선택', role: 'selectAll' }] },
    { label: '실험', submenu: [
      { label: '광선 표시 전환', accelerator: 'CmdOrCtrl+Shift+R', click: () => command('toggle-rays') },
    ] },
    { label: '보기', submenu: [
      { label: '3D 크게 보기', accelerator: 'CmdOrCtrl+Shift+F', click: () => command('focus') },
      { type: 'separator' }, { label: '실제 크기', role: 'resetZoom' }, { label: '확대', role: 'zoomIn' },
      { label: '축소', role: 'zoomOut' }, { label: '전체 화면', accelerator: 'F11', role: 'togglefullscreen' },
    ] },
    { label: '도움말', submenu: [
      { label: '사용 안내', accelerator: 'F1', click: () => command('help') },
      { label: '저장 폴더 열기', click: () => {
        try { void shell.openPath(verifyProfileDirectory(profile)); }
        catch { dialog.showErrorBox(APP_NAME, '로컬 저장 폴더를 열 수 없습니다.'); }
      } },
      { label: '프로그램 정보', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: APP_NAME,
        message: `${APP_NAME} ${app.getVersion()}`,
        detail: '물체·수렴 렌즈·스크린으로 초점과 실상·허상, 조리개를 관찰하는 교육용 실험 앱입니다.\n\n광학 설정·비교 기록과 관찰 시점을 JSON으로 보관할 수 있습니다.\n\n얇은 렌즈·근축 기하광학 모형입니다. 광량은 상대값이며 실제 조도(lux)가 아닙니다. 회절·수차·유리 두께의 굴절과 실제 장비의 안전성을 계산하지 않습니다.', buttons: ['확인'] }) },
    ] },
  ]));
}

function windowBounds(saved) {
  const primary = screen.getPrimaryDisplay().workArea;
  const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-1000000, Math.min(1000000, Math.round(value))) : fallback;
  const candidate = { x: number(saved.x, primary.x), y: number(saved.y, primary.y),
    width: Math.max(100, Math.min(32768, number(saved.width, 1440))),
    height: Math.max(100, Math.min(32768, number(saved.height, 1000))) };
  const area = screen.getDisplayMatching(candidate).workArea;
  const minWidth = Math.min(960, area.width), minHeight = Math.min(640, area.height);
  const width = Math.max(minWidth, Math.min(candidate.width, area.width));
  const height = Math.max(minHeight, Math.min(candidate.height, area.height));
  const x = Math.max(area.x, Math.min(number(saved.x, area.x + (area.width - width) / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(number(saved.y, area.y + (area.height - height) / 2), area.y + area.height - height));
  return { x, y, width, height, minWidth, minHeight };
}

function restoreWindowBounds(window, preferred) {
  const keys = ['x', 'y', 'width', 'height'];
  const requested = Object.fromEntries(keys.map(key => [key, preferred[key]]));
  // On Windows at fractional DPI, setBounds/getNormalBounds can differ by a DIP
  // because the native frame rounds its edges to physical pixels. Restore the
  // saved *actual* rectangle, rather than feeding that rounding error into the
  // next saved size. Keep the correction bounded if the OS constrains a window.
  for (let attempt = 0; attempt < 3; attempt++) {
    window.setBounds(requested);
    if (process.platform !== 'win32') break;
    const actual = window.getNormalBounds();
    const differences = keys.map(key => preferred[key] - actual[key]);
    if (differences.every(value => value === 0) || differences.some(value => Math.abs(value) > 2)) break;
    keys.forEach((key, index) => { requested[key] += differences[index]; });
  }
}

function createWindow() {
  const saved = readWindowState(profile);
  const preferredBounds = windowBounds(saved);
  mainWindow = new BrowserWindow({ ...preferredBounds, title: APP_NAME, show: false,
    backgroundColor: '#101820', icon: path.join(__dirname, 'assets', 'app.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || !trustedURL(event.url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    calculationBusy = false; log(`Renderer ended: ${details.reason}`);
    dialog.showMessageBox(mainWindow, { type: 'error', title: APP_NAME, message: '화면을 계속 표시하지 못했습니다.',
      detail: '저장된 관찰 설정은 유지됩니다. 프로그램을 다시 시작해 주세요.', buttons: ['확인'] });
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    log(`Load failed: ${code} ${description} ${url}`);
    dialog.showErrorBox(APP_NAME, '프로그램 파일을 읽지 못했습니다. 설치 파일로 다시 설치해 주세요.'); app.quit();
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Correct the visible normal frame before maximizing so its restored size
    // also stays stable when the app was closed maximized.
    restoreWindowBounds(mainWindow, preferredBounds);
    if (saved.maximized === true) mainWindow.maximize();
  });
  mainWindow.on('close', event => {
    if (calculationBusy || nativeBusy || downloads.size) {
      event.preventDefault(); if (closePrompt) return; closePrompt = true;
      dialog.showMessageBox(mainWindow, { type: 'warning', title: '작업 진행 중',
        message: '자료 처리 또는 파일 작업이 진행 중입니다.', detail: '작업이 끝난 후 창을 닫아 주세요.',
        buttons: ['작업 계속', '작업 중단 후 종료'], defaultId: 0, cancelId: 0, noLink: true,
      }).then(({ response }) => { closePrompt = false; if (response === 1) app.exit(0); }).catch(() => { closePrompt = false; });
      return;
    }
    try { writeWindowState(profile, {
      ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized(),
    }); } catch { /* Window layout is optional. */ }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  createMenu(); mainWindow.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus();
  } });
  app.whenReady().then(async () => {
    protocol.handle('app', serveBundle);
    session.defaultSession.webRequest.onBeforeRequest(({ url }, callback) => {
      const allowed = trustedURL(url) || url.startsWith('data:') || (url.startsWith('blob:') && trustedURL(url.slice(5)));
      callback({ cancel: !allowed });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (_event, item, contents) => {
      if (!mainWindow || contents !== mainWindow.webContents) { item.cancel(); return; }
      downloads.add(item);
      item.setSaveDialogOptions({ title: '결과 파일 저장', defaultPath: path.join(app.getPath('documents'), safeFileName(item.getFilename())) });
      item.once('done', () => downloads.delete(item));
    });
    registerFileActions(); createWindow(); log(`Started ${app.getVersion()}`);
  }).catch(error => { log(`Startup failed: ${error.stack}`);
    dialog.showErrorBox(APP_NAME, `프로그램을 시작하지 못했습니다.\n${error.message}`); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}

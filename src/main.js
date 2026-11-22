// esppro — main process
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { SerialPort } = require('serialport');

// ---------- portable mode ----------
// If a folder named "esppro-data" sits next to the executable, keep all settings there.
// The single-file portable build extracts to a temp folder; PORTABLE_EXECUTABLE_DIR is where the .exe really is.
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const portableDir = path.join(exeDir, 'esppro-data');
if (process.env.PORTABLE_EXECUTABLE_DIR && !fs.existsSync(portableDir)) { try { fs.mkdirSync(portableDir); } catch {} }
if (fs.existsSync(portableDir)) app.setPath('userData', portableDir);

const USER = () => app.getPath('userData');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ARDUINO_DATA = path.join(LOCALAPPDATA, 'Arduino15');
const SKETCHBOOK = path.join(app.getPath('documents'), 'Arduino');
const DATA = path.join(__dirname, 'data');

let win = null;

// ---------- settings ----------
const DEFAULTS = {
  theme: 'system',          // system | dark | light
  language: 'system',       // system | ar | en
  fontSize: 14,
  baud: 115200,
  lastFqbn: '',
  lastPort: '',
  boardUrls: null,          // [{url,name,enabled,status}] — filled on first run
  firstRun: true,
  cliPath: '',
  esptoolPath: '',
  snapshots: true,
  recent: [],
};
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(USER(), 'settings.json');

function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { settings = { ...DEFAULTS }; }
  if (!settings.boardUrls) settings.boardUrls = initialBoardUrls();
}
function saveSettings() {
  fs.mkdirSync(USER(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  writeCliConfig();
}

function initialBoardUrls() {
  const curated = JSON.parse(fs.readFileSync(path.join(DATA, 'board-urls.json'), 'utf8'));
  // Import whatever the user already had in Arduino IDE so nothing is lost.
  const existing = [];
  try {
    const y = fs.readFileSync(path.join(os.homedir(), '.arduinoIDE', 'arduino-cli.yaml'), 'utf8');
    const block = y.split(/additional_urls:\s*\n/)[1] || '';
    for (const line of block.split('\n')) {
      const m = line.match(/^\s+-\s+(\S+)/);
      if (!m) break;
      existing.push(m[1]);
    }
  } catch {}
  const list = curated.map(c => ({ ...c, status: 'unknown' }));
  for (const u of existing) {
    if (!u.endsWith('.json')) continue;
    const found = list.find(x => x.url === u);
    if (found) found.enabled = true;
    else list.push({ name: nameFromUrl(u), url: u, enabled: true, status: 'unknown' });
  }
  return list;
}
function nameFromUrl(u) {
  try {
    const p = new URL(u);
    const file = p.pathname.split('/').pop().replace(/^package_|_index\.json$|\.json$/g, '');
    return `${file} (${p.hostname})`;
  } catch { return u; }
}

// ---------- arduino-cli ----------
function cliConfigPath() { return path.join(USER(), 'arduino-cli.yaml'); }
function writeCliConfig() {
  const urls = (settings.boardUrls || []).filter(b => b.enabled).map(b => b.url);
  const y = [
    'board_manager:',
    '  additional_urls:',
    ...(urls.length ? urls.map(u => `    - ${u}`) : ['    []']),
    'directories:',
    `  data: ${ARDUINO_DATA}`,
    `  user: ${SKETCHBOOK}`,
    `  builtin:`,
    `    libraries: ${path.join(ARDUINO_DATA, 'libraries')}`,
    'locale: en',
    '',
  ].join('\n').replace('  additional_urls:\n    []', '  additional_urls: []');
  fs.mkdirSync(USER(), { recursive: true });
  fs.writeFileSync(cliConfigPath(), y);
}
function findCli() {
  const candidates = [
    settings.cliPath,
    path.join(process.resourcesPath || '', 'bin', 'arduino-cli.exe'),
    path.join(__dirname, '..', 'bin', 'arduino-cli.exe'),
    path.join(LOCALAPPDATA, 'Programs', 'arduino-ide', 'resources', 'app', 'lib', 'backend', 'resources', 'arduino-cli.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'arduino-cli'; // hope it is on PATH
}
function cliJson(args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(findCli(), [...args, '--format', 'json', '--config-file', cliConfigPath()],
      { maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true },
      (err, stdout, stderr) => {
        let data = null;
        try { data = JSON.parse(stdout); } catch {}
        resolve({ ok: !err && data !== null, data, error: err ? (stderr || err.message) : null });
      });
  });
}

// ---------- process jobs (streamed to the UI) ----------
let jobSeq = 0;
const jobs = new Map();
const q = s => (/[\s"&|<>^()]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
const cmdLine = parts => parts.map(q).join(' ');

function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }

/** Run through cmd.exe so the user sees exactly the CMD command. */
function startJob({ exe, args, label, usesPort, onExit }) {
  const id = ++jobSeq;
  const line = cmdLine([exe, ...args]);
  const shown = line.replace(/password=("[^"]*"|\S+)/g, 'password=***').replace(/ -u ("?)([^:\s"]+):[^\s"]*\1/g, ' -u $1$2:***$1'); // never print secrets
  const resumeInfo = usesPort ? pauseSerial() : null;
  send('job:out', { id, text: `> ${shown}\n`, kind: 'cmd', label });
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    windowsVerbatimArguments: true, windowsHide: true, cwd: os.homedir(),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });
  jobs.set(id, child);
  const started = Date.now();
  let all = '';
  const onData = d => { const t = d.toString('utf8'); all += t; if (all.length > 2e6) all = all.slice(-1e6); send('job:out', { id, text: t }); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', e => onData(Buffer.from(`\n${e.message}\n`)));
  child.on('close', async code => {
    jobs.delete(id);
    let extra = {};
    try { if (onExit) extra = (await onExit(code, all)) || {}; } catch {}
    send('job:exit', { id, code, label, seconds: (Date.now() - started) / 1000, ...extra });
    if (resumeInfo) setTimeout(() => resumeSerial(resumeInfo), 800);
  });
  return { id, line: shown };
}

ipcMain.handle('job:kill', (_e, id) => {
  const c = jobs.get(id);
  if (c) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true });
  return true;
});

ipcMain.handle('job:openInCmd', (_e, line) => {
  // Opens a real, visible CMD window running the same command.
  spawn('cmd.exe', ['/d', '/c', `start "esppro" cmd /k ${line}`], { windowsVerbatimArguments: true, detached: true });
  return true;
});

// ---------- serial ----------
let serial = null;
let serialInfo = null;
let rxBuf = '';
let rxTimer = null;
const decoder = new TextDecoder('utf-8');

function flushRx() { rxTimer = null; if (rxBuf) { send('serial:data', rxBuf); rxBuf = ''; } }

function openSerial({ path: p, baud }) {
  return new Promise((resolve) => {
    if (serial) { try { serial.close(); } catch {} serial = null; }
    const sp = new SerialPort({ path: p, baudRate: Number(baud) || 115200, autoOpen: false });
    sp.open(err => {
      if (err) { send('serial:state', { open: false, error: err.message }); return resolve({ ok: false, error: err.message }); }
      serial = sp; serialInfo = { path: p, baud };
      sp.on('data', d => {
        rxBuf += decoder.decode(d, { stream: true });
        if (!rxTimer) rxTimer = setTimeout(flushRx, 40); // batch to keep the UI fast
      });
      sp.on('close', () => { if (serial === sp) { serial = null; send('serial:state', { open: false }); } });
      sp.on('error', e => send('serial:state', { open: !!serial, error: e.message }));
      send('serial:state', { open: true, ...serialInfo });
      resolve({ ok: true });
    });
  });
}
function closeSerial() {
  return new Promise(res => {
    if (!serial) return res(true);
    const sp = serial; serial = null;
    sp.close(() => { send('serial:state', { open: false }); res(true); });
  });
}
function pauseSerial() {
  if (!serial) return null;
  const info = { ...serialInfo };
  closeSerial();
  send('serial:state', { open: false, paused: true });
  return info;
}
async function resumeSerial(info) {
  // Native-USB boards re-enumerate after a reset; the port may be gone for a few seconds.
  for (let i = 0; i < 6 && !serial; i++) {
    const r = await openSerial(info);
    if (r.ok) return;
    await new Promise(res => setTimeout(res, 700));
  }
}

ipcMain.handle('serial:open', (_e, o) => openSerial(o));
ipcMain.handle('serial:close', () => closeSerial());
ipcMain.handle('serial:write', (_e, text) => { if (serial) serial.write(text); return !!serial; });
ipcMain.handle('serial:setSignals', (_e, s) => new Promise(r => serial ? serial.set(s, () => r(true)) : r(false)));
ipcMain.handle('ports:list', async () => {
  try { return await SerialPort.list(); } catch { return []; }
});

// ---------- sketches ----------
const SRC_EXT = /\.(ino|h|hpp|c|cpp|S|txt)$/i;
function readSketch(dir) {
  const base = path.basename(dir);
  const files = fs.readdirSync(dir)
    .filter(f => SRC_EXT.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .map(f => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
  files.sort((a, b) => (a.name === base + '.ino' ? -1 : b.name === base + '.ino' ? 1 : a.name.localeCompare(b.name)));
  return { dir, name: base, files };
}
function addRecent(dir) {
  if (path.resolve(dir).startsWith(path.resolve(USER(), 'untitled'))) return; // unsaved sketches are not "recent"
  settings.recent = [dir, ...settings.recent.filter(d => d !== dir)].slice(0, 10);
  saveSettings();
}
const TEMPLATE = 'void setup() {\n  Serial.begin(115200);\n\n}\n\nvoid loop() {\n\n}\n';
function stamp() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

ipcMain.handle('sketch:new', () => {
  const root = path.join(USER(), 'untitled');
  // Remove old untitled sketches that were never changed.
  try {
    for (const d of fs.readdirSync(root)) {
      const ino = path.join(root, d, d + '.ino');
      if (fs.existsSync(ino) && fs.readFileSync(ino, 'utf8') === TEMPLATE && fs.readdirSync(path.join(root, d)).length === 1) fs.rmSync(path.join(root, d), { recursive: true, force: true });
    }
  } catch {}
  const name = `sketch_${stamp()}`;
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.ino'), TEMPLATE);
  return { ...readSketch(dir), untitled: true };
});
ipcMain.handle('sketch:open', async (_e, dirArg) => {
  let dir = dirArg;
  if (!dir) {
    const r = await dialog.showOpenDialog(win, { defaultPath: SKETCHBOOK, filters: [{ name: 'Sketch', extensions: ['ino'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    dir = path.dirname(r.filePaths[0]);
  }
  if (!fs.existsSync(dir)) return null;
  addRecent(dir);
  return readSketch(dir);
});
ipcMain.handle('sketch:save', (_e, { dir, files }) => {
  for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.content);
  return true;
});
ipcMain.handle('sketch:saveAs', async (_e, { name, files }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(SKETCHBOOK, name) });
  if (r.canceled) return null;
  const newName = path.basename(r.filePath).replace(/\.ino$/i, '').replace(/[^\w-]/g, '_');
  const dir = path.join(path.dirname(r.filePath), newName);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const fname = f.name === name + '.ino' ? newName + '.ino' : f.name;
    fs.writeFileSync(path.join(dir, fname), f.content);
  }
  addRecent(dir);
  return readSketch(dir);
});
ipcMain.handle('sketch:addFile', async (_e, { dir, name }) => {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  return true;
});
ipcMain.handle('sketch:examples', () => {
  // Built-in examples of installed cores/libraries are many; we offer the sketchbook list instead.
  try { return fs.readdirSync(SKETCHBOOK).filter(d => fs.existsSync(path.join(SKETCHBOOK, d, d + '.ino'))).map(d => path.join(SKETCHBOOK, d)); }
  catch { return []; }
});

function snapshot(dir) {
  if (!settings.snapshots) return;
  try {
    const target = path.join(USER(), 'snapshots', `${path.basename(dir)}_${stamp()}`);
    fs.cpSync(dir, target, { recursive: true, filter: src => !/[\\/]build([\\/]|$)/.test(src) });
    const root = path.join(USER(), 'snapshots');
    const all = fs.readdirSync(root).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 50))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  } catch {}
}
ipcMain.handle('snapshots:open', () => { const d = path.join(USER(), 'snapshots'); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); });

// ---------- compile / upload / export ----------
function listBins(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.bin'))
      .map(f => ({ path: path.join(dir, f), name: f, size: fs.statSync(path.join(dir, f)).size }));
  } catch { return []; }
}
// Fingerprint of the sketch sources + board, to skip recompiling when nothing changed.
const crypto = require('crypto');
function sketchHash(dir, fqbn) {
  const h = crypto.createHash('sha1').update(fqbn);
  for (const f of fs.readdirSync(dir).filter(f => SRC_EXT.test(f)).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}
const buildDirFor = dir => path.join(USER(), 'builds', crypto.createHash('sha1').update(dir).digest('hex').slice(0, 12));
const lastGood = new Map(); // build dir -> hash of the last successful compile

// The single complete image a user wants: merged (ESP) > with_bootloader (AVR) > app .bin > .hex
function fullImage(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const pick = files.find(f => /\.merged\.bin$/i.test(f)) || files.find(f => /\.with_bootloader\.bin$/i.test(f))
    || files.find(f => /\.ino\.bin$/i.test(f)) || files.find(f => /\.ino\.hex$/i.test(f));
  return pick ? path.join(dir, pick) : null;
}

ipcMain.handle('build:run', async (_e, { dir, fqbn, port, upload, exportDir, exportFile }) => {
  const bdir = buildDirFor(dir);
  const hash = sketchHash(dir, fqbn);
  const label = upload ? 'upload' : (exportDir || exportFile) ? 'export' : 'verify';
  if (upload) snapshot(dir);

  // Nothing changed since the last good build: upload the existing binaries directly.
  if (upload && !exportDir && lastGood.get(bdir) === hash && fs.existsSync(bdir)) {
    send('job:out', { id: 0, text: '\n(no changes since last build — uploading without recompiling)\n', kind: 'cmd' });
    return startJob({ exe: findCli(), label, usesPort: true, args: ['upload', '-p', port, '-b', fqbn, '--input-dir', bdir, '--config-file', cliConfigPath(), dir] });
  }

  const out = exportDir || bdir;
  const args = ['compile', '-b', fqbn, '--config-file', cliConfigPath(), '--output-dir', out];
  if (upload) args.push('-u', '-p', port);
  args.push(dir);
  return startJob({
    exe: findCli(), args, label, usesPort: upload,
    onExit: (code) => {
      if (code !== 0) return {};
      if (out === bdir) lastGood.set(bdir, hash);
      if (exportFile) {
        const img = fullImage(bdir);
        if (!img) return { exportError: 'no image' };
        const target = /\.hex$/i.test(img) && !/\.hex$/i.test(exportFile) ? exportFile.replace(/\.bin$/i, '') + '.hex' : exportFile;
        fs.copyFileSync(img, target);
        return { bins: [{ path: target, name: path.basename(target), size: fs.statSync(target).size }], exportDir: path.dirname(target), full: true };
      }
      return exportDir ? { bins: listBins(exportDir), exportDir } : {};
    },
  });
});
ipcMain.handle('sketch:deleteFile', async (_e, { dir, name }) => {
  const p = path.join(dir, name);
  if (path.dirname(p) !== dir || name === path.basename(dir) + '.ino') return false; // never the main .ino
  try { await shell.trashItem(p); } catch { return false; } // goes to the Recycle Bin
  return true;
});
ipcMain.handle('sketch:renameFile', (_e, { dir, from, to }) => {
  const a = path.join(dir, from), b = path.join(dir, to);
  if (path.dirname(b) !== dir || fs.existsSync(b) || from === path.basename(dir) + '.ino') return false;
  fs.renameSync(a, b);
  return true;
});

ipcMain.handle('boards:listall', () => cliJson(['board', 'listall']));
ipcMain.handle('boards:details', (_e, fqbn) => cliJson(['board', 'details', '-b', fqbn]));
ipcMain.handle('boards:detected', () => cliJson(['board', 'list'], 20000));
ipcMain.handle('core:search', (_e, qstr) => cliJson(['core', 'search', qstr || '']));
ipcMain.handle('lib:search', (_e, qstr) => cliJson(['lib', 'search', qstr || '', '--omit-releases-details'], 180000));
ipcMain.handle('cli:job', (_e, { args, label }) => startJob({ exe: findCli(), args: [...args, '--config-file', cliConfigPath()], label }));
ipcMain.handle('cli:version', () => cliJson(['version'], 15000));

// ---------- board manager URLs ----------
async function checkUrl(u) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(u, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) return 'dead';
    const txt = await r.text();
    try { const j = JSON.parse(txt); return Array.isArray(j.packages) ? 'ok' : 'dead'; } catch { return 'dead'; }
  } catch { return 'dead'; } finally { clearTimeout(t); }
}
ipcMain.handle('urls:get', () => settings.boardUrls);
ipcMain.handle('urls:set', (_e, list) => { settings.boardUrls = list; saveSettings(); return true; });
ipcMain.handle('urls:check', async (_e, list) => {
  const out = await Promise.all(list.map(async b => ({ ...b, status: await checkUrl(b.url) })));
  return out;
});
ipcMain.handle('urls:fetchOnline', async () => {
  // Community-maintained list of third-party board URLs.
  const src = 'https://raw.githubusercontent.com/wiki/arduino/Arduino/Unofficial-list-of-3rd-party-boards-support-urls.md';
  try {
    const r = await fetch(src);
    const md = await r.text();
    const urls = [...new Set(md.match(/https?:\/\/[^\s)\]>"'`]+?\.json/g) || [])];
    return { ok: true, urls: urls.map(u => ({ url: u, name: nameFromUrl(u) })) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------- esptool ----------
function which(cmd) {
  return new Promise(r => execFile('where', [cmd], { windowsHide: true }, (e, out) => r(e ? null : out.split(/\r?\n/)[0].trim())));
}
function runCapture(exe, args, timeout = 20000) {
  return new Promise(r => execFile(exe, args, { windowsHide: true, timeout }, (e, out, err) => r({ ok: !e, out: (out || '') + (err || '') })));
}
let esptoolCache = null;
async function findEsptool(force) {
  if (esptoolCache && !force) return esptoolCache;
  const tries = [];
  if (settings.esptoolPath) tries.push({ exe: settings.esptoolPath, pre: [] });
  const onPath = await which('esptool');
  if (onPath) tries.push({ exe: onPath, pre: [] });
  const py = await which('python');
  if (py) tries.push({ exe: py, pre: ['-m', 'esptool'] });
  try {
    const base = path.join(ARDUINO_DATA, 'packages', 'esp32', 'tools', 'esptool_py');
    for (const v of fs.readdirSync(base).sort().reverse()) {
      const exe = path.join(base, v, 'esptool.exe');
      if (fs.existsSync(exe)) tries.push({ exe, pre: [] });
    }
  } catch {}
  for (const t of tries) {
    const r = await runCapture(t.exe, [...t.pre, 'version']);
    const m = r.out.match(/v?(\d+)\.(\d+)(?:\.(\d+))?/);
    if (r.ok && m) { esptoolCache = { ...t, version: m[0].replace(/^v/, ''), major: Number(m[1]), python: !!py }; return esptoolCache; }
  }
  esptoolCache = { exe: null, python: !!py };
  return esptoolCache;
}
ipcMain.handle('esptool:status', (_e, force) => findEsptool(force));
ipcMain.handle('esptool:install', async () => {
  const py = await which('python') || await which('py');
  if (!py) return { ok: false, error: 'nopython' };
  esptoolCache = null;
  return { ok: true, ...startJob({ exe: py, args: ['-m', 'pip', 'install', '--upgrade', 'esptool'], label: 'esptool-install', onExit: async () => { await findEsptool(true); return {}; } }) };
});
ipcMain.handle('esptool:run', async (_e, req) => {
  const t = await findEsptool();
  if (!t.exe) return { ok: false, error: 'noesptool' };
  const v5 = t.major >= 5;
  const name = n => (v5 ? n : n.replace(/-/g, '_'));
  const g = ['--chip', req.chip || 'auto', '--port', req.port, '--baud', String(req.baud || 460800)];
  let args;
  switch (req.action) {
    case 'flash': {
      args = [...g, name('write-flash')];
      if (req.eraseAll) args.push(v5 ? '--erase-all' : '--erase-all');
      for (const f of req.files) args.push(f.offset, f.path);
      break;
    }
    case 'backup': {
      let size = req.size || 'ALL';
      if (size === 'ALL' && !v5) size = '0x400000';
      args = [...g, name('read-flash'), '0', size, req.out];
      break;
    }
    case 'erase': args = [...g, name('erase-flash')]; break;
    case 'info': args = [...g, name('flash-id')]; break;
    default: return { ok: false, error: 'bad action' };
  }
  const job = startJob({
    exe: t.exe, args: [...t.pre, ...args], label: 'esptool-' + req.action, usesPort: true,
    onExit: (code, out) => {
      const chip = (out.match(/Chip (?:is|type:)\s*(ESP[\w-]+)/i) || [])[1];
      const flash = (out.match(/Detected flash size:\s*(\S+)/i) || [])[1];
      return { chip, flash };
    },
  });
  return { ok: true, ...job };
});
// Read an ESP partition table from partitions.bin, or from a full image/backup (table at 0x8000).
ipcMain.handle('partitions:parse', (_e, file) => {
  const TYPES = { 0: 'app', 1: 'data' };
  const APP_SUB = { 0x00: 'factory', 0x20: 'test' };
  const DATA_SUB = { 0x00: 'ota', 0x01: 'phy', 0x02: 'nvs', 0x03: 'coredump', 0x04: 'nvs_keys', 0x05: 'efuse', 0x06: 'undefined', 0x80: 'esphttpd', 0x81: 'fat', 0x82: 'spiffs', 0x83: 'littlefs' };
  try {
    const buf = fs.readFileSync(file);
    let base = 0;
    if (!(buf[0] === 0xAA && buf[1] === 0x50)) {
      if (buf.length > 0x8000 + 32 && buf[0x8000] === 0xAA && buf[0x8001] === 0x50) base = 0x8000;
      else return { ok: false, error: 'no partition table' };
    }
    const parts = [];
    for (let o = base; o + 32 <= buf.length && o < base + 0xC00; o += 32) {
      if (buf[o] !== 0xAA || buf[o + 1] !== 0x50) break;
      const type = buf[o + 2], sub = buf[o + 3];
      parts.push({
        label: buf.slice(o + 12, o + 28).toString('latin1').replace(/\0.*$/s, ''),
        type: TYPES[type] || '0x' + type.toString(16),
        subtype: type === 0 ? (APP_SUB[sub] || (sub >= 0x10 && sub < 0x20 ? 'ota_' + (sub - 0x10) : '0x' + sub.toString(16))) : (DATA_SUB[sub] || '0x' + sub.toString(16)),
        offset: buf.readUInt32LE(o + 4), size: buf.readUInt32LE(o + 8),
        encrypted: !!(buf.readUInt32LE(o + 28) & 1),
      });
    }
    return { ok: true, parts, fromImage: base === 0x8000 };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('file:size',(_e, p) => { try { return fs.statSync(p).size; } catch { return 0; } });

// HTTP OTA: the PC sends the .bin to the board (outgoing connection, so Windows Firewall does not block it).
// Works with sketches that use HTTPUpdateServer (ESP32) / ESP8266HTTPUpdateServer on /update.
// The host is typed by the user and ends up inside a cmd.exe line; only allow plain hostnames/IPs.
function validHost(h) {
  if (typeof h !== 'string' || !h || h.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h.split('.').every(x => +x <= 255);
  if (/^\[[0-9A-Fa-f:.]+\]$/.test(h)) return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(h);
}
ipcMain.handle('ota:probeHttp', async (_e, host) => {
  if (!validHost(host)) return false;
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 2500);
  try { const r = await fetch(`http://${host}/update`, { signal: ac.signal }); return r.status === 200 || r.status === 401; }
  catch { return false; } finally { clearTimeout(tm); }
});
ipcMain.handle('ota:http', (_e, { host, file, user, password }) => {
  if (!validHost(host)) return { ok: false, error: 'badhost' };
  // Newer HTTPUpdateServer rejects uploads whose Origin is not http://<host> (CSRF check).
  const args = ['--fail', '--show-error', '--progress-bar', '-o', 'NUL', '-H', 'Expect:', '-H', `Origin: http://${host}`, '-F', `update=@${file}`];
  if (password) args.push('-u', `${user || 'admin'}:${password}`);
  args.push(`http://${host}/update`);
  return startJob({ exe: 'curl.exe', args, label: 'OTA (HTTP) ' + host });
});

// OTA needs the board to connect back to the PC; Windows Firewall blocks espota.exe on Public networks.
// This only runs when the user clicks the button, and Windows asks for admin approval (UAC).
ipcMain.handle('ota:allowFirewall', () => {
  const found = [];
  try {
    for (const pkg of fs.readdirSync(path.join(ARDUINO_DATA, 'packages'))) {
      const hw = path.join(ARDUINO_DATA, 'packages', pkg, 'hardware');
      if (!fs.existsSync(hw)) continue;
      for (const arch of fs.readdirSync(hw)) for (const ver of fs.readdirSync(path.join(hw, arch))) {
        const exe = path.join(hw, arch, ver, 'tools', 'espota.exe');
        if (fs.existsSync(exe)) found.push(exe);
      }
    }
  } catch {}
  if (!found.length) return { ok: false, error: 'espota.exe not found' };
  const cmds = found.map(p => `netsh advfirewall firewall add rule name="esppro OTA (espota)" dir=in action=allow program="${p}" enable=yes profile=any`).join(' & ');
  const ps = `Start-Process cmd.exe -Verb RunAs -ArgumentList '/c ${cmds.replace(/'/g, "''")}'`;
  spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, detached: true });
  return { ok: true, paths: found };
});

// ---------- windows tools ----------
ipcMain.handle('win:deviceManager', () => { spawn('cmd.exe', ['/d', '/c', 'start', '""', 'devmgmt.msc'], { detached: true, windowsHide: true }); return true; });
ipcMain.handle('drivers:scan', () => new Promise(resolve => {
  const ps = "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_' } | Select-Object Status,Class,FriendlyName,InstanceId | ConvertTo-Json -Compress";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000, maxBuffer: 8e6 }, (e, out) => {
    let list = [];
    try { list = JSON.parse(out); if (!Array.isArray(list)) list = [list]; } catch {}
    const known = JSON.parse(fs.readFileSync(path.join(DATA, 'drivers.json'), 'utf8'));
    const seen = new Set();
    const result = [];
    for (const d of list) {
      const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(d.InstanceId || '');
      if (!m) continue;
      const vid = m[1].toUpperCase(), pid = m[2].toUpperCase();
      const k = known.find(x => x.vid === vid && (!x.pid || x.pid.includes(pid)));
      const isPort = d.Class === 'Ports';
      if (!k && !(isPort || (d.Status !== 'OK' && /USB|Other|Unknown/i.test(d.Class || 'Other')))) continue;
      // One row per physical device: prefer the COM-port entry, keep problem entries.
      const key = vid + pid + (d.Status === 'OK' ? '' : d.InstanceId);
      if (seen.has(key)) { const prev = result.find(r => r.vid === vid && r.pid === pid && r.status === 'OK'); if (prev && isPort && d.Status === 'OK') prev.name = d.FriendlyName; continue; }
      seen.add(key);
      result.push({ name: d.FriendlyName, status: d.Status, cls: d.Class, vid, pid, chip: k ? k.chip : null, url: k ? k.url : null, builtin: k ? !!k.builtin : false });
    }
    resolve(result);
  });
}));
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('open:path', (_e, p) => shell.openPath(p));
ipcMain.handle('open:showItem', (_e, p) => shell.showItemInFolder(p));

// ---------- dialogs ----------
ipcMain.handle('dialog:openBins', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Firmware', extensions: ['bin'] }], properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths.map(p => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }));
});
ipcMain.handle('dialog:saveFile', async (_e, { defaultName, ext }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), defaultName), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:chooseDir', async (_e, def) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: def || app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('file:writeText', (_e, { file, content }) => { fs.writeFileSync(file, content, 'utf8'); return true; });
ipcMain.handle('file:saveText', async (_e, { defaultName, content }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), defaultName), filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'All', extensions: ['*'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});
ipcMain.handle('file:openText', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Text', extensions: ['txt', 'ino', 'h', 'cpp', 'c', 'md'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  return { path: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8') };
});

// ---------- app settings / i18n ----------
ipcMain.handle('settings:get', () => ({ ...settings, systemLocale: app.getLocale(), userData: USER(), portable: fs.existsSync(portableDir), cli: findCli() }));
ipcMain.handle('settings:set', (_e, patch) => {
  Object.assign(settings, patch);
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  saveSettings();
  return true;
});
ipcMain.handle('i18n:load', (_e, lang) => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n', lang + '.json'), 'utf8')); } catch { return {}; }
});
ipcMain.handle('data:errors', () => JSON.parse(fs.readFileSync(path.join(DATA, 'errors.json'), 'utf8')));

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 900, minHeight: 600,
    title: 'esppro', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d22' : '#f6f7f9',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Developer self-check: ESPPRO_SHOT=out.png saves a screenshot and prints console messages.
  if (process.env.ESPPRO_SHOT) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message));
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      if (process.env.ESPPRO_JS) { try { console.log('[js]', await win.webContents.executeJavaScript(process.env.ESPPRO_JS)); } catch (err) { console.log('[js-err]', err.message); } await new Promise(r => setTimeout(r, 2500)); }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.ESPPRO_SHOT, img.toPNG());
      win.__allowClose = true; app.quit();
    }, Number(process.env.ESPPRO_WAIT || 5000)));
  }
  win.on('close', e => {
    if (win.__allowClose) return;
    e.preventDefault();
    win.webContents.send('app:beforeClose');
  });
}
ipcMain.handle('app:close', () => { win.__allowClose = true; win.close(); });
ipcMain.handle('app:devtools', () => win.webContents.toggleDevTools());

app.on('web-contents-created', (_e, contents) => {
  // Side browser: no node, no preload, links open inside the panel only.
  contents.on('will-attach-webview', (_ev, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
  contents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
});

app.whenReady().then(() => {
  loadSettings();
  nativeTheme.themeSource = settings.theme;
  writeCliConfig();
  createWindow();
});
app.on('window-all-closed', () => { closeSerial(); app.quit(); });

/* esppro — renderer */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  settings: null, dict: {}, lang: 'en', errors: [],
  sketch: null, active: 0, editor: null, monaco: null,
  fqbn: '', boardLabel: '', boards: null, boardOptions: {}, boardDetails: {},
  port: '', ports: [],
  job: null, lastCmd: '', jobOut: '', lastExport: null,
  serialOpen: false, ips: new Set(), serialAtLineStart: true, serialLog: [],
  bins: [], esptool: null, notepadDirty: false,
};
const t = k => S.dict[k] ?? k;

// ---------------- i18n + theme ----------------
async function applyLanguage() {
  const pref = S.settings.language;
  S.lang = pref === 'system' ? (S.settings.systemLocale.toLowerCase().startsWith('ar') ? 'ar' : 'en') : pref;
  S.dict = { ...(await esp.i18nLoad('en')), ...(S.lang === 'en' ? {} : await esp.i18nLoad(S.lang)) };
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  $$('[data-i18n]').forEach(e => { e.textContent = t(e.dataset.i18n); });
  $$('[data-i18n-title]').forEach(e => { e.title = t(e.dataset.i18nTitle); });
  $$('[data-i18n-ph]').forEach(e => { e.placeholder = t(e.dataset.i18nPh); });
  $('#stLang').textContent = S.lang.toUpperCase();
  if (!S.fqbn) $('#boardName').textContent = t('selectBoard');
  else $('#stBoard').textContent = `${t('board')}: ${S.boardLabel}`;
  renderPorts(); renderBins(); updateSerialBtn();
}
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyMonacoTheme() {
  if (S.monaco) S.monaco.editor.setTheme(darkQuery.matches ? 'vs-dark' : 'vs');
  const ti = document.getElementById('themeIcon');
  if (ti) ti.innerHTML = icon(darkQuery.matches ? 'sun' : 'moon'); // shows the theme you will switch to
}
darkQuery.addEventListener('change', applyMonacoTheme);

function paintIcons(root = document) { $$('i[data-icon]', root).forEach(i => { i.innerHTML = icon(i.dataset.icon); }); }

// ---------------- toasts + modal ----------------
function toast(html, kind = '', ms = 4500) {
  const d = document.createElement('div');
  d.className = 'toast ' + kind; d.innerHTML = html;
  $('#toasts').appendChild(d);
  if (ms) setTimeout(() => d.remove(), ms);
  return d;
}
function modal(html, onMount) {
  $('#modal').innerHTML = html;
  $('#modalBack').classList.remove('hidden');
  paintIcons($('#modal'));
  if (onMount) onMount($('#modal'));
}
function closeModal() { $('#modalBack').classList.add('hidden'); $('#modal').innerHTML = ''; }
function confirmBox(text, buttons) {
  return new Promise(res => {
    modal(`<p style="font-size:14px">${esc(text)}</p><div class="actions">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`, m => {
      $$('button[data-i]', m).forEach(b => b.onclick = () => { closeModal(); res(buttons[+b.dataset.i].value); });
    });
  });
}

// ---------------- editor ----------------
const ARDUINO_API = [
  ['pinMode', 'pinMode(${1:pin}, ${2|OUTPUT,INPUT,INPUT_PULLUP|});'], ['digitalWrite', 'digitalWrite(${1:pin}, ${2|HIGH,LOW|});'],
  ['digitalRead', 'digitalRead(${1:pin})'], ['analogRead', 'analogRead(${1:pin})'], ['analogWrite', 'analogWrite(${1:pin}, ${2:value});'],
  ['delay', 'delay(${1:ms});'], ['delayMicroseconds', 'delayMicroseconds(${1:us});'], ['millis', 'millis()'], ['micros', 'micros()'],
  ['Serial.begin', 'Serial.begin(${1:115200});'], ['Serial.println', 'Serial.println(${1});'], ['Serial.print', 'Serial.print(${1});'],
  ['Serial.available', 'Serial.available()'], ['Serial.read', 'Serial.read()'], ['Serial.readStringUntil', "Serial.readStringUntil('\\n')"],
  ['attachInterrupt', 'attachInterrupt(digitalPinToInterrupt(${1:pin}), ${2:isr}, ${3|RISING,FALLING,CHANGE|});'],
  ['map', 'map(${1:value}, ${2:fromLow}, ${3:fromHigh}, ${4:toLow}, ${5:toHigh})'], ['constrain', 'constrain(${1:x}, ${2:a}, ${3:b})'],
  ['WiFi.begin', 'WiFi.begin(${1:ssid}, ${2:password});'], ['WiFi.localIP', 'WiFi.localIP()'], ['WiFi.status', 'WiFi.status()'],
  ['WiFi.softAP', 'WiFi.softAP(${1:ssid}, ${2:password});'], ['WiFi.mode', 'WiFi.mode(${1|WIFI_STA,WIFI_AP,WIFI_AP_STA|});'],
  ['setup/loop', 'void setup() {\n\tSerial.begin(115200);\n\t$0\n}\n\nvoid loop() {\n\n}'],
  ['wifi-connect', '#include <WiFi.h>\n\nconst char* ssid = "${1:SSID}";\nconst char* password = "${2:PASSWORD}";\n\nvoid setup() {\n\tSerial.begin(115200);\n\tWiFi.begin(ssid, password);\n\twhile (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }\n\tSerial.println();\n\tSerial.print("IP address: ");\n\tSerial.println(WiFi.localIP());\n}\n\nvoid loop() {\n$0\n}'],
  ['http-ota', '#include <WiFi.h>\n#include <WebServer.h>\n#include <HTTPUpdateServer.h>\n\nWebServer server(80);\nHTTPUpdateServer httpUpdater;\n\n// in setup(), after WiFi connects:\n//   httpUpdater.setup(&server);                 // OTA page at http://IP/update\n//   // httpUpdater.setup(&server, "/update", "admin", "password"); // with password\n//   server.begin();\n// in loop(): server.handleClient();\n'],
  ['webserver','#include <WiFi.h>\n#include <WebServer.h>\n\nWebServer server(80);\n\nvoid handleRoot() {\n\tserver.send(200, "text/html", "<h1>Hello from ESP</h1>");\n}\n\n// in setup(): server.on("/", handleRoot); server.begin();\n// in loop():  server.handleClient();\n'],
];
const ARDUINO_WORDS = ['HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP', 'LED_BUILTIN', 'String', 'byte', 'boolean', 'uint8_t', 'uint16_t', 'uint32_t', 'int16_t', 'int32_t', 'WL_CONNECTED'];

function initMonaco() {
  return new Promise(res => {
    window.MonacoEnvironment = { getWorkerUrl: () => new URL('../../node_modules/monaco-editor/min/vs/base/worker/workerMain.js', location.href).href };
    require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
    require(['vs/editor/editor.main'], () => {
      S.monaco = window.monaco;
      const m = S.monaco;
      m.languages.registerCompletionItemProvider('cpp', {
        provideCompletionItems: (model, pos) => {
          const w = model.getWordUntilPosition(pos);
          const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
          return {
            suggestions: [
              ...ARDUINO_API.map(([label, snip]) => ({ label, kind: m.languages.CompletionItemKind.Function, insertText: snip, insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet, range })),
              ...ARDUINO_WORDS.map(label => ({ label, kind: m.languages.CompletionItemKind.Constant, insertText: label, range })),
            ],
          };
        },
      });
      S.editor = m.editor.create($('#editor'), {
        language: 'cpp', automaticLayout: true, fontSize: S.settings.fontSize, fontFamily: 'Cascadia Mono, Consolas, monospace',
        minimap: { enabled: true }, scrollBeyondLastLine: false, tabSize: 2, renderWhitespace: 'selection', wordBasedSuggestions: 'currentDocument',
        theme: darkQuery.matches ? 'vs-dark' : 'vs',
      });
      S.editor.onDidChangeCursorPosition(e => { $('#stCursor').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
      res();
    });
  });
}
function langFor(name) { return /\.(ino|h|hpp|c|cpp)$/i.test(name) ? 'cpp' : /\.S$/.test(name) ? 'cpp' : 'plaintext'; }

function loadSketch(sk) {
  if (S.sketch) S.sketch.files.forEach(f => f.model && f.model.dispose());
  S.sketch = sk;
  sk.files.forEach(f => {
    f.model = S.monaco.editor.createModel(f.content, langFor(f.name));
    f.saved = f.content;
    f.model.onDidChangeContent(() => { renderTabs(); renderFiles(); });
  });
  S.active = 0;
  S.editor.setModel(sk.files[0].model);
  renderTabs(); renderFiles(); renderRecent();
  document.title = `${sk.name} — esppro`;
}
const isDirty = f => f.model && f.model.getValue() !== f.saved;
const anyDirty = () => S.sketch && S.sketch.files.some(isDirty);
function setActive(i) { S.active = i; S.editor.setModel(S.sketch.files[i].model); S.editor.focus(); renderTabs(); renderFiles(); }
function renderTabs() {
  $('#tabs').innerHTML = S.sketch.files.map((f, i) => `<div class="tab ${i === S.active ? 'active' : ''}" data-i="${i}">${esc(f.name)}${isDirty(f) ? '<span class="dirty"></span>' : ''}</div>`).join('');
  $$('#tabs .tab').forEach(el => el.onclick = () => setActive(+el.dataset.i));
}
function renderFiles() {
  $('#sketchName').textContent = S.sketch.name + (S.sketch.untitled ? ' *' : '');
  const main = S.sketch.name + '.ino';
  $('#fileList').innerHTML = S.sketch.files.map((f, i) => `<li class="${i === S.active ? 'active' : ''}" data-i="${i}">${icon('file')}<span dir="ltr" class="grow">${esc(f.name)}</span>${isDirty(f) ? '<span class="dot ok"></span>' : ''}${f.name === main ? '' : `<button class="btn icon mini" data-ren="${i}" title="${esc(t('rename'))}">${icon('edit')}</button><button class="btn icon mini" data-del="${i}" title="${esc(t('deleteFile'))}">${icon('trash')}</button>`}</li>`).join('');
  $$('#fileList li').forEach(el => el.onclick = () => setActive(+el.dataset.i));
  $$('#fileList [data-del]').forEach(b => b.onclick = e => { e.stopPropagation(); deleteFile(+b.dataset.del); });
  $$('#fileList [data-ren]').forEach(b => b.onclick = e => { e.stopPropagation(); renameFile(+b.dataset.ren); });
}
async function deleteFile(i) {
  const f = S.sketch.files[i];
  const ok = await confirmBox(`${t('deleteFile')}: ${f.name}? (${t('toRecycle')})`, [{ label: t('deleteFile'), value: true, cls: 'danger' }, { label: t('cancel'), value: false }]);
  if (!ok) return;
  if (!(await esp.sketchDeleteFile({ dir: S.sketch.dir, name: f.name }))) { toast(t('failed'), 'err'); return; }
  const wasActive = S.active === i;
  S.sketch.files.splice(i, 1);
  setActive(wasActive ? 0 : S.active > i ? S.active - 1 : S.active); // switch away before disposing the model
  setTimeout(() => f.model.dispose(), 0);
}
async function renameFile(i) {
  const f = S.sketch.files[i];
  const to = (await askText(t('rename'), f.name, f.name) || '').replace(/[\\/:*?"<>|]/g, '');
  if (!to || to === f.name) return;
  await saveSketch(false);
  if (!(await esp.sketchRenameFile({ dir: S.sketch.dir, from: f.name, to }))) { toast(t('failed'), 'err'); return; }
  f.name = to; S.monaco.editor.setModelLanguage(f.model, langFor(to));
  renderTabs(); renderFiles();
}
function renderRecent() {
  $('#recentList').innerHTML = (S.settings.recent || []).map(d => `<li title="${esc(d)}" data-d="${esc(d)}">${esc(d)}</li>`).join('');
  $$('#recentList li').forEach(el => el.onclick = async () => { const sk = await esp.sketchOpen(el.dataset.d); if (sk) loadSketch(sk); });
}
function currentFiles() { return S.sketch.files.map(f => ({ name: f.name, content: f.model.getValue() })); }
async function saveSketch(force) {
  if (S.sketch.untitled && force) return saveAs();
  await esp.sketchSave({ dir: S.sketch.dir, files: currentFiles() });
  S.sketch.files.forEach(f => { f.saved = f.model.getValue(); });
  renderTabs(); renderFiles();
  return true;
}
async function saveAs() {
  const sk = await esp.sketchSaveAs({ name: S.sketch.name, files: currentFiles() });
  if (!sk) return false;
  loadSketch(sk);
  S.settings = await esp.settingsGet(); renderRecent();
  toast(t('saved'), 'ok');
  return true;
}

// ---------------- output / jobs ----------------
function outAppend(text, cls) {
  const pre = $('#output');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  pre.appendChild(span);
  while (pre.childNodes.length > 4000) pre.removeChild(pre.firstChild);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
function showBottom(tab) {
  $$('.bottom-tabs [data-btab]').forEach(b => b.classList.toggle('active', b.dataset.btab === tab));
  $$('.btab').forEach(b => b.classList.toggle('hidden', b.dataset.btab !== tab));
}
function beginJob(job, label) {
  S.job = { id: job.id, label }; S.lastCmd = job.line; S.jobOut = '';
  $('#hints').innerHTML = '';
  $('#btnStop').classList.remove('hidden');
  $('#jobState').textContent = t('compiling');
  ['#btnVerify', '#btnUpload', '#btnExport', '#btnFlash', '#btnBackup', '#btnErase'].forEach(s => { $(s).disabled = true; });
  showBottom('output');
}
esp.onJobOut(({ id, text, kind }) => {
  if (kind === 'cmd') { outAppend('\n' + text, 'cmd'); return; }
  if (S.job && S.job.id === id) S.jobOut += text;
  outAppend(text, /error|fatal|failed/i.test(text) ? 'err' : '');
});
const jobWaiters = new Map();
esp.onJobExit(p => {
  const ok = p.code === 0;
  outAppend(`\n— ${ok ? t('done') : t('failed')} (exit ${p.code}) · ${(p.seconds || 0).toFixed(1)}s\n`, ok ? 'cmd' : 'err');
  // After a successful upload/flash over USB, open the Serial Monitor by itself so its output (and IP) shows up.
  if (ok && /^(upload|esptool-flash)$/.test(p.label || '') && S.settings.autoSerial !== false && S.port && !S.port.startsWith('ota:')) autoOpenSerial();
  if (S.job && S.job.id === p.id) {
    $('#btnStop').classList.add('hidden');
    $('#jobState').textContent = ok ? t('done') : t('failed');
    ['#btnVerify', '#btnUpload', '#btnExport', '#btnFlash', '#btnBackup', '#btnErase'].forEach(s => { $(s).disabled = false; });
    if (!ok) explainErrors(S.jobOut);
    S.job = null;
  }
  if (p.chip) {
    $('#chipInfo').textContent = `${p.chip}${p.flash ? ' · ' + p.flash : ''}`;
    // Select the detected chip so offsets and commands match it.
    const id = p.chip.toLowerCase().replace(/-/g, '');
    if ([...$('#espChip').options].some(o => o.value === id) && $('#espChip').value !== id) { $('#espChip').value = id; $('#espChip').onchange(); }
  }
  if (p.bins) onExported(p);
  const w = jobWaiters.get(p.id); if (w) { jobWaiters.delete(p.id); w(p); }
  toast(`<b>${esc(p.label || '')}</b> — ${ok ? t('done') : t('failed')}`, ok ? 'ok' : 'err', 3000);
});
const waitJob = id => new Promise(r => jobWaiters.set(id, r));
async function autoOpenSerial() {
  // Native-USB boards (C3/S3) re-appear a moment after reset, so retry for a few seconds.
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, i ? 700 : 1200));
    if (S.serialOpen) break;
    if (!S.ports.some(p => p.path === S.port)) continue;
    const r = await esp.serialOpen({ path: S.port, baud: +$('#serialBaud').value });
    if (r.ok) break;
  }
  if (S.serialOpen && $('.btab[data-btab=plotter]').classList.contains('hidden')) showBottom('serial');
}

function explainErrors(out) {
  const seen = new Set();
  for (const e of S.errors) {
    const m = new RegExp(e.re, 'i').exec(out);
    if (!m || seen.has(e.key)) continue;
    seen.add(e.key);
    const div = document.createElement('div');
    div.className = 'hint';
    div.innerHTML = `<b>${esc(t('hint'))}:</b> ${esc(t(e.key))}${m[1] ? ` <code dir="ltr">${esc(m[1])}</code>` : ''}`;
    if (e.key === 'err.missinglib' && m[1]) {
      const b = document.createElement('div'); b.className = 'row';
      b.innerHTML = `<button class="btn small">${esc(t('libraryManager'))}: ${esc(m[1].replace(/\.h$/, ''))}</button>`;
      b.querySelector('button').onclick = () => { showView('libs'); $('#libQ').value = m[1].replace(/\.h$/, ''); searchLibs(); };
      div.appendChild(b);
    }
    if (e.key === 'err.otafw') {
      const b = document.createElement('div'); b.className = 'row';
      b.innerHTML = `<button class="btn small primary">${esc(t('allowFirewall'))}</button>`;
      b.querySelector('button').onclick = async () => { const r = await esp.otaAllowFirewall(); toast(r.ok ? t('firewallAsked') : esc(r.error), r.ok ? 'ok' : 'err', 7000); };
      div.appendChild(b);
    }
    if (e.key === 'err.toobig') {
      const b = document.createElement('div'); b.className = 'row';
      b.innerHTML = `<button class="btn small">${esc(t('boardOptions'))}</button>`;
      b.querySelector('button').onclick = openBoardOptions;
      div.appendChild(b);
    }
    $('#hints').appendChild(div);
  }
}

// ---------------- boards + ports ----------------
function effectiveFqbn() {
  const opts = S.boardOptions[S.fqbn] || {};
  const parts = Object.entries(opts).map(([k, v]) => `${k}=${v}`);
  return parts.length ? `${S.fqbn}:${parts.join(',')}` : S.fqbn;
}
function setBoard(fqbn, name) {
  S.fqbn = fqbn; S.boardLabel = name;
  $('#boardName').textContent = name || fqbn || t('selectBoard');
  $('#stBoard').textContent = name ? `${t('board')}: ${name}` : '';
  esp.settingsSet({ lastFqbn: fqbn, lastBoardName: name });
}
async function loadBoards(force) {
  if (S.boards && !force) return S.boards;
  const r = await esp.boardsListall();
  S.boards = (r.ok && r.data.boards) ? r.data.boards.map(b => ({ name: b.name, fqbn: b.fqbn, pkg: b.platform?.release?.name || b.platform?.metadata?.id || '' })) : [];
  S.boards.sort((a, b) => a.name.localeCompare(b.name));
  return S.boards;
}
async function openBoardPicker() {
  modal(`<h2>${esc(t('selectBoard'))}</h2><input id="bq" style="width:100%" placeholder="${esc(t('search'))}" dir="ltr"><ul class="list boards" id="bl"><li class="muted">${esc(t('compiling'))}</li></ul><div class="actions"><button class="btn" id="bclose">${esc(t('close'))}</button></div>`, async m => {
    $('#bclose', m).onclick = closeModal;
    const boards = await loadBoards();
    const draw = () => {
      const q = $('#bq', m).value.toLowerCase();
      const list = boards.filter(b => !q || b.name.toLowerCase().includes(q) || b.fqbn.includes(q)).slice(0, 300);
      $('#bl', m).innerHTML = list.length ? list.map(b => `<li data-f="${esc(b.fqbn)}" data-n="${esc(b.name)}" class="${b.fqbn === S.fqbn ? 'active' : ''}"><span>${esc(b.name)}</span><small>${esc(b.fqbn)}</small></li>`).join('') : `<li class="muted">— ${esc(t('boardsManager'))} —</li>`;
      $$('#bl li[data-f]', m).forEach(li => li.onclick = () => { setBoard(li.dataset.f, li.dataset.n); closeModal(); });
    };
    $('#bq', m).oninput = draw; draw(); $('#bq', m).focus();
  });
}
async function openBoardOptions() {
  if (!S.fqbn) return openBoardPicker();
  modal(`<h2>${esc(t('boardOptions'))}</h2><p class="muted" dir="ltr">${esc(S.fqbn)}</p><div id="bo">${esc(t('compiling'))}</div><div class="actions"><button class="btn primary" id="boOk">${esc(t('save'))}</button><button class="btn" id="boCancel">${esc(t('cancel'))}</button></div>`, async m => {
    $('#boCancel', m).onclick = closeModal;
    const r = await esp.boardsDetails(S.fqbn);
    const opts = (r.ok && r.data.config_options) || [];
    const chosen = S.boardOptions[S.fqbn] || {};
    $('#bo', m).innerHTML = opts.length ? `<div class="grid2">${opts.map(o => `<label><span dir="ltr">${esc(o.option_label)}</span><select data-o="${esc(o.option)}">${o.values.map(v => `<option value="${esc(v.value)}" ${(chosen[o.option] ? chosen[o.option] === v.value : v.selected) ? 'selected' : ''}>${esc(v.value_label)}</option>`).join('')}</select></label>`).join('')}</div>` : '—';
    $('#boOk', m).onclick = () => {
      const sel = {};
      $$('select[data-o]', m).forEach(s => {
        const o = opts.find(x => x.option === s.dataset.o);
        const def = (o.values.find(v => v.selected) || o.values[0]).value;
        if (s.value !== def) sel[s.dataset.o] = s.value;
      });
      S.boardOptions[S.fqbn] = sel;
      esp.settingsSet({ boardOptions: S.boardOptions });
      closeModal();
    };
  });
}
function renderPorts() {
  const sel = $('#portSel');
  if (!sel) return;
  const cur = S.port;
  sel.innerHTML = S.ports.length
    ? S.ports.map(p => `<option value="${esc(p.path)}" ${p.path === cur ? 'selected' : ''}>${esc(p.path)}${p.friendlyName || p.manufacturer ? ' — ' + esc((p.friendlyName || p.manufacturer).replace(/\s*\(COM\d+\)/, '')) : ''}</option>`).join('')
    : `<option value="">${esc(t('noPort'))}</option>`;
  if (typeof otaOptionsHtml === 'function') sel.insertAdjacentHTML('beforeend', otaOptionsHtml());
  $('#stPort').textContent = S.port ? `${t('port')}: ${S.port}` : '';
}
async function pollPorts() {
  const list = (await esp.portsList()).filter(p => p.path);
  const sig = list.map(p => p.path).join();
  if (sig !== S.ports.map(p => p.path).join()) {
    const prev = S.port;
    const added = list.find(p => !S.ports.some(o => o.path === p.path));
    S.ports = list;
    if (S.port.startsWith('ota:')) { /* keep a chosen WiFi target */ }
    else if (!S.port || !list.some(p => p.path === S.port)) S.port = (added || list[0] || {}).path || '';
    else if (added && S.ports.length > 1) S.port = added.path; // a newly plugged board is usually the one you want
    renderPorts();
    esp.settingsSet({ lastPort: S.port });
    if (S.port !== prev || !list.some(p => p.path === prev)) serialUserOff = false;
    maybeAutoConnect();
  }
}

// ---------------- build actions ----------------
async function build(kind) {
  if (!S.fqbn) { await openBoardPicker(); if (!S.fqbn) return; }
  if ((kind === 'upload') && !S.port) { toast(t('needPort'), 'err'); return; }
  if (kind === 'upload' && S.port.startsWith('ota:')) return otaUpload();
  await saveSketch(false);
  let exportFile, exportDir;
  if (kind === 'export') {
    // One complete image (bootloader + partitions + app), like a backup. Settings can switch to "all files".
    if (S.settings.exportAll) { exportDir = await esp.dialogChooseDir(); if (!exportDir) return; }
    else {
      const board = (S.fqbn.split(':')[2] || 'board');
      exportFile = await esp.dialogSaveFile({ defaultName: `${S.sketch.name}_${board}_full.bin`, ext: 'bin' });
      if (!exportFile) return;
    }
  }
  const job = await esp.buildRun({ dir: S.sketch.dir, fqbn: effectiveFqbn(), port: S.port, upload: kind === 'upload', exportDir, exportFile });
  beginJob(job, kind);
}
function onExported(p) {
  S.lastExport = p.bins;
  const div = document.createElement('div');
  div.className = 'hint';
  div.innerHTML = `<b>${esc(t('exportDone'))}:</b><div dir="ltr" style="font-family:var(--mono);font-size:12px">${p.bins.map(b => `${esc(b.name)} (${(b.size / 1024).toFixed(1)} KB)`).join('<br>')}</div><div class="row"><button class="btn small primary" data-a="flash">${esc(t(p.full ? 'flashThis' : 'flashThese'))}</button><button class="btn small" data-a="open">${esc(t('openFolder'))}</button></div>`;
  div.querySelector('[data-a=flash]').onclick = () => { loadExportedIntoEsp(); showView('esp'); };
  div.querySelector('[data-a=open]').onclick = () => esp.openPath(p.exportDir);
  $('#hints').appendChild(div);
}

// ---------------- serial monitor ----------------
const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000];
function updateSerialBtn() { const b = $('#btnSerialConn'); if (b) { b.textContent = S.serialOpen ? t('disconnect') : t('connect'); b.classList.toggle('primary', !S.serialOpen); } }
async function toggleSerial() {
  if (S.serialOpen) { serialUserOff = true; await esp.serialClose(); return; }
  serialUserOff = false;
  if (!S.port) { toast(t('needPort'), 'err'); return; }
  const r = await esp.serialOpen({ path: S.port, baud: +$('#serialBaud').value });
  if (!r.ok) { toast(esc(r.error), 'err'); explainErrors(r.error); }
}
let serialUserOff = false;
async function maybeAutoConnect() {
  if (S.settings.autoConnect === false || serialUserOff || S.serialOpen || S.job) return;
  if (!S.port || S.port.startsWith('ota:') || !S.ports.some(p => p.path === S.port)) return;
  const r = await esp.serialOpen({ path: S.port, baud: +$('#serialBaud').value });
  if (r.ok && $('.btab[data-btab=plotter]').classList.contains('hidden')) showBottom('serial');
}
esp.onSerialState(s => {
  S.serialOpen = !!s.open; updateSerialBtn();
  if (s.error) serialAppend(`\n[${s.error}]\n`, true);
  if (s.open) armSilenceHint(); else hideSerialHint();
});
const IP_RE = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b|\b([a-z0-9-]+\.local)\b/gi;
let serialLineBuf = '';
function scanIps(text) {
  serialLineBuf += text;
  const lines = serialLineBuf.split(/\r?\n/);
  serialLineBuf = lines.pop().slice(-300);
  for (const line of lines) {
    if (/mask|subnet|gateway|\bgw\b|dns|broadcast/i.test(line)) continue;
    for (const m of line.matchAll(IP_RE)) {
      const ip = m[1] || m[2];
      if (!ip || /^(0\.|255\.|127\.)/.test(ip) || ip.startsWith('224.')) continue;
      if (!S.ips.has(ip)) { S.ips.add(ip); onNewIp(ip); }
    }
  }
}
function onNewIp(ip) {
  $('#ipBadge').textContent = S.ips.size; $('#ipBadge').classList.remove('hidden');
  renderIpChips();
  const d = toast(`<b>${esc(t('ipFound'))}</b><div dir="ltr" style="font-family:var(--mono)">http://${esc(ip)}</div><div class="row"><button class="btn small primary">${esc(t('browser'))}</button></div>`, 'ok', 9000);
  d.querySelector('button').onclick = () => { openBrowser('http://' + ip); d.remove(); };
}
function two(n, l = 2) { return String(n).padStart(l, '0'); }
function nowTs() { const d = new Date(); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${two(d.getMilliseconds(), 3)}`; }
function serialAppend(text, isErr) {
  const pre = $('#serialOut');
  const auto = $('#serialAuto').checked;
  const frag = document.createDocumentFragment();
  const ts = $('#serialTs').checked;
  let logText = '';
  const parts = text.split(/(\n)/);
  for (const part of parts) {
    if (!part) continue;
    if (ts && S.serialAtLineStart && part !== '\n') {
      const s = document.createElement('span'); s.className = 'ts'; s.textContent = `${nowTs()} → `; frag.appendChild(s); logText += s.textContent;
    }
    const s = document.createElement('span'); if (isErr) s.className = 'err'; s.textContent = part; frag.appendChild(s); logText += part;
    S.serialAtLineStart = part === '\n';
  }
  pre.appendChild(frag);
  S.serialLog.push(logText);
  if (S.serialLog.length > 20000) S.serialLog.splice(0, 5000);
  while (pre.childNodes.length > 6000) pre.removeChild(pre.firstChild);
  if (auto) pre.scrollTop = pre.scrollHeight;
}
esp.onSerialData(text => { serialAppend(text); scanIps(text); hideSerialHint(); });

// ---------------- serial silence / CDC hint ----------------
let silenceTimer = null;
function armSilenceHint() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(showSilenceHint, 6000);
}
function hideSerialHint() {
  clearTimeout(silenceTimer);
  const el = $('#serialHint');
  if (el) el.classList.add('hidden');
}
function nativeUsbPort() {
  const p = S.ports.find(x => x.path === S.port);
  return !!p && (p.vendorId || '').toLowerCase() === '303a';
}
async function cdcDisabled() {
  if (!S.fqbn || !nativeUsbPort()) return false;
  let opts = S.boardDetails[S.fqbn];
  if (!opts) {
    const r = await esp.boardsDetails(S.fqbn);
    opts = (r.ok && r.data.config_options) || [];
    S.boardDetails[S.fqbn] = opts;
  }
  const o = opts.find(x => x.option === 'CDCOnBoot');
  if (!o) return false;
  const def = (o.values.find(v => v.selected) || o.values[0]).value;
  return ((S.boardOptions[S.fqbn] || {}).CDCOnBoot || def) !== 'cdc';
}
async function showSilenceHint() {
  if (!S.serialOpen) return;
  const el = $('#serialHint');
  if (await cdcDisabled()) {
    el.innerHTML = `<b>${esc(t('hint'))}:</b> ${esc(t('cdcHint'))} <button class="btn small primary" id="btnEnableCdc">${esc(t('enableCdc'))}</button>`;
    $('#btnEnableCdc').onclick = async () => {
      S.boardOptions[S.fqbn] = { ...(S.boardOptions[S.fqbn] || {}), CDCOnBoot: 'cdc' };
      await esp.settingsSet({ boardOptions: S.boardOptions });
      hideSerialHint();
      toast(t('cdcEnabled'), 'ok', 8000);
    };
  } else {
    el.innerHTML = `<b>${esc(t('hint'))}:</b> ${esc(t('silentHint'))}`;
  }
  el.classList.remove('hidden');
}
async function serialSend() {
  const v = $('#serialIn').value;
  const eol = $('#serialEol').value.replace('\\n', '\n').replace('\\r', '\r');
  if (await esp.serialWrite(v + eol)) { $('#serialIn').value = ''; }
}

// ---------------- side browser ----------------
function renderIpChips() {
  $('#ipChips').innerHTML = [...S.ips].map(ip => `<button class="chip-btn" data-ip="${esc(ip)}">${esc(ip)}</button>`).join('') || '—';
  $$('#ipChips .chip-btn').forEach(b => b.onclick = () => openBrowser('http://' + b.dataset.ip));
}
function showRight(tab) {
  $('#right').classList.remove('hidden');
  $$('.right-tabs [data-rtab]').forEach(b => b.classList.toggle('active', b.dataset.rtab === tab));
  $$('.rtab').forEach(b => b.classList.toggle('hidden', b.dataset.rtab !== tab));
  if (tab === 'notepad' && !S.notepadDirty) pullToNotepad();
}
function openBrowser(url) {
  showRight('browser');
  if (!url) { const first = [...S.ips][0]; if (first) url = 'http://' + first; }
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  $('#wvUrl').value = url;
  let wv = $('#wvHost webview');
  if (!wv) {
    $('#wvHost').innerHTML = '';
    wv = document.createElement('webview');
    wv.setAttribute('partition', 'esppro-browser');
    $('#wvHost').appendChild(wv);
    wv.addEventListener('did-navigate', e => { $('#wvUrl').value = e.url; });
    wv.addEventListener('did-fail-load', e => { if (e.errorCode !== -3) toast(`${esc(e.validatedURL)}<br>${esc(e.errorDescription)}`, 'err'); });
  }
  wv.src = url;
}

// ---------------- notepad ----------------
function pullToNotepad() {
  const files = currentFiles();
  $('#notepad').value = files.length === 1 ? files[0].content
    : files.map(f => `// ===== ${f.name} =====\n${f.content}`).join('\n\n');
  S.notepadDirty = false;
}

// ---------------- ESP tools ----------------
async function refreshEsptool(force) {
  const s = await esp.esptoolStatus(force);
  S.esptool = s;
  $('#esptoolVer').textContent = s.exe ? `v${s.version}` : t('notInstalled');
  $('#esptoolVer').title = s.exe ? [s.exe, ...(s.pre || [])].join(' ') : '';
  $('#stEsptool').textContent = s.exe ? `esptool v${s.version}` : `esptool: ${t('notInstalled')}`;
  $('#btnEsptoolInstall').textContent = s.exe ? t('update') + ' esptool' : t('installEsptool');
}
function guessOffset(name, chip) {
  const n = name.toLowerCase();
  if (n.includes('merged') || n.includes('factory')) return '0x0';
  if (n.includes('bootloader')) return (chip === 'esp32' || chip === 'esp32s2' || chip === 'auto') ? '0x1000' : (chip === 'esp32p4' || chip === 'esp32c5') ? '0x2000' : '0x0';
  if (n.includes('partition')) return '0x8000';
  if (n.includes('boot_app0')) return '0xe000';
  if (n.includes('spiffs') || n.includes('littlefs')) return '0x290000';
  return null; // the application image: decided by addBins
}
function addBins(list) {
  const chip = $('#espChip').value;
  for (const b of list) if (!S.bins.some(x => x.path === b.path)) S.bins.push({ ...b, offset: guessOffset(b.name, chip) });
  // App image goes to 0x10000 next to a bootloader/partition table; a lone firmware file is a full image at 0x0.
  const alone = S.bins.length === 1;
  for (const b of S.bins) if (b.offset === null) b.offset = alone ? '0x0' : '0x10000';
  S.bins.sort((a, b) => parseInt(a.offset) - parseInt(b.offset));
  renderBins();
}
function loadExportedIntoEsp() {
  if (!S.lastExport) return;
  S.bins = [];
  const merged = S.lastExport.find(b => /merged/i.test(b.name));
  // A merged image already contains bootloader + partitions + app at the right places.
  addBins(merged ? [merged] : S.lastExport.filter(b => !/\.elf$/i.test(b.name)));
}
function renderBins() {
  const tb = $('#binRows'); if (!tb) return;
  tb.innerHTML = S.bins.map((b, i) => `<tr><td class="name" title="${esc(b.path)}">${esc(b.name)}<br><span class="muted">${(b.size / 1024).toFixed(1)} KB</span></td><td><input data-i="${i}" value="${esc(b.offset)}"></td><td><button class="btn icon" data-del="${i}" title="${esc(t('remove'))}">${icon('trash')}</button></td></tr>`).join('')
    || `<tr><td colspan="3" class="muted">—</td></tr>`;
  $$('#binRows input').forEach(inp => inp.onchange = () => { S.bins[+inp.dataset.i].offset = inp.value.trim(); checkOverlap(); });
  $$('#binRows [data-del]').forEach(b => b.onclick = () => { S.bins.splice(+b.dataset.del, 1); renderBins(); });
  checkOverlap();
}
function checkOverlap() {
  const r = S.bins.map(b => ({ s: parseInt(b.offset), e: parseInt(b.offset) + b.size })).sort((a, b) => a.s - b.s);
  let bad = r.some(x => isNaN(x.s));
  for (let i = 1; i < r.length; i++) if (r[i].s < r[i - 1].e) bad = true;
  $('#overlapWarn').classList.toggle('hidden', !bad);
  return !bad;
}
async function espRun(action, extra = {}) {
  if (!S.port) { toast(t('needPort'), 'err'); return null; }
  if (action === 'flash' && !checkOverlap()) { toast(t('overlap'), 'err'); return null; }
  const r = await esp.esptoolRun({ action, port: S.port, chip: $('#espChip').value, baud: +$('#espBaud').value, ...extra });
  if (!r.ok) {
    if (r.error === 'noesptool') toast(t('esptoolStatus') + ': ' + t('notInstalled'), 'err');
    return null;
  }
  beginJob(r, 'esptool ' + action);
  return r;
}

async function destructiveGuard(warning) {
  const v = await confirmBox(`${warning} ${t('destructiveGuard')}`, [
    { label: t('backupFirst'), value: 'backup', cls: 'primary' },
    { label: t('continueAnyway'), value: 'continue', cls: 'danger' },
    { label: t('cancel'), value: 'cancel' },
  ]);
  if (v !== 'backup') return v === 'continue';
  const chip = ($('#chipInfo').textContent.split(' ')[0] || $('#espChip').value).replace(/[^\w-]/g, '');
  const out = await esp.dialogSaveFile({ defaultName: `backup_${chip}_${new Date().toISOString().slice(0, 10)}.bin`, ext: 'bin' });
  if (!out) return false;
  const job = await espRun('backup', { out, size: 'ALL' });
  if (!job) return false;
  const exit = await waitJob(job.id);
  if (exit.code !== 0) { toast(t('backupFailed'), 'err'); return false; }
  return true;
}

// ---------------- managers ----------------
async function searchCores() {
  const box = $('#coreList');
  box.innerHTML = `<p class="muted">${esc(t('compiling'))}</p>`;
  const r = await esp.coreSearch($('#coreQ').value.trim());
  const list = (r.ok && r.data.platforms) || [];
  box.innerHTML = list.slice(0, 80).map(p => {
    const latest = p.latest_version || Object.keys(p.releases || {}).pop() || '';
    const rel = (p.releases || {})[latest] || {};
    const inst = p.installed_version;
    const boards = (rel.boards || []).slice(0, 6).map(b => b.name).join(', ');
    return `<div class="card"><div class="title">${esc(rel.name || p.id)}</div><div class="desc" dir="ltr">${esc(p.id)} · ${esc(p.maintainer || '')} · ${esc(latest)}${inst ? ` · ${esc(t('installed'))} ${esc(inst)}` : ''}</div><div class="desc" dir="ltr">${esc(boards)}</div><div class="row">
      ${!inst ? `<button class="btn small primary" data-a="install" data-id="${esc(p.id)}">${esc(t('install'))}</button>` : ''}
      ${inst && inst !== latest ? `<button class="btn small primary" data-a="install" data-id="${esc(p.id)}">${esc(t('update'))}</button>` : ''}
      ${inst ? `<button class="btn small" data-a="uninstall" data-id="${esc(p.id)}">${esc(t('remove'))}</button>` : ''}</div></div>`;
  }).join('') || `<p class="muted">—</p>`;
  $$('#coreList [data-a]').forEach(b => b.onclick = async () => {
    const job = await esp.cliJob({ args: ['core', b.dataset.a, b.dataset.id], label: `core ${b.dataset.a}` });
    beginJob(job, 'core'); await waitJob(job.id); S.boards = null; searchCores();
  });
}
async function searchLibs() {
  const q = $('#libQ').value.trim(); if (!q) return;
  const box = $('#libList');
  box.innerHTML = `<p class="muted">${esc(t('compiling'))}</p>`;
  const r = await esp.libSearch(q);
  const list = (r.ok && r.data.libraries) || [];
  box.innerHTML = list.slice(0, 60).map(l => `<div class="card"><div class="title" dir="ltr">${esc(l.name)}</div><div class="desc" dir="ltr">${esc(l.latest?.version || '')} · ${esc(l.latest?.author || '')}</div><div class="desc" dir="ltr">${esc(l.latest?.sentence || '')}</div><div class="row"><button class="btn small primary" data-n="${esc(l.name)}">${esc(t('install'))}</button></div></div>`).join('') || `<p class="muted">—</p>`;
  $$('#libList [data-n]').forEach(b => b.onclick = async () => { const job = await esp.cliJob({ args: ['lib', 'install', b.dataset.n], label: 'lib install' }); beginJob(job, 'lib'); });
}

// ---------------- drivers ----------------
async function scanDrivers() {
  const box = $('#driverList');
  box.innerHTML = `<p class="muted">${esc(t('compiling'))}</p>`;
  const list = await esp.driversScan();
  box.innerHTML = list.map(d => {
    const ok = d.status === 'OK';
    return `<div class="card"><div class="row between"><span class="title">${esc(d.chip || d.name || '?')}</span><span class="row"><span class="dot ${ok ? 'ok' : 'dead'}"></span>${esc(ok ? t('driverOk') : t('driverProblem'))}</span></div>
      <div class="desc" dir="ltr">${esc(d.name || '')} · VID ${esc(d.vid)} PID ${esc(d.pid)}</div>
      ${d.url ? `<button class="btn small ${ok ? '' : 'primary'}" data-u="${esc(d.url)}">${esc(t('getDriver'))}</button>` : d.builtin ? `<span class="muted">${esc(t('builtinDriver'))}</span>` : ''}</div>`;
  }).join('') || `<div class="card"><p class="muted" style="margin:0">${esc(t('noDevices'))}</p></div>`;
  $$('#driverList [data-u]').forEach(b => b.onclick = () => esp.openExternal(b.dataset.u));
}

// ---------------- settings / board URLs ----------------
function urlRows(list) {
  return list.map((b, i) => `<div class="url-row"><input type="checkbox" data-i="${i}" ${b.enabled ? 'checked' : ''}><span class="dot ${b.status === 'ok' ? 'ok' : b.status === 'dead' ? 'dead' : ''}" title="${esc(t(b.status === 'ok' ? 'statusOk' : b.status === 'dead' ? 'statusDead' : 'statusUnknown'))}"></span><div><div>${esc(b.name)}</div><div class="u">${esc(b.url)}</div></div></div>`).join('');
}
async function openSettings(welcome) {
  let urls = await esp.urlsGet();
  const st = S.settings;
  const seg = (name, val, opts) => `<div class="seg" data-seg="${name}">${opts.map(([v, k]) => `<button data-v="${v}" class="${val === v ? 'on' : ''}">${esc(t(k))}</button>`).join('')}</div>`;
  modal(`
    <h2>${esc(welcome ? t('welcome') : t('settings'))}</h2>
    ${welcome ? `<p class="muted">${esc(t('welcomeText'))}</p>` : ''}
    <h4>${esc(t('language'))}</h4>${seg('language', st.language, [['system', 'langSystem'], ['ar', 'العربية'], ['en', 'English']])}
    <h4>${esc(t('theme'))}</h4>${seg('theme', st.theme, [['system', 'themeSystem'], ['dark', 'themeDark'], ['light', 'themeLight']])}
    ${welcome ? '' : `<h4>${esc(t('fontSize'))}</h4><input type="number" id="setFont" min="9" max="32" value="${st.fontSize}" style="width:90px">
    <label class="check" style="display:flex"><input type="checkbox" id="setSnap" ${st.snapshots ? 'checked' : ''}><span>${esc(t('snapshotsOpt'))}</span></label>
    <label class="check" style="display:flex"><input type="checkbox" id="setAutoSerial" ${st.autoSerial !== false ? 'checked' : ''}><span>${esc(t('autoSerialOpt'))}</span></label>
    <label class="check" style="display:flex"><input type="checkbox" id="setAutoConnect" ${st.autoConnect !== false ? 'checked' : ''}><span>${esc(t('autoConnectOpt'))}</span></label>
    <label class="check" style="display:flex"><input type="checkbox" id="setExportAll" ${st.exportAll ? 'checked' : ''}><span>${esc(t('exportAllOpt'))}</span></label>`}
    <h4>${esc(t('boardUrls'))}</h4>
    <div class="row wrap"><button class="btn" id="uCheck">${esc(t('checkUrls'))}</button><button class="btn" id="uOnline">${esc(t('fetchOnline'))}</button></div>
    <div id="uList"></div>
    <div class="row"><input id="uNew" dir="ltr" placeholder="https://…/package_xxx_index.json"><button class="btn" id="uAdd">${esc(t('addUrl'))}</button></div>
    ${welcome ? '' : `<p class="muted" dir="ltr" style="font-size:11px">${st.portable ? t('portable') + ' · ' : ''}${esc(st.userData)}<br>arduino-cli: ${esc(st.cli)}</p>`}
    <div class="actions"><button class="btn primary" id="sOk">${esc(welcome ? t('start') : t('applyUrls'))}</button>${welcome ? '' : `<button class="btn" id="sCancel">${esc(t('close'))}</button>`}</div>`,
  m => {
    const draw = () => {
      $('#uList', m).innerHTML = urlRows(urls);
      $$('#uList input[type=checkbox]', m).forEach(c => c.onchange = () => { urls[+c.dataset.i].enabled = c.checked; });
    };
    draw();
    // live-apply language + theme so the user sees the change
    $$('.seg', m).forEach(s => $$('button', s).forEach(b => b.onclick = async () => {
      $$('button', s).forEach(x => x.classList.toggle('on', x === b));
      const patch = { [s.dataset.seg]: b.dataset.v };
      await esp.settingsSet(patch); Object.assign(S.settings, patch);
      if (s.dataset.seg === 'language') { await applyLanguage(); }
      else applyMonacoTheme();
    }));
    $('#uCheck', m).onclick = async () => { $('#uCheck', m).disabled = true; urls = await esp.urlsCheck(urls); draw(); $('#uCheck', m).disabled = false; };
    $('#uOnline', m).onclick = async () => {
      $('#uOnline', m).disabled = true;
      const r = await esp.urlsFetchOnline();
      if (r.ok) {
        let added = 0;
        for (const u of r.urls) if (!urls.some(x => x.url === u.url)) { urls.push({ ...u, enabled: false, status: 'unknown' }); added++; }
        toast(`+${added}`, 'ok');
        draw();
      } else toast(esc(r.error), 'err');
      $('#uOnline', m).disabled = false;
    };
    $('#uAdd', m).onclick = () => { const v = $('#uNew', m).value.trim(); if (/^https?:\/\/.+\.json$/i.test(v) && !urls.some(x => x.url === v)) { urls.push({ name: v.split('/').pop(), url: v, enabled: true, status: 'unknown' }); $('#uNew', m).value = ''; draw(); } };
    const cancel = $('#sCancel', m); if (cancel) cancel.onclick = closeModal;
    $('#sOk', m).onclick = async () => {
      const patch = { firstRun: false };
      if (!welcome) {
        patch.fontSize = +$('#setFont', m).value || 14; patch.snapshots = $('#setSnap', m).checked;
        patch.autoSerial = $('#setAutoSerial', m).checked; patch.autoConnect = $('#setAutoConnect', m).checked; patch.exportAll = $('#setExportAll', m).checked;
        S.editor.updateOptions({ fontSize: patch.fontSize });
      }
      await esp.urlsSet(urls);
      await esp.settingsSet(patch); Object.assign(S.settings, patch);
      closeModal();
      const job = await esp.cliJob({ args: ['core', 'update-index'], label: t('updateIndex') });
      beginJob(job, 'index');
      await waitJob(job.id); S.boards = null;
    };
  });
}

// ---------------- sidebar views ----------------
function showView(v) {
  const sb = $('#sidebar');
  const btn = $(`.activity [data-view="${v}"]`);
  if (btn.classList.contains('active') && !sb.classList.contains('collapsed')) { sb.classList.add('collapsed'); btn.classList.remove('active'); return; }
  sb.classList.remove('collapsed');
  $$('.activity button').forEach(b => b.classList.toggle('active', b === btn));
  $$('.sidebar .view').forEach(s => s.classList.toggle('hidden', s.dataset.view !== v));
  if (v === 'esp') refreshEsptool();
  if (v === 'drivers' && !$('#driverList').children.length) scanDrivers();
  if (v === 'boards' && !$('#coreList').children.length) searchCores();
}

// ---------------- wiring ----------------
function wire() {
  $('#btnVerify').onclick = () => build('verify');
  $('#btnUpload').onclick = () => build('upload');
  $('#btnExport').onclick = () => build('export');
  $('#btnBoard').onclick = openBoardPicker;
  $('#btnBoardOpts').onclick = openBoardOptions;
  $('#portSel').onchange = e => {
    if (e.target.value === 'ota:?') return pickOtaOther();
    S.port = e.target.value; renderPorts(); esp.settingsSet({ lastPort: S.port });
    serialUserOff = false; maybeAutoConnect();
  };
  $('#btnNotepad').onclick = () => showRight('notepad');
  $('#btnBrowser').onclick = () => openBrowser();
  $('#btnDevMgr').onclick = $('#btnDevMgr2').onclick = () => esp.winDeviceManager();
  $('#btnSettings').onclick = () => openSettings(false);
  $$('.activity button').forEach(b => b.onclick = () => showView(b.dataset.view));

  $('#btnNew').onclick = async () => {
    if (anyDirty()) {
      const v = await confirmBox(t('unsaved'), [{ label: t('save'), value: 'save', cls: 'primary' }, { label: t('dontSave'), value: 'no' }, { label: t('cancel'), value: 'cancel' }]);
      if (v === 'cancel') return;
      if (v === 'save' && !(await saveSketch(true))) return;
    }
    loadSketch(await esp.sketchNew());
    S.editor.focus();
    toast(`${t('newSketch')}: <b dir="ltr">${esc(S.sketch.name)}</b>`, 'ok');
  };
  $('#btnTheme').onclick = async () => {
    const next = darkQuery.matches ? 'light' : 'dark';
    await esp.settingsSet({ theme: next }); S.settings.theme = next;
  };
  $('#btnOpen').onclick = async () => { const sk = await esp.sketchOpen(); if (sk) { loadSketch(sk); S.settings = await esp.settingsGet(); renderRecent(); } };
  $('#btnSave').onclick = () => saveSketch(true);
  $('#btnSaveAs').onclick = saveAs;
  $('#btnSnapshots').onclick = () => esp.snapshotsOpen();
  $('#btnAddFile').onclick = () => modal(`<h2>${esc(t('addFile'))}</h2><input id="nf" dir="ltr" style="width:100%" placeholder="config.h"><div class="actions"><button class="btn primary" id="nfOk">${esc(t('save'))}</button><button class="btn" id="nfC">${esc(t('cancel'))}</button></div>`, m => {
    $('#nfC', m).onclick = closeModal; $('#nf', m).focus();
    $('#nfOk', m).onclick = async () => {
      const n = $('#nf', m).value.trim().replace(/[\\/:*?"<>|]/g, '');
      if (!n || S.sketch.files.some(f => f.name === n)) return;
      await esp.sketchAddFile({ dir: S.sketch.dir, name: n });
      const f = { name: n, content: '', saved: '' };
      f.model = S.monaco.editor.createModel('', langFor(n)); f.model.onDidChangeContent(() => { renderTabs(); renderFiles(); });
      S.sketch.files.push(f); closeModal(); setActive(S.sketch.files.length - 1);
    };
  });

  $$('.bottom-tabs [data-btab]').forEach(b => b.onclick = () => showBottom(b.dataset.btab));
  $('#btnClearOut').onclick = () => { if (!$('.btab[data-btab=serial]').classList.contains('hidden')) { $('#serialOut').innerHTML = ''; S.serialLog = []; } else { $('#output').innerHTML = ''; $('#hints').innerHTML = ''; } };
  $('#btnStop').onclick = () => S.job && esp.jobKill(S.job.id);
  $('#btnOpenCmd').onclick = () => { if (S.lastCmd) esp.jobOpenInCmd(S.lastCmd); };

  $('#serialBaud').innerHTML = BAUDS.map(b => `<option ${b === S.settings.baud ? 'selected' : ''}>${b}</option>`).join('');
  $('#serialBaud').onchange = async () => { esp.settingsSet({ baud: +$('#serialBaud').value }); if (S.serialOpen) { await esp.serialClose(); toggleSerial(); } };
  $('#btnSerialConn').onclick = toggleSerial;
  $('#btnSerialSend').onclick = serialSend;
  $('#serialIn').onkeydown = e => { if (e.key === 'Enter') serialSend(); };
  $('#btnSerialClear').onclick = () => { $('#serialOut').innerHTML = ''; S.serialLog = []; };
  $('#btnSerialSave').onclick = async () => {
    const f = await esp.fileSaveText({ defaultName: `serial_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`, content: S.serialLog.join('') });
    if (f) toast(t('saved'), 'ok');
  };

  $$('.right-tabs [data-rtab]').forEach(b => b.onclick = () => showRight(b.dataset.rtab));
  $('#btnCloseRight').onclick = () => $('#right').classList.add('hidden');
  $('#notepad').oninput = () => { S.notepadDirty = true; };
  $('#btnNpPull').onclick = pullToNotepad;
  $('#btnNpSave').onclick = async () => { const f = await esp.fileSaveText({ defaultName: `${S.sketch.name}.txt`, content: $('#notepad').value }); if (f) { S.notepadDirty = false; toast(t('saved'), 'ok'); } };
  $('#btnNpOpen').onclick = async () => { const r = await esp.fileOpenText(); if (r) { $('#notepad').value = r.content; S.notepadDirty = true; } };
  $('#btnNpToEditor').onclick = async () => {
    const ok = await confirmBox(`${t('toEditor')}: ${S.sketch.files[S.active].name}?`, [{ label: t('toEditor'), value: true, cls: 'primary' }, { label: t('cancel'), value: false }]);
    if (ok) S.editor.getModel().setValue($('#notepad').value);
  };
  $('#btnWvGo').onclick = () => openBrowser($('#wvUrl').value.trim());
  $('#wvUrl').onkeydown = e => { if (e.key === 'Enter') openBrowser($('#wvUrl').value.trim()); };
  $('#btnWvReload').onclick = () => { const w = $('#wvHost webview'); if (w) w.reload(); };
  $('#btnWvBack').onclick = () => { const w = $('#wvHost webview'); if (w && w.canGoBack()) w.goBack(); };
  $('#btnWvExternal').onclick = () => { const u = $('#wvUrl').value.trim(); if (u) esp.openExternal(/^https?:/.test(u) ? u : 'http://' + u); };

  $('#btnEsptoolRefresh').onclick = () => refreshEsptool(true);
  $('#btnEsptoolInstall').onclick = async () => {
    const r = await esp.esptoolInstall();
    if (!r.ok) { toast('Python not found — https://www.python.org/downloads/', 'err', 8000); esp.openExternal('https://www.python.org/downloads/windows/'); return; }
    beginJob(r, 'esptool install'); await waitJob(r.id); refreshEsptool(true);
  };
  $('#btnDetectChip').onclick = () => espRun('info');
  $('#espChip').onchange = () => { const all = S.bins; S.bins = []; addBins(all); };
  $('#btnAddBins').onclick = async () => addBins(await esp.dialogOpenBins());
  $('#btnLoadExported').onclick = () => { if (S.lastExport) loadExportedIntoEsp(); else build('export'); };
  $('#btnFlash').onclick = async () => {
    if (!S.bins.length) return addBins([]) || $('#btnAddBins').click();
    if (!checkOverlap()) { toast(t('overlap'), 'err'); return; }
    const eraseAll = $('#espEraseAll').checked;
    if (eraseAll && !(await destructiveGuard(t('eraseAllWarn')))) return;
    espRun('flash', { files: S.bins.map(b => ({ offset: b.offset, path: b.path })), eraseAll });
  };
  $('#btnBackup').onclick = async () => {
    const chip = ($('#chipInfo').textContent.split(' ')[0] || $('#espChip').value).replace(/[^\w-]/g, '');
    const out = await esp.dialogSaveFile({ defaultName: `backup_${chip}_${new Date().toISOString().slice(0, 10)}.bin`, ext: 'bin' });
    if (out) espRun('backup', { out, size: $('#backupSize').value });
  };
  $('#btnErase').onclick = async () => {
    if (await destructiveGuard(t('confirmErase'))) espRun('erase');
  };

  $('#coreQ').onkeydown = e => { if (e.key === 'Enter') searchCores(); };
  $('#btnCoreIndex').onclick = async () => { const j = await esp.cliJob({ args: ['core', 'update-index'], label: t('updateIndex') }); beginJob(j, 'index'); await waitJob(j.id); searchCores(); };
  $('#libQ').onkeydown = e => { if (e.key === 'Enter') searchLibs(); };
  $('#btnScanDrivers').onclick = scanDrivers;
  $('#modalBack').onclick = e => { if (e.target.id === 'modalBack') closeModal(); };

  // bottom panel resize
  let drag = null;
  $('#hsplit').onmousedown = e => { drag = { y: e.clientY, h: $('#bottom').offsetHeight }; document.body.style.userSelect = 'none'; };
  addEventListener('mousemove', e => { if (drag) $('#bottom').style.height = Math.max(80, Math.min(innerHeight - 220, drag.h + drag.y - e.clientY)) + 'px'; });
  addEventListener('mouseup', () => { drag = null; document.body.style.userSelect = ''; });

  // shortcuts (capture phase so they win over the editor)
  addEventListener('keydown', e => {
    if (!e.ctrlKey) return;
    const k = e.key.toLowerCase();
    const map = { s: () => (e.shiftKey ? saveAs() : saveSketch(true)), r: () => build('verify'), u: () => build('upload'), n: () => $('#btnNew').click(), o: () => $('#btnOpen').click(), m: () => (e.shiftKey ? showBottom('serial') : null), e: () => (e.altKey ? build('export') : null) };
    if (map[k]) { const r = map[k](); if (r !== null) { e.preventDefault(); e.stopPropagation(); } }
    if (k === 'i' && e.shiftKey) esp.appDevtools();
  }, true);

  esp.onBeforeClose(async () => {
    if (anyDirty()) {
      const v = await confirmBox(t('unsaved'), [{ label: t('save'), value: 'save', cls: 'primary' }, { label: t('dontSave'), value: 'no' }, { label: t('cancel'), value: 'cancel' }]);
      if (v === 'cancel') return;
      if (v === 'save') { const ok = await saveSketch(true); if (!ok) return; }
    }
    esp.appClose();
  });
}

// ---------------- boot ----------------
(async function boot() {
  paintIcons();
  S.settings = await esp.settingsGet();
  S.errors = await esp.dataErrors();
  S.boardOptions = S.settings.boardOptions || {};
  await applyLanguage();
  await initMonaco();
  applyMonacoTheme();
  wire();
  loadSketch(await esp.sketchNew());
  if (S.settings.lastFqbn) setBoard(S.settings.lastFqbn, S.settings.lastBoardName || S.settings.lastFqbn);
  S.port = S.settings.lastPort || '';
  await pollPorts(); setInterval(pollPorts, 1500);
  refreshEsptool();
  renderIpChips();
  window.dispatchEvent(new Event('esppro-ready'));
  if (S.settings.firstRun) openSettings(true);
})();

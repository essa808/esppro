/* esppro — serial plotter, partition viewer, OTA upload */
'use strict';

// ================= Serial Plotter =================
const PLOT = {
  samples: [], seq: 0, series: [], hidden: new Set(), paused: false, dirty: false, lineBuf: '', hoverX: null, warned: false,
};
const MAX_SERIES = 8;
const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

function plotParseLine(line) {
  const vals = {};
  let n = 0, idx = 0;
  for (const tok of line.trim().split(/[\s,;\t]+/)) {
    if (!tok) continue;
    const m = /^([^:=]+)[:=](.+)$/.exec(tok);
    if (m && NUM_RE.test(m[2])) { vals[m[1]] = parseFloat(m[2]); n++; }
    else if (NUM_RE.test(tok)) { vals['value' + (++idx)] = parseFloat(tok); n++; }
  }
  return n ? vals : null;
}
function plotFeed(text) {
  PLOT.lineBuf += text;
  const lines = PLOT.lineBuf.split(/\r?\n/);
  PLOT.lineBuf = lines.pop().slice(-500);
  if (PLOT.paused) return;
  const max = +$('#plotPoints').value;
  for (const line of lines) {
    const vals = plotParseLine(line);
    if (!vals) continue;
    for (const name of Object.keys(vals)) {
      if (!PLOT.series.includes(name)) {
        if (PLOT.series.length >= MAX_SERIES) { delete vals[name]; if (!PLOT.warned) { PLOT.warned = true; toast(t('tooManySeries')); } continue; }
        PLOT.series.push(name); // colour follows the series, assigned once in arrival order
        plotLegend();
      }
    }
    PLOT.samples.push({ i: PLOT.seq++, v: vals });
  }
  if (PLOT.samples.length > max) PLOT.samples.splice(0, PLOT.samples.length - max);
  PLOT.dirty = true;
}
const seriesColor = i => getComputedStyle(document.documentElement).getPropertyValue(`--s${i + 1}`).trim();
function plotLegend() {
  $('#plotLegend').innerHTML = PLOT.series.map((s, i) =>
    `<label class="${PLOT.hidden.has(s) ? 'off' : ''}"><input type="checkbox" data-s="${esc(s)}" ${PLOT.hidden.has(s) ? '' : 'checked'}><span class="sw" style="background:${seriesColor(i)}"></span>${esc(s)}</label>`).join('');
  $$('#plotLegend input').forEach(c => c.onchange = () => { c.checked ? PLOT.hidden.delete(c.dataset.s) : PLOT.hidden.add(c.dataset.s); plotLegend(); PLOT.dirty = true; });
}
function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
const fmt = v => (Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : v.toFixed(Math.abs(v) < 10 ? 2 : 1));

function plotDraw() {
  requestAnimationFrame(plotDraw);
  const tab = $('.btab[data-btab=plotter]');
  if (!PLOT.dirty || tab.classList.contains('hidden')) return;
  PLOT.dirty = false;
  const cv = $('#plotCanvas'), wrap = $('#plotWrap');
  const dpr = devicePixelRatio || 1, W = wrap.clientWidth, H = wrap.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  $('#plotEmpty').classList.toggle('hidden', PLOT.samples.length > 0);
  if (!PLOT.samples.length) return;

  const css = getComputedStyle(document.documentElement);
  const textC = css.getPropertyValue('--text').trim(), mutedC = css.getPropertyValue('--axis').trim(), gridC = css.getPropertyValue('--grid').trim(), surf = css.getPropertyValue('--console').trim();
  const visible = PLOT.series.filter(s => !PLOT.hidden.has(s));
  const directLabels = visible.length > 0 && visible.length <= 4;
  const padL = 56, padR = directLabels ? 90 : 14, padT = 12, padB = 24;
  const pw = W - padL - padR, ph = H - padT - padB;
  let lo = Infinity, hi = -Infinity;
  for (const smp of PLOT.samples) for (const s of visible) { const v = smp.v[s]; if (v !== undefined) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const ticks = niceTicks(lo, hi);
  const x0 = PLOT.samples[0].i, x1 = Math.max(PLOT.samples[PLOT.samples.length - 1].i, x0 + 1);
  const X = i => padL + ((i - x0) / (x1 - x0)) * pw;
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * ph;

  // recessive grid + axis labels
  g.font = '11px "Cascadia Mono", Consolas, monospace';
  g.lineWidth = 1; g.strokeStyle = gridC; g.fillStyle = mutedC; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const v of ticks) { const y = Math.round(Y(v)) + 0.5; g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + pw, y); g.stroke(); g.fillText(fmt(v), padL - 8, y); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const v of niceTicks(x0, x1, 6)) if (v >= x0 && v <= x1) g.fillText(String(v), X(v), padT + ph + 6);

  // lines: 2px, round joins, gaps where a value is missing
  g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
  const labels = [];
  PLOT.series.forEach((s, si) => {
    if (PLOT.hidden.has(s)) return;
    g.strokeStyle = seriesColor(si);
    g.beginPath();
    let pen = false, last = null;
    for (const smp of PLOT.samples) {
      const v = smp.v[s];
      if (v === undefined) { pen = false; continue; }
      const x = X(smp.i), y = Y(v);
      pen ? g.lineTo(x, y) : g.moveTo(x, y);
      pen = true; last = { x, y, v };
    }
    g.stroke();
    if (directLabels && last) labels.push({ text: `${s} ${fmt(last.v)}`, x: last.x + 8, y: last.y });
  });
  // end labels: keep at least 14px apart so they never overlap
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  const overflow = labels.length ? labels[labels.length - 1].y - (padT + ph) : 0;
  if (overflow > 0) labels.forEach(l => { l.y -= overflow; });
  g.fillStyle = textC; g.textAlign = 'left'; g.textBaseline = 'middle';
  for (const l of labels) g.fillText(l.text, l.x, l.y);

  // hover: crosshair + points + tooltip
  const tip = $('#plotTip');
  if (PLOT.hoverX === null || PLOT.hoverX < padL || PLOT.hoverX > padL + pw) { tip.classList.add('hidden'); return; }
  const target = x0 + ((PLOT.hoverX - padL) / pw) * (x1 - x0);
  let best = PLOT.samples[0];
  for (const smp of PLOT.samples) if (Math.abs(smp.i - target) < Math.abs(best.i - target)) best = smp;
  const cx = Math.round(X(best.i)) + 0.5;
  g.strokeStyle = mutedC; g.lineWidth = 1; g.beginPath(); g.moveTo(cx, padT); g.lineTo(cx, padT + ph); g.stroke();
  const rows = [];
  PLOT.series.forEach((s, si) => {
    const v = best.v[s];
    if (PLOT.hidden.has(s) || v === undefined) return;
    g.beginPath(); g.arc(cx, Y(v), 4, 0, Math.PI * 2); g.fillStyle = seriesColor(si); g.fill(); g.lineWidth = 2; g.strokeStyle = surf; g.stroke();
    rows.push(`<div><span class="sw" style="background:${seriesColor(si)}"></span>${esc(s)}: <b>${esc(fmt(v))}</b></div>`);
  });
  tip.innerHTML = `<div class="muted">#${best.i}</div>${rows.join('')}`;
  tip.classList.remove('hidden');
  const tx = cx + 14 + tip.offsetWidth > W ? cx - 14 - tip.offsetWidth : cx + 14;
  tip.style.left = tx + 'px'; tip.style.top = padT + 'px';
}

function initPlotter() {
  esp.onSerialData(plotFeed);
  $('#plotWrap').addEventListener('mousemove', e => { PLOT.hoverX = e.clientX - $('#plotWrap').getBoundingClientRect().left; PLOT.dirty = true; });
  $('#plotWrap').addEventListener('mouseleave', () => { PLOT.hoverX = null; PLOT.dirty = true; });
  $('#btnPlotPause').onclick = () => { PLOT.paused = !PLOT.paused; $('#btnPlotPause').textContent = PLOT.paused ? t('resume') : t('pause'); };
  $('#btnPlotClear').onclick = () => { PLOT.samples = []; PLOT.series = []; PLOT.hidden.clear(); PLOT.warned = false; plotLegend(); PLOT.dirty = true; };
  $('#plotPoints').onchange = () => { const m = +$('#plotPoints').value; if (PLOT.samples.length > m) PLOT.samples.splice(0, PLOT.samples.length - m); PLOT.dirty = true; };
  $('#btnPlotConn').onclick = toggleSerial;
  esp.onSerialState(s => { const b = $('#btnPlotConn'); b.textContent = s.open ? t('disconnect') : t('connect'); b.classList.toggle('primary', !s.open); });
  $('#btnPlotConn').classList.add('primary');
  new ResizeObserver(() => { PLOT.dirty = true; }).observe($('#plotWrap'));
  darkQuery.addEventListener('change', () => { plotLegend(); PLOT.dirty = true; });
  $$('.bottom-tabs [data-btab]').forEach(b => b.addEventListener('click', () => { PLOT.dirty = true; }));
  requestAnimationFrame(plotDraw);
}

// ================= Partition table viewer =================
const hex = n => '0x' + n.toString(16).toUpperCase();
const kb = n => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(0) + ' KB');
async function showPartitions(file) {
  if (!file) {
    const pick = await esp.dialogOpenBins();
    if (!pick.length) return;
    file = pick[0].path;
  }
  const r = await esp.partitionsParse(file);
  if (!r.ok) { toast(t('noTable'), 'err'); return; }
  const total = Math.max(...r.parts.map(p => p.offset + p.size));
  const bar = r.parts.map((p, i) => `<div title="${esc(p.label)} ${kb(p.size)}" style="flex:${p.size} 0 0;background:var(--s${(i % 8) + 1})"></div>`).join('');
  modal(`<h2>${esc(t('partitions'))}</h2><p class="muted" dir="ltr" style="word-break:break-all">${esc(file)}</p>
    <div class="pbar" dir="ltr">${bar}</div>
    <table class="parts"><thead><tr><th></th><th>name</th><th>type</th><th>subtype</th><th>offset</th><th>size</th></tr></thead><tbody>
    ${r.parts.map((p, i) => `<tr><td><span class="dot" style="background:var(--s${(i % 8) + 1})"></span></td><td>${esc(p.label)}</td><td>${esc(p.type)}</td><td>${esc(p.subtype)}</td><td>${hex(p.offset)}</td><td>${kb(p.size)}${p.encrypted ? ' 🔒' : ''}</td></tr>`).join('')}
    </tbody></table><p class="muted" dir="ltr">end: ${hex(total)} (${kb(total)})</p>
    <div class="actions"><button class="btn" id="pClose">${esc(t('close'))}</button></div>`, m => { $('#pClose', m).onclick = closeModal; });
}

// ================= OTA (WiFi upload) =================
const OTA = { hosts: new Set(), password: '' };
async function pollNetworkPorts() {
  const r = await esp.boardsDetected();
  if (!r.ok) return;
  let changed = false;
  for (const d of r.data.detected_ports || []) {
    const p = d.port || {};
    if (p.protocol === 'network' && p.address && !OTA.hosts.has(p.address)) { OTA.hosts.add(p.address); changed = true; }
  }
  if (changed) renderPorts();
}
function otaOptionsHtml() {
  const hosts = new Set([...OTA.hosts, ...S.ips]);
  if (S.port.startsWith('ota:')) hosts.add(S.port.slice(4));
  return `<optgroup label="${esc(t('otaPort'))}">${[...hosts].map(h => `<option value="ota:${esc(h)}" ${S.port === 'ota:' + h ? 'selected' : ''}>📶 ${esc(h)}</option>`).join('')}<option value="ota:?">${esc(t('otaOther'))}</option></optgroup>`;
}
function askText(title, placeholder, value = '') {
  return new Promise(res => {
    modal(`<h2>${esc(title)}</h2><input id="askIn" dir="ltr" style="width:100%" placeholder="${esc(placeholder)}" value="${esc(value)}"><div class="actions"><button class="btn primary" id="askOk">OK</button><button class="btn" id="askC">${esc(t('cancel'))}</button></div>`, m => {
      const inp = $('#askIn', m); inp.focus();
      const done = v => { closeModal(); res(v); };
      $('#askOk', m).onclick = () => done(inp.value.trim());
      $('#askC', m).onclick = () => done(null);
      inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value.trim()); };
    });
  });
}
async function pickOtaOther() {
  const ip = await askText(t('otaIp'), '192.168.1.50');
  if (ip && !validHost(ip)) { toast(t('badHost'), 'err'); return; }
  if (ip) { OTA.hosts.add(ip); S.port = 'ota:' + ip; }
  renderPorts();
}
function validHost(h) {
  if (typeof h !== 'string' || !h || h.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h.split('.').every(x => +x <= 255);
  if (/^\[[0-9A-Fa-f:.]+\]$/.test(h)) return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(h);
}
async function otaUpload() {
  const host = S.port.slice(4);
  if (!validHost(host)) { toast(t('badHost'), 'err'); return; }
  const pw = await askText(t('otaPassword'), '', OTA.password);
  if (pw === null) return;
  OTA.password = pw;
  await saveSketch(false);
  const dir = S.settings.userData + '\\ota-build';
  const c = await esp.buildRun({ dir: S.sketch.dir, fqbn: effectiveFqbn(), exportDir: dir });
  beginJob(c, 'ota compile');
  const res = await waitJob(c.id);
  if (res.code !== 0) return;
  // Prefer HTTP upload when the sketch serves /update: no inbound connection, so no firewall rule needed.
  if (await esp.otaProbeHttp(host)) {
    const app = (res.bins || []).find(b => /\.ino\.bin$/i.test(b.name));
    if (app) {
      outAppend(`\n${t('otaHttpUsed')}\n`, 'cmd');
      const h = await esp.otaHttp({ host, file: app.path, user: 'admin', password: pw });
      if (h.ok === false) { toast(t('badHost'), 'err'); return; }
      beginJob(h, 'ota');
      return;
    }
  }
  const args = ['upload', '-p', host, '-l', 'network', '-b', effectiveFqbn(), '--input-dir', dir];
  if (pw) args.push('-F', 'password=' + pw);
  args.push(S.sketch.dir);
  const u = await esp.cliJob({ args, label: 'OTA ' + host });
  beginJob(u, 'ota');
}

window.addEventListener('esppro-ready', () => {
  initPlotter();
  $('#btnPartitions').onclick = () => showPartitions();
  pollNetworkPorts(); setInterval(pollNetworkPorts, 10000);
});

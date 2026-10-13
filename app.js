'use strict';

/* ================= Helpers ================= */

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const round2 = n => Math.round(n * 100) / 100;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrs = n => Number(n || 0).toFixed(2);

const toDate = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };
const ymdOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymdOf(new Date());
const isYmd = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymdOf(toDate(s)) === s;
const isHm = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

const fmtDay = ymd => toDate(ymd).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtShort = ymd => toDate(ymd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtLong = ymd => toDate(ymd).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = hm => { const [h, m] = hm.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
const periodLabel = p => `${fmtShort(p.start)} – ${toDate(p.end).getDate()}, ${toDate(p.end).getFullYear()}`;
const daysSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

/* ================= Storage (IndexedDB on the device) ================= */

const EMPTY = () => ({ shifts: [], rates: [], settings: { deductionPct: 20 }, lastBackup: null });
let S = EMPTY();
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('pay-tracker', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function load() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('kv').objectStore('kv').get('state');
    req.onsuccess = () => resolve(req.result ? normalize(req.result) : EMPTY());
    req.onerror = () => reject(req.error);
  });
}

async function save() {
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(S, 'state');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Cleans up data from storage or an imported backup so the rest of the app can trust it.
function normalize(raw) {
  const s = EMPTY();
  s.shifts = (Array.isArray(raw.shifts) ? raw.shifts : [])
    .filter(x => x && isYmd(x.date) && isHm(x.start) && isHm(x.end))
    .map(x => ({ id: String(x.id || uid()), date: x.date, start: x.start, end: x.end }));
  s.rates = (Array.isArray(raw.rates) ? raw.rates : [])
    .filter(x => x && isYmd(x.date) && Number(x.rate) > 0)
    .map(x => ({ id: String(x.id || uid()), date: x.date, rate: Number(x.rate) }));
  const pct = Number(raw.settings && raw.settings.deductionPct);
  if (pct >= 0 && pct < 100) s.settings.deductionPct = pct;
  s.lastBackup = typeof raw.lastBackup === 'string' ? raw.lastBackup : null;
  sortRates(s);
  return s;
}

function sortRates(s) {
  s.rates.sort((a, b) => a.date.localeCompare(b.date));
}

async function commit(msg) {
  sortRates(S);
  render();
  try {
    await save();
    if (msg) toast(msg);
  } catch (e) {
    toast('Could not save: ' + e.message);
  }
}

/* ================= Pay calculations ================= */

// Rates are sorted oldest → newest; the last one on or before the date applies.
function rateFor(ymd) {
  let rate = 0;
  for (const r of S.rates) if (r.date <= ymd) rate = r.rate;
  return rate;
}

// Overnight shifts (end earlier than start) wrap past midnight.
function calcHours(start, end) {
  if (!isHm(start) || !isHm(end)) return 0;
  const [a, b] = start.split(':').map(Number), [c, d] = end.split(':').map(Number);
  let mins = (c * 60 + d) - (a * 60 + b);
  if (mins < 0) mins += 1440;
  return round2(mins / 60);
}

const shiftHours = s => calcHours(s.start, s.end);
const shiftPay = s => round2(shiftHours(s) * rateFor(s.date));

// Saturday and Sunday paydays move back to the Friday before.
function weekdayOnOrBefore(ymd) {
  const d = toDate(ymd);
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() - 1);
  if (dow === 0) d.setDate(d.getDate() - 2);
  return ymdOf(d);
}

// 1st–15th is paid on the last day of the month; 16th–end is paid on the 15th of the next month.
function periodFor(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const firstHalf = d <= 15;
  const start = `${y}-${pad(m)}-${firstHalf ? '01' : '16'}`;
  const end = `${y}-${pad(m)}-${firstHalf ? '15' : pad(lastDay)}`;
  const scheduled = firstHalf ? `${y}-${pad(m)}-${pad(lastDay)}` : (m === 12 ? `${y + 1}-01-15` : `${y}-${pad(m + 1)}-15`);
  return { start, end, scheduled, payDate: weekdayOnOrBefore(scheduled) };
}

// Every period that has shifts, plus the current one. Newest first.
function computePeriods() {
  const map = new Map();
  const get = ymd => {
    const p = periodFor(ymd);
    if (!map.has(p.start)) map.set(p.start, { ...p, shifts: [], hours: 0, gross: 0 });
    return map.get(p.start);
  };
  get(today());
  for (const s of S.shifts) {
    const p = get(s.date);
    p.shifts.push(s);
    p.hours += shiftHours(s);
    p.gross += shiftPay(s);
  }
  const keep = 1 - S.settings.deductionPct / 100;
  return [...map.values()]
    .map(p => ({
      ...p,
      hours: round2(p.hours),
      gross: round2(p.gross),
      net: round2(p.gross * keep),
      shifts: p.shifts.sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start)),
    }))
    .sort((a, b) => b.start.localeCompare(a.start));
}

function periodStatus(p) {
  const t = today();
  if (p.payDate < t) return ['Paid', 'b-paid'];
  if (p.payDate === t) return ['Payday today', 'b-paid'];
  if (p.start <= t && t <= p.end) return ['In progress', 'b-now'];
  if (p.start > t) return ['Upcoming', 'b-now'];
  return ['Awaiting pay', 'b-wait'];
}

/* ================= Rendering ================= */

let VIEW = 'timesheet';
const openPeriods = new Set();

function render() {
  const periods = computePeriods();
  renderSummary(periods);
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.view === VIEW));
  $('#fab').hidden = VIEW === 'periods' || VIEW === 'settings';
  const html = { timesheet: timesheetHtml, periods: periodsHtml, rates: ratesHtml, settings: settingsHtml }[VIEW](periods);
  $('#view').innerHTML = html;
  if (VIEW === 'settings') refreshStorageStatus();
}

function renderSummary(periods) {
  const t = today();
  const current = periods.find(p => p.start <= t && t <= p.end);
  const next = periods.filter(p => p.payDate >= t).sort((a, b) => a.payDate.localeCompare(b.payDate))[0];
  $('#summary').innerHTML = `
    <div class="sum">
      <div class="lbl">This period · ${fmtShort(current.start)}–${toDate(current.end).getDate()}</div>
      <div class="big">${hrs(current.hours)} h</div>
      <div class="sub">${money(current.gross)} gross</div>
    </div>
    <div class="sum">
      <div class="lbl">Next payday${next ? ' · ' + fmtShort(next.payDate) : ''}</div>
      <div class="big">${next ? money(next.net) : '—'}</div>
      <div class="sub">${next ? 'est. net · ' + money(next.gross) + ' gross' : ''}</div>
    </div>`;
}

function shiftRow(s, editable) {
  return `
    <div class="row" ${editable ? `data-shift="${esc(s.id)}"` : ''}>
      <div>
        <div class="main-t">${esc(fmtDay(s.date))}</div>
        <div class="meta">${esc(fmtTime(s.start))} – ${esc(fmtTime(s.end))}</div>
      </div>
      <div class="num">
        <div class="main-t">${money(shiftPay(s))}</div>
        <div class="meta">${hrs(shiftHours(s))} h</div>
      </div>
    </div>`;
}

function backupBanner() {
  if (!S.shifts.length) return '';
  const days = S.lastBackup ? daysSince(S.lastBackup) : null;
  if (days !== null && days < 14) return '';
  return `
    <div class="banner">
      <span>${days === null ? 'No backup yet' : `Last backup ${days} days ago`}</span>
      <button class="btn" type="button" data-action="backup">Back up</button>
    </div>`;
}

function timesheetHtml(periods) {
  if (!S.shifts.length) {
    return `<div class="empty">No shifts yet.<br>Tap <b>+</b> to add one, or import your old data from <b>⚙</b>.</div>`;
  }
  const noRate = !S.rates.length ? `<div class="banner"><span>Add a pay rate so pay can be calculated.</span><button class="btn" type="button" data-action="gotoRates">Add</button></div>` : '';
  return backupBanner() + noRate + periods.filter(p => p.shifts.length).map(p => `
    <div class="group-h"><span>${esc(periodLabel(p))}</span><span>${hrs(p.hours)} h · ${money(p.gross)}</span></div>
    <div class="card">${p.shifts.map(s => shiftRow(s, true)).join('')}</div>`).join('');
}

function periodsHtml(periods) {
  return periods.map(p => {
    const [label, cls] = periodStatus(p);
    const moved = p.payDate !== p.scheduled ? ` <span class="meta">(moved from ${esc(fmtDay(p.scheduled))})</span>` : '';
    return `
      <div class="card period ${openPeriods.has(p.start) ? 'open' : ''}" data-period="${p.start}">
        <div class="period-top">
          <div>
            <div class="period-title">${esc(periodLabel(p))}</div>
            <div class="meta">Pay date ${esc(fmtLong(p.payDate))}${moved}</div>
          </div>
          <span class="badge ${cls}">${label}</span>
        </div>
        <div class="stats">
          <div class="stat"><div class="lbl">Hours</div><div class="val">${hrs(p.hours)}</div></div>
          <div class="stat"><div class="lbl">Gross pay</div><div class="val">${money(p.gross)}</div></div>
          <div class="stat"><div class="lbl">Est. net</div><div class="val">${money(p.net)}</div></div>
        </div>
        <div class="period-entries">${p.shifts.length ? p.shifts.map(s => shiftRow(s, false)).join('') : '<div class="meta" style="padding-top:8px">No shifts in this period.</div>'}</div>
      </div>`;
  }).join('');
}

function ratesHtml() {
  const t = today();
  const current = [...S.rates].reverse().find(r => r.date <= t);
  if (!S.rates.length) return `<div class="empty">No pay rates yet.<br>Tap <b>+</b> to add your hourly rate.</div>`;
  const list = [...S.rates].reverse().map(r => `
    <div class="row" data-rate="${esc(r.id)}">
      <div>
        <div class="main-t">${money(r.rate)} / hr</div>
        <div class="meta">Effective ${esc(fmtLong(r.date))}</div>
      </div>
      ${r === current ? '<span class="badge b-paid">Current</span>' : r.date > t ? '<span class="badge b-now">Future</span>' : ''}
    </div>`).join('');
  return `
    <div class="group-h"><span>Hourly rates</span><span>newest first</span></div>
    <div class="card">${list}</div>
    <p class="meta" style="margin:10px 4px">Each rate applies to shifts on or after its date until the next rate starts. Adding a raise updates all pay automatically.</p>`;
}

function settingsHtml() {
  const last = S.lastBackup ? `Last backup: ${fmtLong(ymdOf(new Date(S.lastBackup)))} (${daysSince(S.lastBackup)} days ago)` : 'Last backup: never';
  return `
    <div class="card panel">
      <h3>Backup</h3>
      <p>Your data is stored only on this device. Save a backup file to Google Drive, iCloud Files or email regularly. Restoring one replaces everything in the app.<br><b>${esc(last)}</b></p>
      <div class="btns">
        <button class="btn primary" type="button" data-action="backup">Export backup</button>
        <button class="btn" type="button" data-action="import">Import file</button>
      </div>
    </div>

    <div class="card panel">
      <h3>Spreadsheet export</h3>
      <p>CSV files that open in Excel or Google Sheets.</p>
      <div class="btns">
        <button class="btn" type="button" data-action="csvShifts">Timesheet CSV</button>
        <button class="btn" type="button" data-action="csvPeriods">Pay periods CSV</button>
        <button class="btn" type="button" data-action="csvRates">Pay rates CSV</button>
      </div>
    </div>

    <div class="card panel">
      <h3>Import from your Google Sheet</h3>
      <p>In Google Sheets, open the <b>Timesheet</b> tab → File → Download → CSV. Do the same for the <b>Pay Rates</b> tab. Then use <b>Import file</b> above for each CSV. Columns are matched by name (Date, Start, End / Date, Rate). Duplicates are skipped.</p>
    </div>

    <div class="card panel">
      <h3>Estimated deductions</h3>
      <p>Taxes and other deductions taken from gross pay. Used for estimated net pay.</p>
      <div class="inline">
        <input id="deduct" type="number" inputmode="decimal" min="0" max="99" step="0.1" value="${S.settings.deductionPct}">
        <button class="btn primary" type="button" data-action="saveDeduct">Save %</button>
      </div>
    </div>

    <div class="card panel">
      <h3>Pay schedule</h3>
      <p style="margin-bottom:0">1st–15th is paid on the last day of the month. 16th–end of month is paid on the 15th of the next month. Paydays that land on a Saturday or Sunday move to the Friday before.</p>
    </div>

    <p class="meta" id="storageStatus" style="margin:12px 4px"></p>`;
}

async function refreshStorageStatus() {
  const el = $('#storageStatus');
  if (!el || !navigator.storage || !navigator.storage.persisted) return;
  const persisted = await navigator.storage.persisted();
  el.textContent = persisted
    ? 'Storage is marked persistent, so the browser won’t clear it to free up space.'
    : 'Storage is not marked persistent. Installing the app to your home screen helps. Keep regular backups.';
}

/* ================= Dialogs ================= */

function openShift(shift) {
  const latest = [...S.shifts].sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start))[0];
  const s = shift || { date: today(), start: latest ? latest.start : '09:00', end: latest ? latest.end : '17:00' };
  $('#form').innerHTML = `
    <h2>${shift ? 'Edit shift' : 'Add shift'}</h2>
    <label for="f-date">Date</label>
    <input id="f-date" type="date" value="${s.date}" required>
    <div class="two">
      <div><label for="f-start">Start time</label><input id="f-start" type="time" value="${s.start}" required></div>
      <div><label for="f-end">End time</label><input id="f-end" type="time" value="${s.end}" required></div>
    </div>
    <div class="preview" id="preview"></div>
    <div class="actions">
      ${shift ? '<button class="btn danger" type="button" id="del">Delete</button>' : ''}
      <button class="btn" type="button" id="cancel">Cancel</button>
      <button class="btn primary" type="submit">Save</button>
    </div>`;
  const preview = () => {
    const date = $('#f-date').value, start = $('#f-start').value, end = $('#f-end').value;
    const h = calcHours(start, end), rate = isYmd(date) ? rateFor(date) : 0;
    const overnight = isHm(start) && isHm(end) && end < start;
    $('#preview').innerHTML = (rate
      ? `${hrs(h)} h × ${money(rate)}/hr = <b>${money(h * rate)}</b>`
      : `${hrs(h)} h · <b>no pay rate for this date</b>`) + (overnight ? '<div class="meta">Overnight shift</div>' : '');
  };
  $('#form').oninput = preview;
  preview();
  $('#form').onsubmit = ev => {
    ev.preventDefault();
    const data = { date: $('#f-date').value, start: $('#f-start').value, end: $('#f-end').value };
    if (!isYmd(data.date) || !isHm(data.start) || !isHm(data.end)) return toast('Pick a date, start time and end time.');
    if (shift) Object.assign(shift, data);
    else S.shifts.push({ id: uid(), ...data });
    $('#dlg').close();
    commit(shift ? 'Shift updated' : 'Shift added');
  };
  if (shift) armDelete(() => { S.shifts = S.shifts.filter(x => x !== shift); commit('Shift deleted'); });
  showDialog();
}

function openRate(rate) {
  const r = rate || { date: today(), rate: '' };
  $('#form').innerHTML = `
    <h2>${rate ? 'Edit pay rate' : 'Add pay rate'}</h2>
    <label for="r-rate">Hourly rate ($)</label>
    <input id="r-rate" type="number" inputmode="decimal" step="0.01" min="0.01" value="${r.rate}" required placeholder="e.g. 25.00">
    <label for="r-date">Effective from</label>
    <input id="r-date" type="date" value="${r.date}" required>
    <div class="preview">Applies to every shift on or after this date until the next rate starts.</div>
    <div class="actions">
      ${rate ? '<button class="btn danger" type="button" id="del">Delete</button>' : ''}
      <button class="btn" type="button" id="cancel">Cancel</button>
      <button class="btn primary" type="submit">Save</button>
    </div>`;
  $('#form').oninput = null;
  $('#form').onsubmit = ev => {
    ev.preventDefault();
    const data = { date: $('#r-date').value, rate: round2(Number($('#r-rate').value)) };
    if (!isYmd(data.date) || !(data.rate > 0)) return toast('Enter a rate and a date.');
    const clash = S.rates.find(x => x.date === data.date && x !== rate);
    if (clash) return toast('There is already a rate starting on that date.');
    if (rate) Object.assign(rate, data);
    else S.rates.push({ id: uid(), ...data });
    $('#dlg').close();
    commit(rate ? 'Rate updated' : 'Rate added');
  };
  if (rate) armDelete(() => { S.rates = S.rates.filter(x => x !== rate); commit('Rate deleted'); });
  showDialog();
}

// Delete needs two taps so a stray touch can't remove anything.
function armDelete(action) {
  const btn = $('#del');
  btn.onclick = () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Tap to confirm';
      return;
    }
    $('#dlg').close();
    action();
  };
}

function showDialog() {
  $('#cancel').onclick = () => $('#dlg').close();
  $('#dlg').showModal();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.style.display = 'none'), 3500);
}

/* ================= Export ================= */

// On phones, use the share sheet (Drive, Files, email…); elsewhere, download.
async function deliverFile(name, type, text) {
  const file = new File([text], name, { type });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

async function exportBackup() {
  const stamp = new Date().toISOString();
  const data = { app: 'pay-tracker', version: 1, exported: stamp, shifts: S.shifts, rates: S.rates, settings: S.settings };
  const ok = await deliverFile(`pay-tracker-backup-${today()}.json`, 'application/json', JSON.stringify(data, null, 2));
  if (!ok) return;
  S.lastBackup = stamp;
  commit('Backup exported');
}

const csvCell = v => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');

function exportCsv(kind) {
  let rows;
  if (kind === 'shifts') {
    rows = [['Date', 'Start Time', 'End Time', 'Hours', 'Rate', 'Pay']].concat(
      [...S.shifts].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
        .map(s => [s.date, s.start, s.end, hrs(shiftHours(s)), rateFor(s.date).toFixed(2), shiftPay(s).toFixed(2)]));
  } else if (kind === 'periods') {
    rows = [['Period Start', 'Period End', 'Pay Date', 'Hours', 'Gross Pay', 'Est. Net Pay']].concat(
      computePeriods().reverse().map(p => [p.start, p.end, p.payDate, hrs(p.hours), p.gross.toFixed(2), p.net.toFixed(2)]));
  } else {
    rows = [['Effective Date', 'Hourly Rate']].concat(S.rates.map(r => [r.date, r.rate.toFixed(2)]));
  }
  const name = { shifts: 'timesheet', periods: 'pay-periods', rates: 'pay-rates' }[kind];
  deliverFile(`${name}-${today()}.csv`, 'text/csv', toCsv(rows));
}

/* ================= Import ================= */

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function makeYmd(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? ymdOf(dt) : '';
}

// Accepts 2026-01-05, 2026/01/05, 1/5/2026 (month first unless the first number is over 12), or anything Date can parse.
function looseDate(s) {
  s = String(s).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return makeYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3] < 100 ? +m[3] + 2000 : +m[3];
    return a > 12 ? makeYmd(y, b, a) : makeYmd(y, a, b);
  }
  const t = Date.parse(s);
  return isNaN(t) ? '' : ymdOf(new Date(t));
}

// Accepts 09:00, 9:00:00, 9:00 AM, 9:00:00 p.m., or a date-time ending in a time.
function looseTime(s) {
  const m = String(s).trim().match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?$/i);
  if (!m) return '';
  let h = +m[1];
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  const hm = `${pad(h)}:${m[2]}`;
  return isHm(hm) ? hm : '';
}

function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('That CSV file has no data rows.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = word => head.findIndex(h => h.includes(word));
  const iDate = col('date'), iStart = col('start'), iEnd = col('end'), iRate = col('rate');
  if (col('period') >= 0) throw new Error('Pay periods are calculated automatically. Import the Timesheet and Pay Rates CSVs instead.');
  if (iDate < 0) throw new Error('Could not find a Date column in that CSV.');
  let added = 0, skipped = 0;

  if (iStart >= 0 && iEnd >= 0) {
    const seen = new Set(S.shifts.map(s => `${s.date}|${s.start}|${s.end}`));
    for (const r of rows.slice(1)) {
      const s = { date: looseDate(r[iDate] || ''), start: looseTime(r[iStart] || ''), end: looseTime(r[iEnd] || '') };
      const key = `${s.date}|${s.start}|${s.end}`;
      if (!s.date || !s.start || !s.end || seen.has(key)) { skipped++; continue; }
      seen.add(key);
      S.shifts.push({ id: uid(), ...s });
      added++;
    }
    return `Imported ${added} shift${added === 1 ? '' : 's'}` + (skipped ? `, skipped ${skipped}` : '');
  }

  if (iRate >= 0) {
    for (const r of rows.slice(1)) {
      const date = looseDate(r[iDate] || '');
      const rate = round2(parseFloat(String(r[iRate] || '').replace(/[^0-9.]/g, '')));
      if (!date || !(rate > 0)) { skipped++; continue; }
      const existing = S.rates.find(x => x.date === date);
      if (existing) existing.rate = rate;
      else S.rates.push({ id: uid(), date, rate });
      added++;
    }
    return `Imported ${added} pay rate${added === 1 ? '' : 's'}` + (skipped ? `, skipped ${skipped}` : '');
  }

  throw new Error('Could not tell what that CSV is. It needs Date, Start and End columns, or Date and Rate columns.');
}

async function importFile(file) {
  try {
    const text = await file.text();
    if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
      const raw = JSON.parse(text);
      if (raw.app !== 'pay-tracker') throw new Error('That file is not a Pay Tracker backup.');
      const next = normalize(raw);
      const msg = `Replace ALL current data with this backup?\n\nBackup: ${next.shifts.length} shifts, ${next.rates.length} rates.\nCurrent: ${S.shifts.length} shifts, ${S.rates.length} rates.`;
      if (!confirm(msg)) return;
      next.lastBackup = raw.exported || new Date().toISOString();
      S = next;
      commit('Backup restored');
    } else {
      const msg = importCsv(text);
      commit(msg);
    }
  } catch (e) {
    toast(e instanceof SyntaxError ? 'That file could not be read.' : e.message);
  }
}

/* ================= Events ================= */

document.querySelector('nav').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  VIEW = b.dataset.view;
  render();
  window.scrollTo(0, 0);
});

$('#settingsBtn').onclick = () => {
  VIEW = VIEW === 'settings' ? 'timesheet' : 'settings';
  render();
  window.scrollTo(0, 0);
};

$('#fab').onclick = () => (VIEW === 'rates' ? openRate() : openShift());

$('#view').addEventListener('click', ev => {
  const action = ev.target.closest('[data-action]');
  if (action) {
    const a = action.dataset.action;
    if (a === 'backup') return exportBackup();
    if (a === 'import') return $('#importFile').click();
    if (a === 'csvShifts') return exportCsv('shifts');
    if (a === 'csvPeriods') return exportCsv('periods');
    if (a === 'csvRates') return exportCsv('rates');
    if (a === 'gotoRates') { VIEW = 'rates'; render(); return openRate(); }
    if (a === 'saveDeduct') {
      const pct = Number($('#deduct').value);
      if (!(pct >= 0 && pct < 100)) return toast('Enter a percentage between 0 and 99.');
      S.settings.deductionPct = pct;
      return commit('Deductions saved');
    }
  }
  const shift = ev.target.closest('[data-shift]');
  if (shift) return openShift(S.shifts.find(s => s.id === shift.dataset.shift));
  const rate = ev.target.closest('[data-rate]');
  if (rate) return openRate(S.rates.find(r => r.id === rate.dataset.rate));
  const period = ev.target.closest('[data-period]');
  if (period) {
    const k = period.dataset.period;
    openPeriods.has(k) ? openPeriods.delete(k) : openPeriods.add(k);
    period.classList.toggle('open');
  }
});

$('#importFile').onchange = ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (file) importFile(file);
};

// Re-render when the app comes back to the foreground so "today" stays correct.
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

/* ================= Start ================= */

(async function start() {
  try {
    S = await load();
  } catch (e) {
    toast('Could not open storage: ' + e.message);
  }
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

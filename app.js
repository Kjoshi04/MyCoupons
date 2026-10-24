'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const dfmt = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const APP_VERSION = 'v5';
const LABEL = { available: 'Available', expiring: 'Expiring soon', expired: 'Expired', used: 'Used' };
let offers = [], settings = { ...DEFAULT_SETTINGS }, editId = null, tt;
const ui = { status: 'available', q: '', source: '', cat: '', sort: 'expiry' };

const load = async () => { offers = await getAll(); settings = await getSettings(); };
const route = () => location.hash.slice(1) || 'home';
const go = r => location.hash === '#' + r ? render() : (location.hash = r);
const inTab = (o, k) => { const s = statusOf(o); return k === 'available' ? (s === 'available' || s === 'expiring') : s === k; };
const count = k => offers.filter(o => inTab(o, k)).length;
const opts = (list, sel, lab = x => x) => list.map(x => `<option value="${esc(x)}"${x === sel ? ' selected' : ''}>${esc(lab(x))}</option>`).join('');
const byExpiry = (a, b) => (a.noExpiry ? '9999' : a.expiry).localeCompare(b.noExpiry ? '9999' : b.expiry);
const sorters = { expiry: byExpiry, newest: (a, b) => b.created - a.created, name: (a, b) => a.name.localeCompare(b.name) };

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(tt); tt = setTimeout(() => { t.className = ''; }, 4000);
}
function ask(title, text, buttons) {
  return new Promise(res => {
    const d = $('#dlg');
    d.innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
    d.onclick = e => { const b = e.target.closest('button'); if (b) { d.close(); res(buttons[b.dataset.i].value); } };
    d.oncancel = () => res(null);
    d.showModal();
  });
}
const confirmBox = (t, x, label) => ask(t, x, [{ label: 'Cancel', value: false, cls: 'alt' }, { label, value: true, cls: 'danger' }]);
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch { const x = document.createElement('textarea'); x.value = t; x.style.position = 'fixed'; document.body.append(x); x.select(); const ok = document.execCommand('copy'); x.remove(); if (!ok) throw new Error('Copy is not supported here'); }
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function getReg() {
  if (!('serviceWorker' in navigator)) return null;
  const r = await navigator.serviceWorker.getRegistration();
  if (!r) return null;
  if (r.active) return r;
  return Promise.race([navigator.serviceWorker.ready, new Promise(res => setTimeout(() => res(null), 3000))]);
}
async function markBackup() { settings.lastBackup = new Date().toISOString(); await setMeta('settings', settings); if (route() === 'backup') render(); }

/* ---------- Views ---------- */
const empty = (t, x, btns) => `<div class="empty"><div class="big" aria-hidden="true">🎟️</div><h2>${esc(t)}</h2><p>${esc(x)}</p>${btns ? `<div class="row center"><a class="btn" href="#add" data-act="new">Add an offer</a><button class="btn alt" data-act="samples">Load sample offers</button></div>` : ''}</div>`;

function card(o) {
  const s = statusOf(o), d = daysLeft(o);
  const plural = n => n + ' day' + (n === 1 ? '' : 's');
  const exp = o.noExpiry ? 'No expiry'
    : s === 'used' ? 'Expiry: ' + dfmt(o.expiry)
    : s === 'expired' ? `Expired ${dfmt(o.expiry)} (${plural(-d)} ago)`
    : `Expires ${dfmt(o.expiry)} · ${d === 0 ? 'today' : plural(d) + ' left'}`;
  const det = [['Terms', o.terms], ['Minimum purchase', o.minPurchase === '' ? '' : '₹' + o.minPurchase], ['Notes', o.notes],
    ['Reminders', o.noExpiry ? '' : (effReminders(o, settings).map(n => n + ' day').join(', ') || 'None')]].filter(r => r[1]);
  return `<article class="card ${s}"><div class="top"><h3>${esc(o.name)}</h3><span class="badge ${s}">${LABEL[s]}</span></div>
    <p class="meta">${esc(srcLabel(o))} · ${esc(cap(o.category))}${o.sample ? ' · Sample' : ''}</p>
    ${o.benefit ? `<p>${esc(o.benefit)}</p>` : ''}
    ${o.code ? `<div class="code"><code>${esc(o.code)}</code><button class="btn small" data-act="copy" data-id="${o.id}" aria-label="Copy code ${esc(o.code)}">Copy</button></div>` : ''}
    <p class="exp ${s}">${exp}</p>
    <details><summary>Details</summary>${det.length ? det.map(r => `<p><b>${r[0]}:</b> ${esc(r[1])}</p>`).join('') : '<p>No extra details.</p>'}</details>
    <div class="row"><button class="btn small alt" data-act="edit" data-id="${o.id}">Edit</button>
    <button class="btn small alt" data-act="toggleUsed" data-id="${o.id}">${o.used ? 'Mark as not used' : 'Mark as used'}</button>
    <button class="btn small danger" data-act="del" data-id="${o.id}">Delete</button></div></article>`;
}

function viewHome() {
  const c = { available: count('available'), expiring: count('expiring'), expired: count('expired'), used: count('used') };
  const alerts = offers.filter(o => !o.used && !o.noExpiry && daysLeft(o) >= 0 && effReminders(o, settings).some(n => daysLeft(o) <= n)).sort(byExpiry);
  const lbT = settings.lastBackup ? Date.parse(settings.lastBackup) : 0;
  const unsaved = offers.filter(o => !o.sample && o.updated > lbT).length;
  const oldBk = offers.length && lbT && (Date.now() - lbT) / 864e5 > 30;
  return `<h1>Dashboard</h1>
    ${unsaved ? `<div class="note warn"><b>${unsaved} offer${unsaved > 1 ? 's are' : ' is'} not backed up yet.</b> ${lbT ? '' : 'You have never made a backup. '}<a href="#backup">Back up now</a></div>` : oldBk ? '<div class="note warn">Your last backup is over 30 days old. <a href="#backup">Back up now</a></div>' : ''}
    <div class="tiles">${['available', 'expiring', 'expired', 'used'].map(k => `<button class="tile ${k}" data-act="goto" data-s="${k}"><b>${c[k]}</b><span>${LABEL[k]}</span></button>`).join('')}</div>
    <p class="hint">“Available” includes offers that are expiring soon.</p>
    ${alerts.length ? `<h2>Needs attention (${alerts.length})</h2>${alerts.map(card).join('')}` : ''}
    ${offers.length ? '' : empty('Your wallet is empty', 'Add your first offer, or load sample offers to try the app.', true)}`;
}

function viewOffers() {
  return `<h1>Offers</h1>
    <div class="tabs" role="tablist">${Object.keys(LABEL).map(k => `<button role="tab" aria-selected="${ui.status === k}" data-act="tab" data-s="${k}">${LABEL[k]} (${count(k)})</button>`).join('')}</div>
    <input id="q" type="search" placeholder="Search name, code or source" aria-label="Search offers" value="${esc(ui.q)}" autocomplete="off">
    <div class="filters">
      <select id="fsrc" aria-label="Filter by source"><option value="">All sources</option>${opts(SOURCES, ui.source)}</select>
      <select id="fcat" aria-label="Filter by category"><option value="">All categories</option>${opts(CATS, ui.cat, cap)}</select>
      <select id="fsort" aria-label="Sort by"><option value="expiry"${ui.sort === 'expiry' ? ' selected' : ''}>By expiry</option><option value="newest"${ui.sort === 'newest' ? ' selected' : ''}>Newest</option><option value="name"${ui.sort === 'name' ? ' selected' : ''}>By name</option></select>
    </div>
    <button class="link" data-act="clear">Clear search and filters</button>
    <div id="list"></div>`;
}
function renderList() {
  const q = ui.q.trim().toLowerCase();
  const list = offers.filter(o => inTab(o, ui.status) && (!ui.source || o.source === ui.source) && (!ui.cat || o.category === ui.cat) &&
    (!q || [o.name, o.code, o.source, o.sourceName].join(' ').toLowerCase().includes(q))).sort(sorters[ui.sort]);
  $('#list').innerHTML = list.length ? list.map(card).join('')
    : offers.length ? empty('No offers here', 'Nothing matches this tab and these filters.') : empty('Your wallet is empty', 'Add your first offer to get started.', true);
}

function viewForm() {
  const o = editId && offers.find(x => x.id === editId); if (editId && !o) editId = null;
  const v = o || { name: '', source: 'Amazon', sourceName: '', code: '', category: 'shopping', benefit: '', noExpiry: false, expiry: '', terms: '', minPurchase: '', notes: '', reminders: settings.reminders };
  return `<h1>${o ? 'Edit offer' : 'Add new offer'}</h1>
  <form id="form" novalidate>
    <div id="ferr" role="alert" class="ferr"></div>
    <label>Offer name *<input name="name" maxlength="120" value="${esc(v.name)}" autocomplete="off"></label>
    <label>Source / platform<select name="source" id="src">${opts(SOURCES, v.source)}</select></label>
    <label id="srcname"${['Bank offer', 'Other'].includes(v.source) ? '' : ' hidden'}>Bank or custom source name<input name="sourceName" maxlength="60" value="${esc(v.sourceName)}" placeholder="e.g. HDFC Bank, Swiggy"></label>
    <label>Coupon or promo code (optional)<input name="code" maxlength="60" value="${esc(v.code)}" autocapitalize="characters" autocomplete="off"></label>
    <label>Category<select name="category">${opts(CATS, v.category, cap)}</select></label>
    <label>Discount or benefit<textarea name="benefit" rows="2" maxlength="500">${esc(v.benefit)}</textarea></label>
    <label class="chk"><input type="checkbox" name="noExpiry" id="noexp"${v.noExpiry ? ' checked' : ''}> No expiry</label>
    <label>Expiry date<input type="date" name="expiry" id="exp" value="${esc(v.expiry)}"${v.noExpiry ? ' disabled' : ''}></label>
    <label>Terms and conditions<textarea name="terms" rows="3" maxlength="2000">${esc(v.terms)}</textarea></label>
    <label>Minimum purchase in ₹ (optional)<input name="minPurchase" inputmode="decimal" value="${esc(v.minPurchase)}"></label>
    <label>Personal notes<textarea name="notes" rows="2" maxlength="2000">${esc(v.notes)}</textarea></label>
    <fieldset><legend>Remind me before expiry</legend>
      ${[7, 3, 1].map(n => `<label class="chk"><input type="checkbox" name="rem" value="${n}"${v.reminders.includes(n) ? ' checked' : ''}> ${n} day${n > 1 ? 's' : ''} before</label>`).join('')}
      <p class="hint">A reminder also has to be switched on in Settings.</p></fieldset>
    <div class="row"><button class="btn" type="submit">${o ? 'Save changes' : 'Save offer'}</button><button class="btn alt" type="button" data-act="cancel">Cancel</button></div>
  </form>`;
}
async function saveForm(f) {
  const fd = new FormData(f), g = k => (fd.get(k) || '').toString().trim(), err = [];
  const noExpiry = fd.get('noExpiry') === 'on', expiry = g('expiry'), mp = g('minPurchase');
  if (!g('name')) err.push('Enter an offer name.');
  if (!noExpiry && !isISO(expiry)) err.push('Choose a valid expiry date, or tick “No expiry”.');
  if (mp !== '' && !(Number(mp) >= 0)) err.push('Minimum purchase must be a number, 0 or more.');
  if (err.length) { $('#ferr').innerHTML = err.map(e => `<p>${esc(e)}</p>`).join(''); $('#ferr').scrollIntoView({ block: 'center' }); return; }
  const old = editId && offers.find(x => x.id === editId);
  try {
    const o = cleanOffer({ ...(old || {}), id: old ? old.id : newId(), name: g('name'), source: g('source'), sourceName: ['Bank offer', 'Other'].includes(g('source')) ? g('sourceName') : '',
      code: g('code'), category: g('category'), benefit: g('benefit'), noExpiry, expiry: noExpiry ? '' : expiry, terms: g('terms'), minPurchase: mp,
      notes: g('notes'), reminders: fd.getAll('rem').map(Number), created: old ? old.created : Date.now(), updated: Date.now() });
    await putOffer(o); await load(); editId = null; ui.status = statusOf(o);
    toast(old ? 'Changes saved' : 'Offer saved'); go('offers');
  } catch (e) { toast('Could not save: ' + e.message, true); }
}

function viewBackup() {
  const lb = settings.lastBackup ? new Date(settings.lastBackup).toLocaleString('en-IN', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  return `<h1>Backup and restore</h1>
  <section class="panel"><p><b>${offers.length}</b> offer(s) are stored on this phone. Last backup: <b>${esc(lb)}</b>.</p>
    <p class="hint">Your offers live only in this browser. Clearing Chrome’s site data deletes them, so keep a backup outside the app.</p></section>
  <section class="panel"><h2>1. Back up</h2>
    <div class="stack"><button class="btn" data-act="sharetext">Send backup as text (Gmail, Keep, WhatsApp)</button>
    <button class="btn alt" data-act="copytext">Copy backup text</button>
    <button class="btn alt" data-act="export">Download backup file</button>
    <button class="btn alt" data-act="share">Share backup file (e.g. Google Drive)</button></div>
    <details><summary>Where should I send it?</summary><p>Best: email it to yourself in Gmail, or save it as a note in Google Keep. Both sync with your Google account, so the backup survives even if you lose the phone. Search your email for “My Benefits Wallet backup” when you need it.</p></details></section>
  <section class="panel"><h2>2. Restore</h2>
    <label>Paste backup text<textarea id="paste" rows="4" placeholder="Paste the backup text here"></textarea></label>
    <button class="btn" data-act="pastein">Restore from pasted text</button>
    <p class="hint">Or restore from a file:</p>
    <label class="btn alt filebtn">Choose backup file<input type="file" id="file" aria-label="Choose backup file"></label></section>
  <section class="panel"><h2>Test the backup</h2><p class="hint">Checks that your current data can be exported and read back without losing anything. It does not change your data.</p>
    <button class="btn alt" data-act="selftest">Run backup self-test</button></section>
  <p class="hint">App version: ${APP_VERSION}</p>`;
}
async function importFile(file, input) {
  if (!file) return;
  if (file.size > 20e6) { toast('That file is too large to be a backup.', true); return; }
  let text;
  try { text = await file.text(); if (input) input.value = ''; }
  catch (e) { toast('Could not read “' + file.name + '”: ' + e.message, true); return; }
  return importText(text);
}
async function importText(text) {
  let p;
  try { p = parseBackup(text); } catch (e) { toast(e.message, true); return; }
  const skip = p.errors.length ? `\n\n${p.errors.length} invalid offer(s) will be skipped:\n${p.errors.slice(0, 4).join('\n')}` : '';
  const ch = await ask('Restore backup', `Found ${p.offers.length} valid offer(s).${skip}\n\nMerge keeps your current offers and adds new ones without duplicates. Replace erases current offers first.`,
    [{ label: 'Cancel', value: null, cls: 'alt' }, { label: 'Merge', value: 'merge' }, { label: 'Replace all', value: 'replace', cls: 'danger' }]);
  try {
    if (ch === 'merge') { const r = await mergeOffers(p.offers); toast(`Merged: ${r.added} added, ${r.updated} updated, ${r.skipped} duplicate(s) skipped`); }
    else if (ch === 'replace') {
      if (!await confirmBox('Replace all data?', 'All offers on this phone will be erased and replaced by the backup. This cannot be undone.', 'Yes, replace')) return;
      await putMany(p.offers, true); if (p.settings) await setMeta('settings', { ...settings, ...p.settings }); toast(`Restored ${p.offers.length} offer(s)`);
    } else return;
    await load(); render();
  } catch (e) { toast('Restore failed: ' + e.message, true); }
}
async function selfTest() {
  const b = await buildBackup(), p = parseBackup(JSON.stringify(b));
  const key = l => JSON.stringify(l.slice().sort((x, y) => x.id.localeCompare(y.id)));
  const same = p.errors.length === 0 && p.offers.length === b.offers.length && key(p.offers) === key(b.offers.map(cleanOffer));
  toast(same ? `Self-test passed: ${b.offers.length} offer(s) exported and read back identically.` : 'Self-test FAILED: ' + (p.errors[0] || 'the data changed during the round trip.'), !same);
}

function viewSettings() {
  return `<h1>Settings</h1>
  <section class="panel"><h2>Reminder preferences</h2><p class="hint">Choose which reminders are active. Offers marked No expiry or Used never get reminders.</p>
    ${[7, 3, 1].map(n => `<label class="chk"><input type="checkbox" class="rem-set" value="${n}"${settings.reminders.includes(n) ? ' checked' : ''}> ${n} day${n > 1 ? 's' : ''} before expiry</label>`).join('')}</section>
  <section class="panel"><h2>Notifications</h2><p id="nstat" class="hint"></p>
    <div class="row"><button class="btn" data-act="notif">Allow notifications</button><button class="btn alt" data-act="testnotif">Send test</button></div>
    <p id="pstat" class="hint"></p>
    <details><summary>How this works when the app is closed</summary><p>Reminders always appear on the Home screen when you open the app. Notifications are checked each time you open the app, and Chrome may also check in the background if the app is installed, but Chrome decides when, so this is not guaranteed. For guaranteed alerts use the calendar file below.</p></details></section>
  <section class="panel"><h2>Guaranteed reminders: Google Calendar</h2>
    <p class="hint">Downloads a .ics file with one all-day event per upcoming reminder. Open it on your phone or laptop to add the events to Google Calendar, which then alerts you even when this app is closed.</p>
    <button class="btn" data-act="calendar">Download calendar file</button></section>
  <section class="panel"><h2>Storage</h2><p id="sstat" class="hint"></p><p class="hint">App version: ${APP_VERSION}</p></section>
  <section class="panel"><h2>Sample data and reset</h2>
    <div class="stack"><button class="btn alt" data-act="samples">Load sample offers</button><button class="btn alt" data-act="rmsamples">Remove sample offers</button>
    <button class="btn danger" data-act="wipe">Delete ALL offers</button></div></section>`;
}
async function fillStatus() {
  const n = $('#nstat'); if (!n) return;
  n.textContent = !('Notification' in window) ? 'This browser does not support notifications.'
    : { granted: 'Notifications are allowed.', denied: 'Notifications are blocked. Turn them on in Chrome → Site settings → Notifications.', default: 'Notifications have not been allowed yet.' }[Notification.permission];
  let p = 'Background checks: ';
  try {
    const reg = await getReg();
    if (!reg) p += 'the app’s background worker is not active. Open the app at http://localhost:8000 (not by double-clicking the file) and reload. ';
    else if (!('periodicSync' in reg)) p += 'not supported here, so reminders show when you open the app.';
    else p += (await reg.periodicSync.getTags()).includes('check-expiry') ? 'registered. Chrome decides when they run.' : 'not registered yet. Allow notifications, ideally after installing the app.';
  } catch { p += 'unavailable.'; }
  const ps = $('#pstat'); if (ps) ps.textContent = p;
  let st = 'unknown'; try { st = (await navigator.storage.persisted()) ? 'yes, Chrome marked your data as persistent.' : 'not guaranteed, so keep regular backups.'; } catch { /* ignore */ }
  const s = $('#sstat'); if (s) s.textContent = 'Protected from automatic cleanup: ' + st;
}
async function registerPeriodic() {
  try { const reg = await getReg(); if (!reg || !('periodicSync' in reg)) return false; await reg.periodicSync.register('check-expiry', { minInterval: 12 * 3600e3 }); return true; } catch { return false; }
}
async function checkReminders() {
  try { if ('Notification' in window && Notification.permission === 'granted') { const reg = await getReg(); if (reg) await notifyDue(reg); } } catch { /* ignore */ }
}
function exportCalendar() {
  const t = todayISO(), stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z', esc2 = s => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n'), ev = [];
  offers.forEach(o => {
    if (o.used || o.noExpiry) return;
    effReminders(o, settings).forEach(n => {
      const day = addDays(o.expiry, -n); if (day < t) return;
      ev.push(['BEGIN:VEVENT', `UID:${o.id}-${n}@benefits-wallet`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(day, 1).replace(/-/g, '')}`,
        `SUMMARY:${esc2(`${o.name} expires ${n === 1 ? 'tomorrow' : 'in ' + n + ' days'}`)}`,
        `DESCRIPTION:${esc2(`${srcLabel(o)}${o.code ? ' | Code: ' + o.code : ''} | Expires ${o.expiry}`)}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Offer reminder', 'TRIGGER:PT9H', 'END:VALARM', 'END:VEVENT'].join('\r\n'));
    });
  });
  if (!ev.length) { toast('No upcoming reminders to export.', true); return; }
  download('benefits-wallet-reminders.ics', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//My Benefits Wallet//EN\r\nCALSCALE:GREGORIAN\r\n' + ev.join('\r\n') + '\r\nEND:VCALENDAR\r\n', 'text/calendar');
  toast(`Calendar file created with ${ev.length} reminder(s).`);
}
function samples() {
  const t = todayISO();
  const mk = (name, source, sourceName, code, category, benefit, off, extra = {}) => cleanOffer({ name, source, sourceName, code, category, benefit, noExpiry: off == null, expiry: off == null ? '' : addDays(t, off), terms: 'Sample terms apply.', sample: true, ...extra });
  return [mk('Sample: 10% off first order', 'Amazon', '', 'SAVE10', 'shopping', '10% off up to ₹150', 2),
    mk('Sample: Free delivery', 'Flipkart', '', '', 'shopping', 'Free delivery above ₹500', 20),
    mk('Sample: Card cashback', 'Bank offer', 'Sample Bank', 'CARD5', 'banking', '5% cashback on dining', -3),
    mk('Sample: Gym membership', 'Employer benefit', '', '', 'employer benefits', 'Free monthly membership', null),
    mk('Sample: Used voucher', 'Meesho', '', 'MEE50', 'shopping', '₹50 off', 10, { used: true })];
}

/* ---------- Rendering and events ---------- */
function render() {
  const r = route(), views = { home: viewHome, offers: viewOffers, add: viewForm, backup: viewBackup, settings: viewSettings };
  $('#view').innerHTML = (views[r] || viewHome)();
  document.querySelectorAll('nav a').forEach(a => a.setAttribute('aria-current', a.getAttribute('href') === '#' + r ? 'page' : 'false'));
  if (r === 'offers') renderList();
  if (r === 'settings') fillStatus();
}
addEventListener('hashchange', () => { render(); scrollTo(0, 0); });

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id, o = offers.find(x => x.id === id);
  try {
    switch (a) {
      case 'new': editId = null; if (location.hash === '#add') render(); break;
      case 'goto': ui.status = b.dataset.s; go('offers'); break;
      case 'tab': ui.status = b.dataset.s; render(); break;
      case 'clear': Object.assign(ui, { q: '', source: '', cat: '', sort: 'expiry' }); render(); break;
      case 'copy': await copyText(o.code); toast('Copied ' + o.code); break;
      case 'edit': editId = id; go('add'); break;
      case 'cancel': editId = null; go('offers'); break;
      case 'del':
        if (await confirmBox('Delete this offer?', `“${o.name}” will be permanently deleted from this phone. This cannot be undone.`, 'Delete')) { await delOffer(id); await load(); render(); toast('Offer deleted'); }
        break;
      case 'toggleUsed': { const n = { ...o, used: !o.used, updated: Date.now() }; await putOffer(n); await load(); render(); toast(n.used ? 'Marked as used' : 'Moved back to active offers'); break; }
      case 'export': { const j = JSON.stringify(await buildBackup(), null, 2); download(`benefits-wallet-backup-${todayISO()}.json`, j, 'application/json'); await markBackup(); toast('Backup downloaded. Check your Downloads folder.'); break; }
      case 'share': {
        const f = new File([JSON.stringify(await buildBackup(), null, 2)], `benefits-wallet-backup-${todayISO()}.json`, { type: 'application/json' });
        if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: 'My Benefits Wallet backup' }); await markBackup(); toast('Backup shared'); }
        else toast('Sharing files is not supported here. Use Export backup instead.', true);
        break;
      }
      case 'pastein': { const raw = $('#paste').value, i = raw.indexOf('{'), j = raw.lastIndexOf('}'), t = i >= 0 && j > i ? raw.slice(i, j + 1) : raw.trim(); if (!t) { toast('Paste the backup text first.', true); break; } await importText(t); break; }
      case 'copytext': await copyText(JSON.stringify(await buildBackup())); await markBackup(); toast('Backup copied. Paste it into an email to yourself or a Google Keep note.'); break;
      case 'sharetext': {
        const t = JSON.stringify(await buildBackup());
        if (navigator.share) { await navigator.share({ title: 'My Benefits Wallet backup ' + todayISO(), text: t }); await markBackup(); toast('Backup shared. Check that it arrived in Gmail or Keep.'); }
        else { await copyText(t); await markBackup(); toast('Sharing is not available here, so the backup text was copied. Paste it into a note or email.'); }
        break;
      }
      case 'selftest': await selfTest(); break;
      case 'samples': { await putMany(samples(), false); await load(); render(); const n = offers.filter(x => x.sample).length; if (n) toast(n + ' sample offers are in your wallet. Remove them in Settings.'); else toast('Samples were not saved. Please tell me what the browser console says.', true); break; }
      case 'rmsamples': { const ids = offers.filter(x => x.sample).map(x => x.id); await delMany(ids); await load(); render(); toast(ids.length + ' sample offer(s) removed'); break; }
      case 'wipe': if (await confirmBox('Delete ALL offers?', 'Every offer on this phone will be permanently deleted. Export a backup first if you might need them.', 'Delete everything')) { await putMany([], true); await load(); render(); toast('All offers deleted'); } break;
      case 'notif': {
        if (!('Notification' in window)) { toast('This browser does not support notifications.', true); break; }
        const p = await Notification.requestPermission();
        if (p === 'granted') { await registerPeriodic(); toast('Notifications allowed'); await checkReminders(); } else toast(p === 'denied' ? 'Blocked. Turn on in Chrome → Site settings → Notifications.' : 'Permission was not given.', true);
        fillStatus(); break;
      }
      case 'testnotif':
        if (!('Notification' in window) || Notification.permission !== 'granted') { toast('Allow notifications first.', true); break; }
        { const opt = { body: 'Notifications are working on this device.', icon: 'icon-192.png' }, reg = await getReg();
          if (reg) await reg.showNotification('Test reminder', opt); else new Notification('Test reminder', opt);
          toast('Test sent. If you see nothing, check your phone/laptop notification settings (Do Not Disturb or Focus Assist).'); }
        break;
      case 'calendar': exportCalendar(); break;
    }
  } catch (err) { if (err && err.name === 'AbortError') return; toast('Something went wrong: ' + err.message, true); }
});
document.addEventListener('submit', e => { if (e.target.id === 'form') { e.preventDefault(); saveForm(e.target); } });
document.addEventListener('input', e => { if (e.target.id === 'q') { ui.q = e.target.value; renderList(); } });
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'file') { const f = t.files[0]; if (f) { toast('Reading ' + f.name + '…'); importFile(f, t); } }
  else if (t.id === 'src') $('#srcname').hidden = !['Bank offer', 'Other'].includes(t.value);
  else if (t.id === 'noexp') $('#exp').disabled = t.checked;
  else if (t.id === 'fsrc' || t.id === 'fcat' || t.id === 'fsort') { ui[{ fsrc: 'source', fcat: 'cat', fsort: 'sort' }[t.id]] = t.value; renderList(); }
  else if (t.classList.contains('rem-set')) {
    try { settings.reminders = [...document.querySelectorAll('.rem-set:checked')].map(x => +x.value); await setMeta('settings', settings); toast('Reminder preferences saved'); }
    catch (err) { toast('Could not save: ' + err.message, true); }
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load().then(() => { if (route() !== 'add') render(); checkReminders(); }).catch(() => {});
});

(async function init() {
  try { await load(); } catch (e) { $('#view').innerHTML = `<div class="note warn"><b>Storage is not available.</b> Your browser blocked local storage (private mode?). Open the app in a normal Chrome window. (${esc(e.message)})</div>`; return; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* ignore */ }
  render(); checkReminders();
})();

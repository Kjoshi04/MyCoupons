'use strict';
/* Shared by the page (app.js) and the service worker (sw.js): dates, database, backup rules, reminders. */
const TZ = 'Asia/Kolkata', DB_NAME = 'benefitsWallet', SOON_DAYS = 7;
const SOURCES = ['Amazon', 'Flipkart', 'Meesho', 'Bank offer', 'Employer benefit', 'Personify', 'Other'];
const CATS = ['shopping', 'food', 'travel', 'banking', 'entertainment', 'employer benefits', 'pharmacy', 'jewellery', 'other'];
const DEFAULT_SETTINGS = { reminders: [7, 3, 1], lastBackup: null };

/* ---------- Dates (all dates are plain "YYYY-MM-DD" text, today is taken in India time) ---------- */
const _fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const todayISO = () => _fmt.format(new Date());
const dayNum = s => Date.parse(s + 'T00:00:00Z') / 864e5;
const addDays = (s, n) => new Date((dayNum(s) + n) * 864e5).toISOString().slice(0, 10);
const isISO = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const daysLeft = (o, t = todayISO()) => (o.noExpiry || !o.expiry) ? null : dayNum(o.expiry) - dayNum(t);
function statusOf(o, t) {
  if (o.used) return 'used';
  if (o.noExpiry) return 'available';
  const d = daysLeft(o, t);
  return d < 0 ? 'expired' : d <= SOON_DAYS ? 'expiring' : 'available';
}
const srcLabel = o => o.sourceName ? (o.source === 'Other' ? o.sourceName : o.source + ': ' + o.sourceName) : o.source;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------- IndexedDB ---------- */
let _dbp;
const db = () => _dbp || (_dbp = new Promise((res, rej) => {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('offers', { keyPath: 'id' }); r.result.createObjectStore('meta'); };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => res(rq && rq.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Storage transaction was cancelled'));
  });
}
const getAll = () => tx('offers', 'readonly', s => s.getAll());
const putOffer = o => tx('offers', 'readwrite', s => s.put(o));
const delOffer = id => tx('offers', 'readwrite', s => s.delete(id));
const delMany = ids => tx('offers', 'readwrite', s => { ids.forEach(i => s.delete(i)); });
const putMany = (list, replace) => tx('offers', 'readwrite', s => { if (replace) s.clear(); list.forEach(o => s.put(o)); });
const getMeta = async (k, def) => { const v = await tx('meta', 'readonly', s => s.get(k)); return v === undefined ? def : v; };
const setMeta = (k, v) => tx('meta', 'readwrite', s => s.put(v, k));
const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await getMeta('settings', {})) });

/* ---------- Offer cleaning / validation (used for forms-in-backup and imports) ---------- */
function cleanOffer(r) {
  if (!r || typeof r !== 'object') throw new Error('not an offer');
  const s = (v, m) => typeof v === 'string' ? v.trim().slice(0, m) : '';
  const o = {
    id: s(r.id, 64) || newId(), name: s(r.name, 120),
    source: SOURCES.includes(r.source) ? r.source : 'Other', sourceName: s(r.sourceName, 60),
    code: s(r.code, 60), category: CATS.includes(r.category) ? r.category : 'other',
    benefit: s(r.benefit, 500), noExpiry: !!r.noExpiry, expiry: '',
    terms: s(r.terms, 2000),
    minPurchase: (r.minPurchase === '' || r.minPurchase == null) ? '' : Number(r.minPurchase),
    notes: s(r.notes, 2000),
    reminders: Array.isArray(r.reminders) ? r.reminders.filter(n => [7, 3, 1].includes(n)) : [7, 3, 1],
    used: !!r.used, sample: !!r.sample,
    created: Number(r.created) || Date.now(), updated: Number(r.updated) || Date.now()
  };
  if (!o.name) throw new Error('offer name is missing');
  if (!o.noExpiry) { if (!isISO(r.expiry)) throw new Error('"' + o.name + '" has an invalid expiry date'); o.expiry = r.expiry; }
  if (o.minPurchase !== '' && !(o.minPurchase >= 0)) o.minPurchase = '';
  return o;
}
const sig = o => [o.name, o.source, o.sourceName, o.code, o.noExpiry ? 'none' : o.expiry].join('|').toLowerCase();

/* ---------- Backup ---------- */
async function buildBackup() {
  return { app: 'my-benefits-wallet', version: 1, exportedAt: new Date().toISOString(), settings: await getSettings(), offers: await getAll() };
}
function parseBackup(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('This file is not a valid backup (it could not be read as JSON). Choose the .json file made by Export Backup.'); }
  if (!j || j.app !== 'my-benefits-wallet') throw new Error('This file is not a My Benefits Wallet backup.');
  if (j.version !== 1) throw new Error('This backup has an unsupported version (' + j.version + ').');
  if (!Array.isArray(j.offers)) throw new Error('The backup has no offers list.');
  const offers = [], errors = [];
  j.offers.forEach((r, i) => { try { offers.push(cleanOffer(r)); } catch (e) { errors.push('Offer ' + (i + 1) + ': ' + e.message); } });
  const rem = j.settings && Array.isArray(j.settings.reminders) ? j.settings.reminders.filter(n => [7, 3, 1].includes(n)) : null;
  return { offers, errors, settings: rem ? { reminders: rem } : null };
}
async function mergeOffers(incoming) {
  const cur = await getAll(), byId = new Map(cur.map(o => [o.id, o])), sigs = new Set(cur.map(sig));
  const w = []; let added = 0, updated = 0, skipped = 0;
  for (const o of incoming) {
    const e = byId.get(o.id);
    if (e) { if (o.updated > e.updated) { w.push(o); updated++; } else skipped++; }
    else if (sigs.has(sig(o))) skipped++;
    else { w.push(o); sigs.add(sig(o)); byId.set(o.id, o); added++; }
  }
  await putMany(w, false);
  return { added, updated, skipped };
}

/* ---------- Reminders ---------- */
const effReminders = (o, st) => (o.reminders || []).filter(n => st.reminders.includes(n)).sort((a, b) => a - b);
const reminderText = ({ o, d }) => ({
  title: o.name + (d === 0 ? ' expires today' : d === 1 ? ' expires tomorrow' : ' expires in ' + d + ' days'),
  body: srcLabel(o) + (o.code ? ' · Code: ' + o.code : '')
});
/* Returns offers whose reminder is due now and has not been shown before, and records them so they are not repeated. */
async function dueReminders() {
  const [offers, st, sent] = await Promise.all([getAll(), getSettings(), getMeta('sent', [])]);
  const t = todayISO(), seen = new Set(sent), due = [];
  for (const o of offers) {
    if (o.used || o.noExpiry) continue;
    const d = daysLeft(o, t); if (d < 0) continue;
    const ns = effReminders(o, st), n = ns.find(x => d <= x);
    if (n === undefined || seen.has(o.id + '|' + o.expiry + '|' + n)) continue;
    ns.filter(m => m >= n).forEach(m => seen.add(o.id + '|' + o.expiry + '|' + m));
    due.push({ o, d });
  }
  if (due.length) await setMeta('sent', [...seen].slice(-500));
  return due;
}
async function notifyDue(reg) {
  for (const it of await dueReminders()) {
    const t = reminderText(it);
    await reg.showNotification(t.title, { body: t.body, tag: it.o.id, icon: 'icon-192.png' });
  }
}

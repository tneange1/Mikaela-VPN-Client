const { app, BrowserWindow, ipcMain, safeStorage, shell, session: ses, net: enet, clipboard } = require('electron');
const path = require('path'), fs = require('fs'), net = require('net'), os = require('os'), crypto = require('crypto'), dns = require('dns');
const { spawn, execFileSync, execFile } = require('child_process');

const BASE = process.env.MIKAELA_API || 'https://cabinet.mikaelavpn.xyz';
const CABINET = 'https://cabinet.mikaelavpn.xyz/';
const UA = 'MikaelaVPN/1.0 (Windows)';     // свой User-Agent: на него настраивается Response Rule в панели
const XRAY_PORT = 10870;                    // локальный socks Xray (не пересекается с Happ: 10808/10809)
const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const BAD = ['0.0.0.0', '127.0.0.1', 'localhost', '::', '::1'];

let win = null, tgCancel = false, session = null, prefix = null;
let xray = null, sb = null, stopping = false, restarting = false, lastFail = '', lastLevel = 'warning', curTag = '';
let lastWarn = '';
let entries = null, entriesAt = 0, disk = null, stale = false, bgBusy = false; // disk: кэш подписки {url, at, arr}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sFile = () => path.join(app.getPath('userData'), 'session.bin');
const binDir = () => app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
const logDir = () => path.join(app.getPath('userData'), 'logs');

// ---------- логи ----------
const logBuf = [], pend = [];
const mask = s => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, m => m.slice(0, 8) + '…');
function log(tag, msg) {
  const t = new Date(), p = (n, l = 2) => String(n).padStart(l, '0');
  const line = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}.${p(t.getMilliseconds(), 3)} [${tag}] ${mask(msg)}`;
  logBuf.push(line); if (logBuf.length > 3000) logBuf.splice(0, logBuf.length - 3000);
  pend.push(line);
}
setInterval(() => {
  if (!pend.length) return;
  const txt = pend.splice(0).join('\n') + '\n';
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const f = path.join(logDir(), 'app.log');
    try { if (fs.statSync(f).size > 2e6) fs.renameSync(f, path.join(logDir(), 'app.old.log')); } catch {}
    fs.appendFileSync(f, txt);
  } catch {}
}, 700);
const rl = new Map(); // key -> {n, t0, supp, tag}
function logRL(tag, msg) { // выводы xray/sing-box: убираем шум и схлопываем повторы
  if (/found process path|connection (upload|download) (finished|closed)/i.test(msg)) return;
  if (/FATAL|ERROR|panic|failed to start|WARN/i.test(msg)) return log(tag, msg);
  const key = tag + msg.replace(/\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d(\.\d+)?/g, '').replace(/\[\d+( [\d.]+m?s)?\]/g, '[]').replace(/\d+\.\d+\.\d+\.\d+/g, 'IP').replace(/\b\d{4,5}\b/g, 'P').replace(/[\d.]+m?s\b/g, '');
  const now = Date.now(); let e = rl.get(key);
  if (!e || now - e.t0 > 5000) { if (e && e.supp) log(tag, `  … ещё ×${e.supp} таких же строк`); e = { n: 0, t0: now, supp: 0, tag }; rl.set(key, e); }
  if (++e.n <= 3) log(tag, msg); else e.supp++;
  if (rl.size > 3000) rl.clear();
}
setInterval(() => { const now = Date.now(); for (const [k, e] of rl) if (now - e.t0 > 5000) { if (e.supp) log(e.tag, `  … ещё ×${e.supp} таких же строк`); rl.delete(k); } }, 5000);
const safeUrl = u => { try { const x = new URL(u); return x.host + x.pathname.split('/').map(s => /^(?=.*\d)[A-Za-z0-9_-]{8,}$/.test(s) ? s.slice(0, 4) + '…' : s).join('/'); } catch { return String(u); } };

function save() {
  try {
    if (!session) return fs.rmSync(sFile(), { force: true });
    const j = JSON.stringify(session);
    fs.writeFileSync(sFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(j) : Buffer.from(j));
  } catch {}
}
function load() {
  try {
    const b = fs.readFileSync(sFile());
    session = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString());
  } catch { session = null; }
}

// ---------- HWID ----------
let _hwid = null;
function hwid() {
  if (_hwid) return _hwid;
  const f = path.join(app.getPath('userData'), 'hwid.txt');
  try { _hwid = fs.readFileSync(f, 'utf8').trim(); } catch {}
  if (!_hwid) {
    let g = '';
    try { const m = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true }).toString().match(/MachineGuid\s+REG_SZ\s+(\S+)/i); g = m ? m[1] : ''; } catch {}
    _hwid = crypto.createHash('sha256').update((g || crypto.randomUUID()) + 'mikaela-vpn').digest('hex').slice(0, 32);
    try { fs.writeFileSync(f, _hwid); } catch {}
  }
  return _hwid;
}
const subHeaders = () => ({ 'User-Agent': UA, 'x-hwid': hwid(), 'x-device-os': 'Windows', 'x-ver-os': os.release(), 'x-device-model': os.hostname() });

// ---------- сеть ----------
const why = e => (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.name === 'TimeoutError' ? 'таймаут' : e && e.message) || 'ошибка';
async function nf(url, o = {}, label = 'Нет связи с сервером') {
  const { timeout = 10000, tries = 2, ...fo } = o;
  const m = fo.method || 'GET', get = m === 'GET', t0 = Date.now();
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await enet.fetch(url, { ...fo, signal: AbortSignal.timeout(timeout) });
      log('net', `${m} ${safeUrl(url)} → ${r.status} (${Date.now() - t0} мс)`);
      return r;
    } catch (e) {
      err = e;
      log('net', `${m} ${safeUrl(url)} ✗ ${why(e)} (попытка ${i + 1}/${tries})`);
      if (!get && !/CONNECT|ERR_CONNECTION|ERR_NAME|ERR_INTERNET|ENOTFOUND/i.test(why(e) + ' ' + (e && e.message))) break;
      if (i < tries - 1) await sleep(600);
    }
  }
  throw new Error(`${label} (${why(err)})`);
}
async function raw(p, o = {}) { // пробуем BASE и BASE/api
  if (prefix !== null) return nf(BASE + prefix + p, o);
  let last;
  for (const pf of ['', '/api']) {
    try {
      const r = await nf(BASE + pf + p, o);
      if ((r.headers.get('content-type') || '').includes('json')) { prefix = pf; log('net', `API prefix: "${pf}"`); return r; }
      last = r;
    } catch (e) { last = e; }
  }
  if (last instanceof Error) throw last;
  throw new Error('API не найден по адресу ' + BASE + ' (задай MIKAELA_API)');
}
const J = { 'Content-Type': 'application/json' };

async function refresh() {
  try {
    const r = await raw('/cabinet/auth/refresh', { method: 'POST', headers: J, body: JSON.stringify({ refresh_token: session.refresh }) });
    if (!r.ok) { log('auth', 'refresh отклонён: ' + r.status); session = null; save(); return false; }
    const d = await r.json();
    session.access = d.access_token;
    if (d.refresh_token) session.refresh = d.refresh_token;
    save(); log('auth', 'токен обновлён'); return true;
  } catch (e) { log('auth', 'refresh ошибка: ' + e.message); return false; }
}
async function authed(p, o = {}) {
  for (let i = 0; i < 2; i++) {
    if (!session) throw new Error('AUTH');
    const r = await raw(p, { ...o, headers: { ...(o.headers || {}), Authorization: 'Bearer ' + session.access } });
    if (r.status !== 401) return r;
    if (!(await refresh())) throw new Error('AUTH');
  }
  throw new Error('AUTH');
}
const errText = (d, def) => {
  const x = d && d.detail;
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(i => i.msg).join('; ');
  if (x && typeof x === 'object') return x.message || x.error || def;
  return (d && d.message) || def;
};
async function jcall(p, method = 'GET', body) {
  const r = await authed(p, { method, headers: body ? J : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { log('api', `${method} ${p} → ${r.status}: ${errText(d, '')}`); throw new Error(errText(d, 'Ошибка ' + r.status)); }
  return d;
}

// ---------- аккаунт ----------
function setAuth(d) { session = { access: d.access_token, refresh: d.refresh_token, user: d.user }; save(); log('auth', 'вход выполнен'); return d.user; }
async function login(email, password) {
  const r = await raw('/cabinet/auth/email/login', { method: 'POST', headers: J, body: JSON.stringify({ email, password }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { log('auth', 'вход по email: отказ ' + r.status); throw new Error(errText(d, 'Неверная почта или пароль. Если вход был через Telegram/Google — пароль не задан: нажми «Забыли пароль?»')); }
  return setAuth(d);
}
async function register(email, password, name) {
  const r = await raw('/cabinet/auth/email/register/standalone', { method: 'POST', headers: J, body: JSON.stringify({ email, password, first_name: name || undefined, language: 'ru' }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errText(d, 'Не удалось зарегистрироваться'));
  return d.message || 'Письмо отправлено. Подтвердите почту и войдите.';
}
async function forgot(email) {
  const r = await raw('/cabinet/auth/password/forgot', { method: 'POST', headers: J, body: JSON.stringify({ email }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errText(d, 'Не удалось отправить письмо'));
  return 'Если такой аккаунт есть, письмо со ссылкой для пароля отправлено.';
}
async function tgLogin() {
  tgCancel = false;
  const r = await raw('/cabinet/auth/deeplink/request', { method: 'POST' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) throw new Error('Вход через Telegram недоступен');
  shell.openExternal(`https://t.me/${d.bot_username}?start=webauth_${d.token}`);
  const until = Date.now() + (d.expires_in || 300) * 1000;
  while (Date.now() < until && !tgCancel) {
    await sleep(2000);
    const p = await raw('/cabinet/auth/deeplink/poll', { method: 'POST', headers: J, body: JSON.stringify({ token: d.token }) });
    if (p.status === 200) return setAuth(await p.json());
    if (p.status === 410) break;
  }
  throw new Error(tgCancel ? 'Отменено' : 'Время ожидания истекло, попробуйте ещё раз');
}
const SCAN = `(()=>{let a,r;const w=o=>{if(!o||typeof o!=='object')return;for(const k in o){const v=o[k];if(typeof v==='string'){if(/access.?token/i.test(k)&&v.startsWith('eyJ'))a=v;if(/refresh.?token/i.test(k)&&v)r=v}else w(v)}};
for(const st of [localStorage,sessionStorage])for(let i=0;i<st.length;i++){const k=st.key(i),v=st.getItem(k);if(/access.?token/i.test(k)&&v&&v.startsWith('eyJ'))a=v;if(/refresh.?token/i.test(k)&&v)r=v;try{w(JSON.parse(v))}catch{}}
return a&&r?{a,r}:null})()`;
function webLogin() {
  return new Promise(async (resolve, reject) => {
    const part = 'persist:cabinet-login';
    await ses.fromPartition(part).clearStorageData();
    const w = new BrowserWindow({ width: 520, height: 780, parent: win, modal: true, autoHideMenuBar: true, title: 'Вход через кабинет', webPreferences: { partition: part } });
    w.webContents.setUserAgent(w.webContents.getUserAgent().replace(/\s(Electron|mikaela-vpn)\/\S+/gi, ''));
    let done = false;
    const t = setInterval(async () => {
      if (done || w.isDestroyed()) return;
      try {
        const r = await w.webContents.executeJavaScript(SCAN);
        if (!r) return;
        done = true; clearInterval(t);
        session = { access: r.a, refresh: r.r, user: null }; save();
        w.close();
        resolve(await me());
      } catch (e) { if (done) reject(e); }
    }, 1500);
    w.on('closed', () => { clearInterval(t); if (!done) reject(new Error('Окно входа закрыто')); });
    w.loadURL(CABINET);
  });
}
async function me() {
  for (const p of ['/cabinet/auth/me', '/cabinet/balance']) {
    try {
      const r = await authed(p);
      if (r.ok) { const d = await r.json(); session.user = { ...(session.user || {}), ...d }; save(); return session.user; }
    } catch (e) { if (e.message === 'AUTH') throw e; }
  }
  return session.user;
}
const getSub = async () => {
  const d = await jcall('/cabinet/subscription');
  const u = d.subscription && d.subscription.subscription_url;
  if (u && (!disk || disk.url !== u)) { disk = { url: u, at: disk ? disk.at : 0, arr: disk ? disk.arr : null }; saveDisk(); log('sub', 'адрес подписки обновлён из кабинета'); }
  return d;
};

// ---------- устройства, баланс, продление ----------
async function devices() {
  const d = await jcall('/cabinet/subscription/devices');
  const arr = Array.isArray(d) ? d : (d.devices || d.items || d.data || []);
  const mine = hwid();
  const list = arr.map(x => ({
    hwid: String(x.hwid || x.hwid_id || x.id || ''), platform: x.platform || x.device_os || '',
    model: x.device_model || x.model || x.name || '', created: x.created_at || x.createdAt || '',
  })).filter(x => x.hwid).map(x => ({ ...x, self: x.hwid.toLowerCase() === mine }));
  const n = typeof d.total === 'number' ? d.total : typeof d.connected === 'number' ? d.connected : list.length;
  return { list, count: n, limit: d.device_limit != null ? d.device_limit : (d.limit != null ? d.limit : null) };
}
const resetDevices = () => jcall('/cabinet/subscription/devices', 'DELETE');
const delDevice = h => jcall('/cabinet/subscription/devices/' + encodeURIComponent(h), 'DELETE');
const methods = () => jcall('/cabinet/balance/payment-methods');
async function topup(o) {
  const d = await jcall('/cabinet/balance/topup', 'POST', { amount_kopeks: o.amount_kopeks, payment_method: o.payment_method, payment_option: o.payment_option || undefined });
  if (d.payment_url && /^https:\/\//.test(d.payment_url)) shell.openExternal(d.payment_url);
  return d;
}
const renewOptions = () => jcall('/cabinet/subscription/renewal-options');
const renew = days => jcall('/cabinet/subscription/renew', 'POST', { period_days: days });

// ---------- подписка: Xray JSON (как в Happ) ----------
const isProxy = o => o && o.protocol && !['freedom', 'blackhole', 'dns', 'loopback'].includes(o.protocol);
const hostOf = o => { const s = o.settings || {}, v = (s.vnext && s.vnext[0]) || (s.servers && s.servers[0]) || s; return v && v.address ? { host: String(v.address), port: +v.port || 443 } : null; };
let ph = 0;
function buildEntries(arr) {
  const seen = new Set(), out = []; ph = 0;
  for (const cfg of arr) {
    const outs = (cfg.outbounds || []).filter(isProxy);
    if (!outs.length) continue;
    const bal = cfg.routing && cfg.routing.balancers && cfg.routing.balancers[0];
    let subj = outs;                                     // узлы балансировщика: теги с префиксом из selector
    if (bal && Array.isArray(bal.selector)) { const m = outs.filter(o => bal.selector.some(p => String(o.tag || '').startsWith(p))); if (m.length) subj = m; }
    const hosts = subj.map(hostOf).filter(Boolean);
    if (!hosts.length || hosts.every(h => BAD.includes(h.host))) { ph++; continue; }
    const name = cfg.remarks || cfg.ps || 'server';
    let t = name, i = 2; while (seen.has(t)) t = `${name} ${i++}`; seen.add(t);
    const ss = subj[0].streamSettings || {};
    out.push({ tag: t, cfg, udp: /hysteria/i.test(String(subj[0].protocol) + ' ' + String(ss.network)), auto: !!bal && subj.length > 1, count: subj.length, hosts: hosts.filter(h => !BAD.includes(h.host)),
      proto: String(subj[0].protocol || '').toUpperCase(), net: String(ss.network || 'tcp').toUpperCase(), sec: ss.security && ss.security !== 'none' ? String(ss.security).toUpperCase() : '' });
  }
  return out;
}
const cacheFile = () => path.join(app.getPath('userData'), 'sub-cache.bin');
function loadDisk() { try { const b = fs.readFileSync(cacheFile()); disk = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString()); } catch { disk = null; } }
function saveDisk() { try { const j = JSON.stringify(disk); fs.writeFileSync(cacheFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(j) : Buffer.from(j)); } catch {} }

async function pullArr(url, fast) { // скачать Xray JSON с панели (кабинет не нужен)
  const base = new URL(url).pathname.replace(/\/+$/, '');
  const withPath = sfx => { const x = new URL(url); x.pathname = base + sfx; return x.toString(); };
  let lastE = '';
  for (const [u, label] of [[url, 'базовая ссылка'], [withPath('/json'), 'ссылка /json']]) {
    try {
      const r = await nf(u, { headers: subHeaders(), timeout: fast ? 8000 : 15000, tries: fast ? 1 : 2 }, 'Панель недоступна');
      const text = await r.text();
      log('sub', `${label}: HTTP ${r.status}, ${text.length} байт, тип ${r.headers.get('content-type')}`);
      let j; try { j = JSON.parse(text); } catch {
        lastE = `ответ не JSON (HTTP ${r.status})${text ? ': ' + text.slice(0, 80).replace(/\s+/g, ' ') : ''}`;
        if (r.status === 403 || r.status === 404) lastE += ' — панель не отдаёт подписку для User-Agent ' + UA.split('/')[0] + ': добавьте Response Rule';
        log('sub', lastE); continue;
      }
      const arr = Array.isArray(j) ? j : (j && Array.isArray(j.outbounds) ? [j] : null);
      if (!arr || !arr.length) { lastE = 'JSON без конфигов'; log('sub', lastE); continue; }
      const ents = buildEntries(arr);
      if (ents.length) { log('sub', `серверов: ${ents.length}: ` + ents.map(e => e.tag + (e.auto ? ` [авто, ${e.count} узлов]` : '') + (e.udp ? ' [UDP]' : '')).join('; ')); return arr; }
      lastE = ph ? 'панель вернула заглушку — вероятно, достигнут лимит устройств (удалите лишнее на вкладке «Устройства»)' : 'в ответе нет подходящих серверов';
      log('sub', lastE);
    } catch (e) { lastE = e.message; log('sub', 'ошибка: ' + e.message); }
  }
  throw new Error(lastE);
}
async function pullEntries(url, fast) { const arr = await pullArr(url, fast); disk = { url, at: Date.now(), arr }; saveDisk(); stale = false; return buildEntries(arr); }
async function fetchEntries(fast) {
  const cached = disk && disk.url; let prevErr = '';
  if (cached) { // сначала напрямую в панель по сохранённому адресу — кабинет не нужен
    log('sub', `подписка: ${safeUrl(cached)} (адрес из кэша)`);
    try { return await pullEntries(cached, fast); } catch (e) { prevErr = e.message; log('sub', 'по сохранённому адресу не вышло: ' + prevErr); }
  }
  const s = await getSub(); // кабинет
  const url = s.subscription && s.subscription.subscription_url;
  if (!url) throw new Error('Нет активной подписки. Оформи её в боте или кабинете.');
  if (url === cached) throw new Error('Не удалось получить подписку: ' + prevErr);
  log('sub', `подписка: ${safeUrl(url)} (адрес от кабинета)`);
  try { return await pullEntries(url, fast); } catch (e) { throw new Error('Не удалось получить подписку: ' + e.message); }
}
async function loadEntries(force, fast) {
  if (!force && entries && Date.now() - entriesAt < 3600000) return entries;
  try { entries = await fetchEntries(fast); entriesAt = Date.now(); stale = false; return entries; }
  catch (e) {
    if (disk && disk.arr) {
      const ents = buildEntries(disk.arr);
      if (ents.length) { log('sub', `⚠ используем сохранённую подписку от ${new Date(disk.at).toLocaleString('ru')} (${e.message})`); entries = ents; entriesAt = Date.now() - 3000000; stale = true; return entries; }
    }
    throw e;
  }
}
const view = () => ({ list: entries.map(e => ({ tag: e.tag, auto: e.auto, count: e.count, proto: e.proto, net: e.net, sec: e.sec, udp: e.udp })), at: entriesAt, stale });
function refreshBg() { if (bgBusy) return; bgBusy = true; loadEntries(true).catch(() => {}).finally(() => { bgBusy = false; }); }
async function servers(o) {
  if (!(o && o.force)) {
    if (!entries && disk && disk.arr) { entries = buildEntries(disk.arr); entriesAt = disk.at || 0; stale = true; log('sub', 'список серверов из кэша'); }
    if (entries && entries.length) { if (Date.now() - entriesAt > 3600000) refreshBg(); return view(); }
  }
  await loadEntries(true); return view();
}
const tcpPing = h => new Promise(res => {
  const t = Date.now(), s = net.connect({ host: h.host, port: h.port, timeout: 3000 }, () => { const d = Date.now() - t; s.destroy(); res(d); });
  s.on('error', () => res(-1)); s.on('timeout', () => { s.destroy(); res(-1); });
});
async function pingOne(e) { if (e.udp) return -2; const r = (await Promise.all(e.hosts.map(tcpPing))).filter(x => x >= 0); return r.length ? Math.min(...r) : -1; }
async function pingMany(tags) {
  const res = {};
  await Promise.all(tags.map(async t => { const e = (entries || []).find(x => x.tag === t); res[t] = e ? await pingOne(e) : -1; }));
  log('ping', Object.entries(res).map(([t, v]) => `${t.replace(/[\u{1F1E6}-\u{1F1FF}]{2}\s*/gu, '')}: ${v === -2 ? 'UDP' : v < 0 ? '—' : v + ' мс'}`).join(', '));
  return res;
}
function logAdapters(tag) { // виден ли TUN-адаптер
  execFile('netsh', ['interface', 'ipv4', 'show', 'interfaces'], { windowsHide: true, encoding: 'buffer' }, (err, out) => {
    if (err) return log(tag, 'netsh: ' + err.message);
    out.toString('latin1').split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 18).forEach(l => log(tag, 'iface: ' + l));
  });
}

// ---------- процессы: Xray (ядро) + sing-box (TUN) ----------
const proxyOffSync = () => { try { execFileSync('reg', ['add', REG, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'], { windowsHide: true }); } catch {} };
const pidFile = () => path.join(app.getPath('userData'), 'pids.json');
const savePids = () => { try { fs.writeFileSync(pidFile(), JSON.stringify([xray && xray.pid, sb && sb.pid].filter(Boolean))); } catch {} };
function killOrphans() { // процессы прошлого запуска, если приложение упало
  try {
    for (const pid of JSON.parse(fs.readFileSync(pidFile(), 'utf8'))) {
      try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }).toString();
        if (/xray\.exe|sing-box\.exe/i.test(out)) { execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }); log('app', `остановлен старый процесс ${pid}`); }
      } catch {}
    }
    fs.rmSync(pidFile(), { force: true });
  } catch {}
}
const portOpen = (port, ms) => new Promise(res => {
  const s = net.connect({ host: '127.0.0.1', port, timeout: ms }, () => { s.destroy(); res(true); });
  s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false); });
});
function checkBins() {
  const miss = [];
  for (const f of ['xray.exe', 'sing-box.exe', 'wintun.dll', 'geoip.dat', 'geosite.dat']) {
    try { log('bin', `${f}: ${Math.round(fs.statSync(path.join(binDir(), f)).size / 1024)} КБ`); } catch { miss.push(f); log('bin', `${f}: ОТСУТСТВУЕТ в ${binDir()}`); }
  }
  if (miss.length) throw new Error('В приложении нет файлов: ' + miss.join(', ') + '. Пересоберите приложение (workflow их скачивает).');
}
function run(name, exe, args, env) {
  const p = spawn(path.join(binDir(), exe), args, { windowsHide: true, cwd: binDir(), env: { ...process.env, ...env } });
  log(name, `запуск: ${exe} ${args.map(a => path.basename(a)).join(' ')} (pid ${p.pid})`);
  let tail = '';
  const feed = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => { logRL(name, l); tail = (tail + '\n' + l).slice(-1500); });
  p.stdout.on('data', feed); p.stderr.on('data', feed);
  p.on('error', e => { p.failed = e.message; log(name, 'не запустился: ' + e.message); });
  p.tail = () => tail.trim();
  return p;
}
function pinAddress(o, ips) { // подставить IP сервера, SNI/host остаются прежними
  const st = o.settings || {}, v = (st.vnext && st.vnext[0]) || (st.servers && st.servers[0]) || st, h = v && v.address;
  if (!h || !ips[h] || ips[h] === h) return;
  const ss = o.streamSettings = o.streamSettings || {};
  if (ss.security === 'tls') { const t = ss.tlsSettings = ss.tlsSettings || {}; if (!t.serverName) t.serverName = h; }
  else if (ss.security === 'reality') { const r = ss.realitySettings = ss.realitySettings || {}; if (!r.serverName) r.serverName = h; }
  if (ss.xhttpSettings && !ss.xhttpSettings.host) ss.xhttpSettings.host = h;
  if (ss.wsSettings && !ss.wsSettings.host && !(ss.wsSettings.headers && ss.wsSettings.headers.Host)) ss.wsSettings.host = h;
  v.address = ips[h];
}
function xrayConfig(entry, level, ips) {
  const c = JSON.parse(JSON.stringify(entry.cfg));
  delete c.meta; delete c.remarks; delete c.remnawave;
  for (const o of (c.outbounds || [])) if (isProxy(o)) pinAddress(o, ips);
  c.inbounds = [{ tag: 'socks', listen: '127.0.0.1', port: XRAY_PORT, protocol: 'socks', settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true } }]; // routeOnly: адрес назначения не подменяется доменом
  c.log = { loglevel: level };
  return c;
}
async function resolveHost(h) {
  if (net.isIP(h)) return h;
  try { const r = await Promise.race([dns.promises.lookup(h, { family: 4 }), sleep(4000).then(() => { throw new Error('таймаут'); })]); return r.address; }
  catch (e) { log('dns', `${h}: системный DNS не ответил (${e.code || e.message})`); }
  for (const u of [`https://1.1.1.1/dns-query?name=${h}&type=A`, `https://8.8.8.8/resolve?name=${h}&type=A`]) {
    try {
      const r = await enet.fetch(u, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
      const a = ((await r.json()).Answer || []).find(x => x.type === 1);
      if (a) { log('dns', `${h}: получен через DoH`); return a.data; }
    } catch {}
  }
  const old = disk && disk.ips && disk.ips[h];
  if (old) log('dns', `${h}: используем прошлый IP из кэша`);
  return old || null;
}
async function resolveAll(hosts) {
  const map = {}, t0 = Date.now();
  await Promise.all(hosts.map(async h => { const ip = await resolveHost(h); if (ip) { map[h] = ip; if (!net.isIP(h) && disk) { disk.ips = disk.ips || {}; disk.ips[h] = ip; } } else log('dns', `${h}: IP определить не удалось`); }));
  if (disk) saveDisk();
  log('dns', 'адреса серверов: ' + (Object.entries(map).filter(([h]) => !net.isIP(h)).map(([h, ip]) => `${h}→${ip}`).join(', ') || '—') + ` (${Date.now() - t0} мс)`);
  return map;
}
async function startXray(entry, level) {
  const hosts = [...new Set((entry.cfg.outbounds || []).filter(isProxy).map(o => { const h = hostOf(o); return h && h.host; }).filter(Boolean))];
  const ips = await resolveAll(hosts);
  const f = path.join(app.getPath('userData'), 'xray-config.json');
  fs.writeFileSync(f, JSON.stringify(xrayConfig(entry, level, ips), null, 2));
  log('xray', `сервер «${entry.tag}»${entry.auto ? ` (автовыбор, ${entry.count} узлов)` : ''}`);
  const p = run('xray', 'xray.exe', ['run', '-c', f], { XRAY_LOCATION_ASSET: binDir() });
  xray = p; savePids();
  p.on('exit', (code, sig) => {
    log('xray', `завершился code=${code} signal=${sig}`);
    if (xray === p) { xray = null; if (!stopping && !restarting) { lastFail = 'Xray неожиданно остановился: ' + p.tail(); stopAll('xray упал'); } }
  });
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    if (xray !== p) throw new Error('Xray остановился: ' + (p.failed || p.tail() || 'нет вывода'));
    if (await portOpen(XRAY_PORT, 400)) { log('xray', `socks-порт ${XRAY_PORT} готов (${(i + 1) * 300} мс)`); return; }
  }
  throw new Error('Xray не открыл порт ' + XRAY_PORT + ': ' + p.tail());
}
function socksProbe(ms) { // HTTP-запрос к 1.1.1.1:80 через локальный socks Xray (до включения TUN)
  return new Promise((resolve, reject) => {
    const t0 = Date.now(); let step = 0, buf = Buffer.alloc(0), done = false;
    const s = net.connect({ host: '127.0.0.1', port: XRAY_PORT });
    const fin = (err, val) => { if (done) return; done = true; clearTimeout(tm); s.destroy(); err ? reject(err) : resolve(val); };
    const tm = setTimeout(() => fin(new Error(`нет ответа за ${ms / 1000} с`)), ms);
    s.on('error', e => fin(e));
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (step === 0) { if (buf.length < 2) return; if (buf[0] !== 5 || buf[1] !== 0) return fin(new Error('socks: отказ')); buf = buf.slice(2); step = 1; s.write(Buffer.from([5, 1, 0, 1, 1, 1, 1, 1, 0, 80])); }
      if (step === 1) {
        if (buf.length < 10) return;
        if (buf[1] !== 0) return fin(new Error('socks: ошибка ' + buf[1] + ' (сервер не принял соединение)'));
        const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4]; if (buf.length < len) return;
        buf = buf.slice(len); step = 2; s.write('GET / HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n\r\n');
      }
      if (step === 2) { const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf.toString('latin1')); if (m) fin(null, { status: +m[1], ms: Date.now() - t0 }); }
    });
  });
}
async function verifyTunnel(entry) { // убеждаемся, что через сервер реально идёт трафик — до изменения сети Windows
  const tries = entry.auto ? 3 : 2; let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await socksProbe(7000); log('xray', `проверка канала через «${entry.tag}»: HTTP ${r.status}, ${r.ms} мс ✓`); return; }
    catch (e) { last = e; log('xray', `проверка канала #${i + 1}: ${e.message}`); }
    await sleep(1200);
  }
  throw new Error(`Через сервер «${entry.tag}» трафик не идёт (${last.message}). Сервер недоступен или заблокирован — выберите другой (вкладка «Серверы» → «Тест пинга»).`);
}
function happAdapter() {
  try {
    const out = execFileSync('netsh', ['interface', 'show', 'interface'], { windowsHide: true }).toString('latin1');
    const m = out.split(/\r?\n/).find(l => /happ|nekoray|clash|v2ray/i.test(l));
    return m ? m.trim().split(/\s{2,}/).pop() : '';
  } catch { return ''; }
}
async function startSingbox(level) {
  const cfg = {
    log: { level: level === 'debug' ? 'debug' : level === 'info' ? 'info' : 'warn', timestamp: false },
    dns: { servers: [{ type: 'tcp', tag: 'dns-remote', server: '1.1.1.1', detour: 'xray' }], final: 'dns-remote', strategy: 'ipv4_only' },
    inbounds: [{ type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], auto_route: true, strict_route: true, stack: 'mixed' }],
    outbounds: [{ type: 'socks', tag: 'xray', server: '127.0.0.1', server_port: XRAY_PORT, version: '5' }, { type: 'direct', tag: 'direct' }],
    route: {
      rules: [
        { action: 'sniff' },
        { process_name: ['xray.exe'], outbound: 'direct' },   // трафик самого Xray к серверам — мимо TUN
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' },
      ],
      final: 'xray', auto_detect_interface: true, find_process: true,
    },
  };
  const f = path.join(app.getPath('userData'), 'singbox-config.json');
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
  const p = run('sing-box', 'sing-box.exe', ['run', '-c', f, '-D', binDir()]);
  sb = p; savePids();
  p.on('exit', (code, sig) => {
    log('sing-box', `завершился code=${code} signal=${sig}`);
    if (sb === p) { sb = null; if (!stopping) { lastFail = 'sing-box (TUN) остановился: ' + p.tail(); stopAll('sing-box упал'); } }
  });
  for (let i = 0; i < 8; i++) {
    await sleep(400);
    if (sb !== p) throw new Error('sing-box остановился: ' + (p.failed || p.tail() || 'нет вывода'));
  }
  log('sing-box', 'TUN запущен'); logAdapters('tun');
}
async function stopAll(reason) {
  stopping = true;
  for (const p of [sb, xray]) { if (p) { try { p.removeAllListeners('exit'); p.kill(); } catch {} } }
  const had = !!(sb || xray);
  sb = null; xray = null; savePids();
  if (had) log('app', 'остановлено' + (reason ? ': ' + reason : ''));
  await sleep(150); stopping = false;
}
const probe = async (url, ms = 10000) => { const t = Date.now(); const r = await enet.fetch(url, { signal: AbortSignal.timeout(ms) }); return { r, ms: Date.now() - t }; };
async function afterConnectTest() {
  await sleep(1500);
  for (const [name, url] of [['gstatic 204', 'http://www.gstatic.com/generate_204'], ['внешний IP', 'https://api.ipify.org']]) {
    try { const { r, ms } = await probe(url); log('test', `${name}: HTTP ${r.status}, ${ms} мс${name === 'внешний IP' ? ' → ' + (await r.text()).slice(0, 40) : ''}`); }
    catch (e) { log('test', `${name}: ОШИБКА ${why(e)} — канал Xray проверен, значит проблема в TUN/DNS (смотрите [sing-box] и [tun])`); }
  }
}
async function connect(o = {}) {
  await stopAll('перед подключением'); lastFail = '';
  lastLevel = ['info', 'debug'].includes(o.logLevel) ? o.logLevel : 'warning';
  log('app', `=== подключение: сервер «${o.server || '—'}», логи: ${lastLevel} ===`);
  try {
    checkBins();
    const hp = happAdapter();
    if (hp) { lastWarn = `Найден активный сетевой адаптер «${hp}» (Happ или другой VPN). Закройте его полностью (выход из трея) — два TUN конфликтуют.`; log('app', '⚠ ' + lastWarn); }
    const ents = await loadEntries(true, true);
    const entry = ents.find(e => e.tag === o.server) || ents[0];
    curTag = entry.tag;
    await startXray(entry, lastLevel);
    await verifyTunnel(entry);
    await startSingbox(lastLevel);
    log('app', 'подключено'); afterConnectTest().catch(() => {}); setTimeout(refreshBg, 6000);
    return true;
  } catch (e) { log('app', 'ОШИБКА подключения: ' + e.message); await stopAll('ошибка'); throw e; }
}
async function pick(tag) {
  curTag = tag;
  if (!(xray && sb)) return true;
  const e = (entries || []).find(x => x.tag === tag);
  if (!e) return false;
  log('app', `переключение на «${tag}»`);
  restarting = true;
  try { if (xray) { xray.removeAllListeners('exit'); xray.kill(); xray = null; } await sleep(300); await startXray(e, lastLevel); await verifyTunnel(e); }
  catch (err) { await stopAll('ошибка переключения'); throw err; }
  finally { restarting = false; }
  return true;
}
async function diag() {
  log('diag', `=== диагностика: ${app.getName()} ${app.getVersion()}, Windows ${os.release()}, HWID ${hwid().slice(0, 8)}… ===`);
  try { checkBins(); } catch (e) { log('diag', e.message); }
  log('diag', `socks-порт ${XRAY_PORT}: ${(await portOpen(XRAY_PORT, 500)) ? 'открыт' : 'закрыт'}; xray ${xray ? 'работает' : 'нет'}, sing-box ${sb ? 'работает' : 'нет'}`);
  for (const [n, u] of [['кабинет', BASE], ['gstatic 204', 'http://www.gstatic.com/generate_204'], ['внешний IP', 'https://api.ipify.org']]) {
    try { const { r, ms } = await probe(u, 8000); log('diag', `${n}: HTTP ${r.status}, ${ms} мс${n === 'внешний IP' ? ' → ' + (await r.text()).slice(0, 40) : ''}`); }
    catch (e) { log('diag', `${n}: ОШИБКА ${why(e)}`); }
  }
  for (const h of ['1.1.1.1', ...((entries && entries[0] && entries[0].hosts.slice(0, 2).map(x => x.host)) || [])]) log('diag', `TCP ${h}:443 → ${await tcpPing({ host: h, port: 443 })} мс`);
  logAdapters('diag'); await sleep(800);
  log('diag', '=== конец ===');
  return true;
}

const h = (c, f) => ipcMain.handle(c, async (_, ...a) => {
  try { return { ok: true, data: await f(...a) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
h('session', () => session ? session.user : null);
h('login', login);
h('logout', async () => { await stopAll('выход'); try { await authed('/cabinet/auth/logout', { method: 'POST', headers: J, body: JSON.stringify({ refresh_token: session.refresh }) }); } catch {} session = null; entries = null; save(); });
h('sub', getSub);
h('connect', connect);
h('disconnect', () => stopAll('по кнопке'));
h('status', async () => { const e = lastFail, w = lastWarn; lastFail = ''; lastWarn = ''; return { running: !!(xray && sb), error: e, warn: w, ea: entriesAt, stale }; });
h('servers', servers);
h('pingmany', pingMany);
h('pick', pick);
h('devices', devices);
h('deldevice', delDevice);
h('resetdevices', resetDevices);
h('hwid', async () => hwid());
h('methods', methods);
h('topup', topup);
h('renewoptions', renewOptions);
h('renew', renew);
h('register', register);
h('forgot', forgot);
h('tg', tgLogin);
h('tgcancel', async () => { tgCancel = true; });
h('weblogin', webLogin);
h('me', me);
h('cabinet', () => shell.openExternal(CABINET));
h('logs', async () => logBuf.slice(-700).join('\n'));
h('copylogs', async () => { clipboard.writeText(logBuf.join('\n')); return true; });
h('clearlogs', async () => { logBuf.length = 0; pend.length = 0; try { fs.rmSync(logDir(), { recursive: true, force: true }); } catch {} return true; });
h('openlogs', async () => { fs.mkdirSync(logDir(), { recursive: true }); return shell.openPath(logDir()); });
h('diag', diag);

if (!app.requestSingleInstanceLock()) app.quit();
app.whenReady().then(() => {
  load(); loadDisk(); proxyOffSync(); killOrphans();
  log('app', `запуск ${app.getName()} ${app.getVersion()}, Windows ${os.release()}, bin: ${binDir()}`);
  win = new BrowserWindow({
    width: 440, height: 800, resizable: false, autoHideMenuBar: true, backgroundColor: '#0b0f1a',
    title: 'Mikaela VPN', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile('index.html');
});
app.on('before-quit', () => { for (const p of [sb, xray]) { try { if (p) p.kill(); } catch {} } });
app.on('window-all-closed', () => app.quit());

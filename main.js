const { app, BrowserWindow, ipcMain, safeStorage, shell, session: ses } = require('electron');
const path = require('path'), fs = require('fs'), net = require('net');
const { spawn, execFile, execFileSync } = require('child_process');

const BASE = process.env.MIKAELA_API || 'https://cabinet.mikaelavpn.xyz';
const CABINET = 'https://cabinet.mikaelavpn.xyz/';
const UA_SB = 'sing-box/1.12.8 MikaelaVPN/1.0 (Windows)';
const UA_XRAY = 'Happ/4.6.1/windows';
const CLASH = 'http://127.0.0.1:9090';
const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

let win = null, tgCancel = false;
let session = null, proc = null, mode = 'tun', prefix = null, lastErr = '';
let cache = null, cur = null; // cache: {cfg, at, fmt}; cur: {selTag, list}
const sFile = () => path.join(app.getPath('userData'), 'session.bin');
const binDir = () => app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');

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

// ---------- сеть ----------
const why = e => (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.name === 'TimeoutError' ? 'таймаут' : e && e.message) || 'ошибка';
async function nf(url, o = {}, label = 'Нет связи с сервером') {
  try { return await fetch(url, { ...o, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error(`${label} (${why(e)})`); }
}
// API: пробуем BASE и BASE/api (кабинет может проксировать API под /api)
async function raw(p, o = {}) {
  if (prefix !== null) return nf(BASE + prefix + p, o);
  let last;
  for (const pf of ['', '/api']) {
    try {
      const r = await fetch(BASE + pf + p, { ...o, signal: AbortSignal.timeout(20000) });
      if ((r.headers.get('content-type') || '').includes('json')) { prefix = pf; return r; }
      last = r;
    } catch (e) { last = e; }
  }
  if (last instanceof Error) throw new Error(`Нет связи с сервером (${why(last)})`);
  throw new Error('API не найден по адресу ' + BASE + ' (задай MIKAELA_API)');
}
const J = { 'Content-Type': 'application/json' };

async function refresh() {
  try {
    const r = await raw('/cabinet/auth/refresh', { method: 'POST', headers: J, body: JSON.stringify({ refresh_token: session.refresh }) });
    if (!r.ok) { session = null; save(); return false; }
    const d = await r.json();
    session.access = d.access_token;
    if (d.refresh_token) session.refresh = d.refresh_token;
    save(); return true;
  } catch { return false; }
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

// ---------- аккаунт ----------
const errText = (d, def) => typeof d.detail === 'string' ? d.detail : Array.isArray(d.detail) ? d.detail.map(x => x.msg).join('; ') : def;
function setAuth(d) {
  session = { access: d.access_token, refresh: d.refresh_token, user: d.user };
  save();
  return d.user;
}
async function login(email, password) {
  const r = await raw('/cabinet/auth/email/login', { method: 'POST', headers: J, body: JSON.stringify({ email, password }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errText(d, 'Неверная почта или пароль. Если вход был через Telegram/Google — пароль не задан: нажми «Забыли пароль?»'));
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
    await new Promise(x => setTimeout(x, 2000));
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
async function getSub() {
  const r = await authed('/cabinet/subscription');
  if (!r.ok) throw new Error('Не удалось получить подписку');
  return r.json();
}

// ---------- подписка: sing-box JSON или Xray JSON ----------
function convOut(o) {
  const s = o.settings || {}, ss = o.streamSettings || {};
  let b;
  if (o.protocol === 'vless' || o.protocol === 'vmess') {
    const v = (s.vnext && s.vnext[0]) || s, u = (v.users && v.users[0]) || v;
    b = { type: o.protocol, server: v.address, server_port: +v.port, uuid: u.id };
    if (o.protocol === 'vless') { if (u.flow) b.flow = u.flow; }
    else { b.security = u.security || 'auto'; b.alter_id = +u.alterId || 0; }
  } else if (o.protocol === 'trojan') {
    const v = (s.servers && s.servers[0]) || s;
    b = { type: 'trojan', server: v.address, server_port: +v.port, password: v.password };
  } else {
    const v = (s.servers && s.servers[0]) || s;
    b = { type: 'shadowsocks', server: v.address, server_port: +v.port, method: v.method, password: v.password };
  }
  if (!b.server || !b.server_port) return null;
  const nw = ss.network || 'tcp', sec = ss.security || 'none';
  if (sec === 'reality') {
    const r = ss.realitySettings || {};
    b.tls = { enabled: true, server_name: r.serverName, utls: { enabled: true, fingerprint: r.fingerprint || 'chrome' }, reality: { enabled: true, public_key: r.publicKey, short_id: r.shortId || '' } };
  } else if (sec === 'tls') {
    const t = ss.tlsSettings || {};
    b.tls = { enabled: true, server_name: t.serverName || b.server, insecure: !!t.allowInsecure };
    if (t.alpn) b.tls.alpn = t.alpn;
    if (t.fingerprint) b.tls.utls = { enabled: true, fingerprint: t.fingerprint };
  }
  if (nw === 'ws') { const w = ss.wsSettings || {}; b.transport = { type: 'ws', path: w.path || '/', headers: w.headers || (w.host ? { Host: w.host } : undefined) }; }
  else if (nw === 'grpc') b.transport = { type: 'grpc', service_name: (ss.grpcSettings || {}).serviceName || '' };
  else if (nw === 'httpupgrade') { const w = ss.httpupgradeSettings || {}; b.transport = { type: 'httpupgrade', path: w.path || '/', host: w.host }; }
  else if (nw !== 'tcp') return null; // xhttp и пр. sing-box не умеет
  return b;
}
function fromXray(arr) {
  const outs = [], names = [], seen = new Set(['proxy', 'direct', 'block']);
  const uniq = n => { let x = n, i = 2; while (seen.has(x)) x = `${n} ${i++}`; seen.add(x); return x; };
  for (const e of arr) {
    const name = e.remarks || e.ps || 'server';
    const conv = (e.outbounds || []).filter(o => ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(o.protocol)).map(convOut).filter(Boolean);
    if (!conv.length) continue;
    if (conv.length === 1) { conv[0].tag = uniq(name); outs.push(conv[0]); names.push(conv[0].tag); }
    else {
      const members = conv.map((c, i) => { c.tag = uniq(`${name} · ${i + 1}`); outs.push(c); return c.tag; });
      const t = uniq(name);
      outs.push({ type: 'urltest', tag: t, outbounds: members, url: 'https://www.gstatic.com/generate_204', interval: '5m' });
      names.push(t);
    }
  }
  if (!outs.length) return null;
  return {
    log: { level: 'warn' },
    dns: { servers: [{ type: 'tls', tag: 'dns-remote', server: '1.1.1.1', detour: 'proxy' }, { type: 'udp', tag: 'dns-local', server: '8.8.8.8' }], final: 'dns-remote' },
    outbounds: [...outs, { type: 'selector', tag: 'proxy', outbounds: names, default: names[0] }, { type: 'direct', tag: 'direct' }],
    route: { rules: [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }, { ip_is_private: true, outbound: 'direct' }], final: 'proxy', auto_detect_interface: true, default_domain_resolver: 'dns-local' },
  };
}
function toSingbox(j) {
  if (Array.isArray(j)) return fromXray(j);
  if (j && Array.isArray(j.outbounds)) {
    if (j.outbounds.some(o => o.type)) return j;
    if (j.outbounds.some(o => o.protocol)) return fromXray([j]);
  }
  return null;
}
function variants(url, fmt) {
  const base = new URL(url).pathname.replace(/\/+$/, '');
  const withPath = sfx => { const x = new URL(url); x.pathname = base + sfx; return x.toString(); };
  const sb = [[withPath('/singbox'), UA_SB], [url, UA_SB]], xr = [[withPath('/json'), UA_XRAY], [url, UA_XRAY]];
  return fmt === 'singbox' ? sb : fmt === 'xray' ? xr : [...xr, ...sb];
}
async function loadConfig(fmt) {
  const s = await getSub();
  const url = s.subscription && s.subscription.subscription_url;
  if (!url) throw new Error('Нет активной подписки. Оформи её в боте или кабинете.');
  let lastE = '';
  for (const [u, ua] of variants(url, fmt)) {
    try {
      const r = await nf(u, { headers: { 'User-Agent': ua } }, 'Подписка недоступна');
      let j; try { j = JSON.parse(await r.text()); } catch { lastE = 'ответ не JSON'; continue; }
      const cfg = toSingbox(j);
      if (cfg) return { cfg, sub: s };
      lastE = 'неизвестный формат';
    } catch (e) { lastE = e.message; }
  }
  throw new Error('Не удалось получить JSON-подписку: ' + lastE);
}
function serverList(cfg) {
  const outs = cfg.outbounds || [], by = Object.fromEntries(outs.map(o => [o.tag, o]));
  const skip = ['direct', 'block', 'dns'];
  const sel = outs.find(o => o.type === 'selector');
  const tags = sel ? sel.outbounds : outs.filter(o => !['selector', 'urltest', ...skip].includes(o.type)).map(o => o.tag);
  return {
    selTag: sel && sel.tag,
    list: tags.filter(t => by[t] && !skip.includes(by[t].type)).map(t => {
      const o = by[t], g = ['urltest', 'selector'].includes(o.type);
      return { tag: t, auto: g, proto: g ? 'АВТО' : (o.type || '').toUpperCase(), net: g ? '' : ((o.transport && o.transport.type) || 'tcp').toUpperCase(), sec: o.tls && o.tls.reality && o.tls.reality.enabled ? 'REALITY' : (o.tls && o.tls.enabled ? 'TLS' : '') };
    }),
  };
}
async function servers(o) {
  const fmt = o && o.format;
  if (!(o && o.force) && cache && cache.fmt === fmt && Date.now() - cache.at < 300000) return cur;
  const { cfg } = await loadConfig(fmt);
  cache = { cfg, at: Date.now(), fmt }; cur = serverList(cfg);
  return cur;
}
const ping = tag => new Promise(res => {
  const o = cache && (cache.cfg.outbounds || []).find(x => x.tag === tag);
  if (!o || !o.server) return res(-1);
  const t = Date.now();
  const s = net.connect({ host: o.server, port: o.server_port, timeout: 3000 }, () => { const d = Date.now() - t; s.destroy(); res(d); });
  s.on('error', () => res(-1));
  s.on('timeout', () => { s.destroy(); res(-1); });
});

// ---------- подключение ----------
const reg = (...a) => new Promise(res => execFile('reg', ['add', REG, '/f', ...a], { windowsHide: true }, () => res()));
async function setProxy(on) {
  await reg('/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', on ? '1' : '0');
  if (on) await reg('/v', 'ProxyServer', '/t', 'REG_SZ', '/d', '127.0.0.1:2080');
}
const proxyOffSync = () => { try { execFileSync('reg', ['add', REG, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'], { windowsHide: true }); } catch {} };

async function disconnect() {
  const p = proc; proc = null;
  if (p) { p.removeAllListeners('exit'); p.kill(); }
  await setProxy(false);
}

async function connect(o = {}) {
  await disconnect();
  mode = o.mode === 'proxy' ? 'proxy' : 'tun';
  const { cfg } = await loadConfig(o.format);
  cache = { cfg, at: Date.now(), fmt: o.format }; cur = serverList(cfg);
  if (o.server && cur.selTag) {
    const sel = cfg.outbounds.find(x => x.tag === cur.selTag);
    if (sel && sel.outbounds.includes(o.server)) sel.default = o.server;
  }
  cfg.log = { level: 'warn', timestamp: true };
  cfg.inbounds = mode === 'tun'
    ? [{ type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], auto_route: true, strict_route: true, stack: 'mixed' }]
    : [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }];
  cfg.route = { ...(cfg.route || {}), auto_detect_interface: true };
  cfg.experimental = { ...(cfg.experimental || {}), clash_api: { external_controller: '127.0.0.1:9090' } };

  const cfgPath = path.join(app.getPath('userData'), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  lastErr = '';
  proc = spawn(path.join(binDir(), 'sing-box.exe'), ['run', '-c', cfgPath, '-D', binDir()], { windowsHide: true });
  proc.on('error', e => { lastErr = 'не удалось запустить sing-box.exe: ' + e.message; proc = null; });
  proc.stderr.on('data', d => { lastErr = (lastErr + d).slice(-1200); });
  proc.stdout.on('data', d => { lastErr = (lastErr + d).slice(-1200); });
  proc.on('exit', () => { proc = null; setProxy(false); });

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (!proc) throw new Error('sing-box остановился: ' + lastErr.trim());
    try { await fetch(CLASH + '/version', { signal: AbortSignal.timeout(1000) }); if (mode === 'proxy') await setProxy(true); return true; } catch {}
  }
  await disconnect();
  throw new Error('sing-box не запустился: ' + lastErr.trim());
}

const h = (c, f) => ipcMain.handle(c, async (_, ...a) => {
  try { return { ok: true, data: await f(...a) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
h('session', () => session ? session.user : null);
h('login', login);
h('logout', async () => { await disconnect(); try { await authed('/cabinet/auth/logout', { method: 'POST', headers: J, body: JSON.stringify({ refresh_token: session.refresh }) }); } catch {} session = null; cache = null; cur = null; save(); });
h('sub', getSub);
h('connect', connect);
h('disconnect', disconnect);
h('status', async () => {
  let now = '';
  if (proc && cur && cur.selTag) {
    try { const r = await fetch(`${CLASH}/proxies/${encodeURIComponent(cur.selTag)}`, { signal: AbortSignal.timeout(2000) }); now = (await r.json()).now || ''; } catch {}
  }
  return { running: !!proc, mode, now };
});
h('servers', servers);
h('ping', ping);
h('pick', async tag => {
  if (proc && cur && cur.selTag) await fetch(`${CLASH}/proxies/${encodeURIComponent(cur.selTag)}`, { method: 'PUT', body: JSON.stringify({ name: tag }) });
  return true;
});
h('register', register);
h('forgot', forgot);
h('tg', tgLogin);
h('tgcancel', async () => { tgCancel = true; });
h('weblogin', webLogin);
h('me', me);
h('cabinet', () => shell.openExternal(CABINET));

if (!app.requestSingleInstanceLock()) app.quit();
app.whenReady().then(() => {
  load();
  setProxy(false); // сбросить «залипший» прокси после прошлого сбоя
  win = new BrowserWindow({
    width: 440, height: 780, resizable: false, autoHideMenuBar: true, backgroundColor: '#0b0f1a',
    title: 'Mikaela VPN', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile('index.html');
});
app.on('before-quit', () => { if (proc) proc.kill(); proxyOffSync(); });
app.on('window-all-closed', () => app.quit());

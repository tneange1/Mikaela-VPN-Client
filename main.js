const { app, BrowserWindow, ipcMain, safeStorage, shell, session: ses } = require('electron');
const path = require('path'), fs = require('fs');
const { spawn, execFile } = require('child_process');

const BASE = process.env.MIKAELA_API || 'https://cabinet.mikaelavpn.xyz';
const CABINET = 'https://cabinet.mikaelavpn.xyz/';
const UA = 'sing-box/1.12.8 MikaelaVPN/1.0 (Windows)';
const CLASH = 'http://127.0.0.1:9090';
const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

let win = null, tgCancel = false;
let session = null, proc = null, mode = 'tun', prefix = null, lastErr = '';
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

// API: пробуем BASE и BASE/api (кабинет может проксировать API под /api)
async function raw(p, o = {}) {
  if (prefix !== null) { try { return await fetch(BASE + prefix + p, o); } catch { throw new Error('Нет связи с сервером'); } }
  const list = prefix !== null ? [prefix] : ['', '/api'];
  let last;
  for (const pf of list) {
    try {
      const r = await fetch(BASE + pf + p, o);
      if ((r.headers.get('content-type') || '').includes('json')) { prefix = pf; return r; }
      last = r;
    } catch (e) { last = e; }
  }
  if (last instanceof Error) throw new Error('Нет связи с сервером');
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
// Telegram: одноразовый токен -> t.me/bot?start=webauth_TOKEN -> опрос
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
// Google / Яндекс / VK / Discord: открываем сам кабинет в окне и забираем токены после входа
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

// system proxy
const reg = (...a) => new Promise(res => execFile('reg', ['add', REG, '/f', ...a], () => res()));
async function setProxy(on) {
  await reg('/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', on ? '1' : '0');
  if (on) await reg('/v', 'ProxyServer', '/t', 'REG_SZ', '/d', '127.0.0.1:2080');
}

async function disconnect() {
  const p = proc; proc = null;
  if (p) { p.removeAllListeners('exit'); p.kill(); }
  await setProxy(false);
}

async function connect(m) {
  await disconnect();
  mode = m === 'proxy' ? 'proxy' : 'tun';
  const s = await getSub();
  const url = s.subscription && s.subscription.subscription_url;
  if (!url) throw new Error('Нет активной подписки. Оформи её в боте или кабинете.');
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  let cfg;
  try { cfg = JSON.parse(await r.text()); }
  catch { throw new Error('Подписка вернула не sing-box конфиг. Включи sing-box шаблон в Remnawave.'); }

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
  proc.stderr.on('data', d => { lastErr = (lastErr + d).slice(-600); });
  proc.stdout.on('data', d => { lastErr = (lastErr + d).slice(-600); });
  proc.on('exit', () => { proc = null; setProxy(false); });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (!proc) throw new Error('sing-box остановился: ' + lastErr.trim());
    try { await fetch(CLASH + '/version'); if (mode === 'proxy') await setProxy(true); return true; } catch {}
  }
  await disconnect();
  throw new Error('sing-box не запустился: ' + lastErr.trim());
}

async function groups() {
  const { proxies } = await (await fetch(CLASH + '/proxies')).json();
  return Object.values(proxies).filter(p => p.type === 'Selector').map(p => ({ name: p.name, now: p.now, all: p.all }));
}

const h = (c, f) => ipcMain.handle(c, async (_, ...a) => {
  try { return { ok: true, data: await f(...a) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
h('session', () => session ? session.user : null);
h('login', login);
h('logout', async () => { await disconnect(); try { await authed('/cabinet/auth/logout', { method: 'POST', headers: J, body: JSON.stringify({ refresh_token: session.refresh }) }); } catch {} session = null; save(); });
h('sub', getSub);
h('connect', connect);
h('disconnect', disconnect);
h('status', async () => ({ running: !!proc, mode, groups: proc ? await groups().catch(() => []) : [] }));
h('select', (g, n) => fetch(`${CLASH}/proxies/${encodeURIComponent(g)}`, { method: 'PUT', body: JSON.stringify({ name: n }) }).then(() => true));
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
  win = new BrowserWindow({
    width: 440, height: 780, resizable: false, autoHideMenuBar: true, backgroundColor: '#0b0f1a',
    title: 'Mikaela VPN', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile('index.html');
});
app.on('before-quit', () => { if (proc) proc.kill(); setProxy(false); });
app.on('window-all-closed', () => app.quit());

// Mikaela VPN — service worker (MV3). Управляет прокси браузера и подставляет логин/пароль прокси-сервера.
const SERVERS_URL = 'https://raw.githubusercontent.com/tneange1/Mikaela-VPN-Client/main/chrome/servers.json'; // список серверов (только данные, не код)
const BASE_BYPASS = ['<local>', 'localhost', '127.0.0.1', '[::1]', '*.local', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

const get = (k) => chrome.storage.local.get(k);
const set = (o) => chrome.storage.local.set(o);

async function loadServers(force) {
  const { servers, fetchedAt = 0 } = await get(['servers', 'fetchedAt']);
  if (!force && servers && servers.length && Date.now() - fetchedAt < 6 * 3600e3) return servers;
  let list = null;
  try {
    const r = await fetch(SERVERS_URL, { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.servers)) list = j.servers; }
  } catch {}
  if (!list || !list.length) {
    try { list = (await (await fetch(chrome.runtime.getURL('servers.json'))).json()).servers; } catch {}
  }
  list = (list || []).filter(s => s && s.host && s.port && s.username && !/REPLACE/.test(s.host));
  if (list.length) await set({ servers: list, fetchedAt: Date.now() });
  return list.length ? list : (servers || []);
}

async function badge(on) {
  const p = on ? 'on' : 'off';
  await chrome.action.setIcon({ path: { 16: `icons/${p}16.png`, 32: `icons/${p}32.png`, 48: `icons/${p}48.png` } });
  await chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#30d158' });
}

async function connect(server) {
  const servers = await loadServers(false);
  const s = typeof server === 'string' ? servers.find(x => x.id === server) : server;
  if (!s) throw new Error('server');
  const bypass = [...BASE_BYPASS, ...servers.map(x => x.host)];   // сами прокси-серверы не пускаем через прокси
  await chrome.proxy.settings.set({ scope: 'regular', value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: s.scheme || 'https', host: s.host, port: +s.port }, bypassList: bypass } } });
  const d = await chrome.proxy.settings.get({ incognito: false });
  if (d.levelOfControl !== 'controlled_by_this_extension') throw new Error('controlled');
  await set({ on: true, active: s.id, lastError: '' });
  await badge(true);
  return s.id;
}

async function disconnect() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
  await set({ on: false, lastError: '' });
  await badge(false);
}

async function state() {
  const d = await chrome.proxy.settings.get({ incognito: false });
  const mine = d.levelOfControl === 'controlled_by_this_extension' && d.value && d.value.mode === 'fixed_servers';
  const st = await get(['active', 'lastError']);
  if (!mine) { await set({ on: false }); await badge(false); }
  return { on: !!mine, active: st.active || null, other: d.levelOfControl === 'controlled_by_other_extensions', error: st.lastError || '' };
}

// логин и пароль прокси подставляются только для проверки подлинности самого прокси-сервера
const tries = new Map();
chrome.webRequest.onAuthRequired.addListener((details, cb) => {
  if (!details.isProxy) return cb({});
  get(['servers', 'active']).then(({ servers = [], active }) => {
    const s = servers.find(x => x.id === active && x.host === details.challenger.host);
    if (!s) return cb({});
    const n = (tries.get(details.requestId) || 0) + 1; tries.set(details.requestId, n);
    if (tries.size > 200) tries.clear();
    if (n > 2) return cb({ cancel: true });   // неверные данные: не зацикливаемся
    cb({ authCredentials: { username: s.username, password: s.password } });
  });
}, { urls: ['<all_urls>'] }, ['asyncBlocking']);

chrome.proxy.onProxyError.addListener((e) => { set({ lastError: String(e.error || 'proxy error').slice(0, 160) }); });

chrome.runtime.onMessage.addListener((m, _s, send) => {
  (async () => {
    try {
      if (m.type === 'state') send({ ok: true, ...(await state()), servers: await loadServers(false) });
      else if (m.type === 'refresh') send({ ok: true, servers: await loadServers(true) });
      else if (m.type === 'connect') { const id = await connect(m.server); send({ ok: true, active: id }); }
      else if (m.type === 'disconnect') { await disconnect(); send({ ok: true }); }
    } catch (e) { send({ ok: false, error: e.message }); }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => { loadServers(true); state(); });
chrome.runtime.onStartup.addListener(() => { state(); });

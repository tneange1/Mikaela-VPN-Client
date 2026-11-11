const { contextBridge, ipcRenderer: ipc } = require('electron');
const call = (c, ...a) => ipc.invoke(c, ...a);
contextBridge.exposeInMainWorld('vpn', {
  session: () => call('session'),
  login: (e, p) => call('login', e, p),
  logout: () => call('logout'),
  sub: () => call('sub'),
  connect: (mode) => call('connect', mode),
  disconnect: () => call('disconnect'),
  status: () => call('status'),
  select: (g, n) => call('select', g, n),
  register: (e, p, n) => call('register', e, p, n),
  forgot: (e) => call('forgot', e),
  tg: () => call('tg'),
  tgCancel: () => call('tgcancel'),
  webLogin: () => call('weblogin'),
  me: () => call('me'),
  openCabinet: () => call('cabinet'),
});

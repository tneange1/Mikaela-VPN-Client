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
  openCabinet: () => call('cabinet'),
});

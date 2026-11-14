const { contextBridge, ipcRenderer: ipc } = require('electron');
const call = (c, ...a) => ipc.invoke(c, ...a);
contextBridge.exposeInMainWorld('vpn', {
  session: () => call('session'), login: (e, p) => call('login', e, p), logout: () => call('logout'),
  register: (e, p, n) => call('register', e, p, n), forgot: (e) => call('forgot', e),
  tg: () => call('tg'), tgCancel: () => call('tgcancel'), webLogin: () => call('weblogin'), me: () => call('me'),
  sub: () => call('sub'), connect: (o) => call('connect', o), disconnect: () => call('disconnect'), status: () => call('status'),
  servers: (o) => call('servers', o), pingMany: (t) => call('pingmany', t), pick: (t) => call('pick', t),
  devices: () => call('devices'), delDevice: (h) => call('deldevice', h), resetDevices: () => call('resetdevices'),
  methods: () => call('methods'), topup: (o) => call('topup', o),
  renewOptions: () => call('renewoptions'), renew: (d) => call('renew', d),
  logs: () => call('logs'), copyLogs: () => call('copylogs'), clearLogs: () => call('clearlogs'), openLogs: () => call('openlogs'), diag: () => call('diag'),
  subs: () => call('subs'), setSub: (id) => call('setsub', id), setRpc: (e) => call('setrpc', e), rpcInfo: () => call('rpcinfo'),
  updInfo: () => call('updinfo'), updCheck: () => call('updcheck'), updInstall: () => call('updinstall'),
  openCabinet: () => call('cabinet'),
});

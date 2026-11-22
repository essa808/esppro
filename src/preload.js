// Safe bridge between UI and main process.
const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };
const channels = ['job:kill','job:openInCmd','serial:open','serial:close','serial:write','serial:setSignals','ports:list',
  'sketch:new','sketch:open','sketch:save','sketch:saveAs','sketch:addFile','sketch:deleteFile','sketch:renameFile','sketch:examples','snapshots:open',
  'build:run','boards:listall','boards:details','boards:detected','core:search','lib:search','cli:job','cli:version',
  'urls:get','urls:set','urls:check','urls:fetchOnline','esptool:status','esptool:install','esptool:run','file:size','partitions:parse','ota:allowFirewall','ota:probeHttp','ota:http',
  'win:deviceManager','drivers:scan','open:external','open:path','open:showItem','dialog:openBins','dialog:saveFile',
  'dialog:chooseDir','file:writeText','file:saveText','file:openText','settings:get','settings:set','i18n:load','data:errors',
  'app:close','app:devtools'];
const api = {};
for (const c of channels) api[c.replace(/:(\w)/g, (_m, l) => l.toUpperCase())] = inv(c);
api.onJobOut = on('job:out'); api.onJobExit = on('job:exit');
api.onSerialData = on('serial:data'); api.onSerialState = on('serial:state');
api.onBeforeClose = on('app:beforeClose');
contextBridge.exposeInMainWorld('esp', api);

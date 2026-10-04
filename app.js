const UUID = Object.freeze({
  service: '000001f0-0000-1000-8000-00805f9b34fb',
  write:   '000001f1-0000-1000-8000-00805f9b34fb',
  notify:  '000001f2-0000-1000-8000-00805f9b34fb',
});

const IMAGE = Object.freeze({ width: 368, height: 368, chunkSize: 446, opcode: 0x06 });
const STORAGE_KEY = 'ebadge.macDeviceMap.v1';

const $ = (id) => document.getElementById(id);
const state = {
  device: null,
  server: null,
  writer: null,
  notifier: null,
  jpeg: null,
  payload: null,
  preferredMac: normalizeMac(new URLSearchParams(location.search).get('mac') || ''),
  sending: false,
};

function ts() {
  return new Date().toISOString();
}
function log(message, data) {
  let line = `[${ts()}] ${message}`;
  if (data !== undefined) line += ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  const area = $('debugLog');
  area.value += (area.value ? '\n' : '') + line;
  area.scrollTop = area.scrollHeight;
  console.log(line);
}
function bytesToHex(bytes, limit = 256) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = a.slice(0, limit);
  const s = [...view].map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
  return a.length > limit ? `${s} … (+${a.length-limit} bytes)` : s;
}
function normalizeMac(value) {
  const hex = String(value || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.length === 12 ? hex : '';
}
function readMap() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function writeMap(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}
function setStatus(connected, text) {
  $('statusChip').textContent = text || (connected ? '接続済み' : '未接続');
  $('statusChip').className = `status-chip ${connected ? 'connected' : 'disconnected'}`;
  $('connectionState').textContent = text || (connected ? '接続済み' : '未接続');
  $('disconnectBtn').disabled = !connected;
  $('sendHexBtn').disabled = !connected;
  updateSendButton();
}
function updateSendButton() {
  $('sendImageBtn').disabled = !(state.writer && state.payload && !state.sending);
}
function bindDevice(device) {
  state.device = device;
  $('deviceName').value = device?.name || '(名称なし)';
  $('deviceId').textContent = device?.id || '-';
  if (device) device.addEventListener('gattserverdisconnected', onDisconnected, { once: true });
}
function onDisconnected() {
  log('GATT disconnected');
  state.server = state.writer = state.notifier = null;
  setStatus(false);
}

async function connectDevice(device, rememberForMac = true) {
  if (!device) throw new Error('Bluetooth device is not selected');
  bindDevice(device);
  log('Connecting', { name: device.name, id: device.id });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(UUID.service);
  const writer = await service.getCharacteristic(UUID.write);
  const notifier = await service.getCharacteristic(UUID.notify);

  notifier.addEventListener('characteristicvaluechanged', onNotify);
  await notifier.startNotifications();

  state.server = server;
  state.writer = writer;
  state.notifier = notifier;
  setStatus(true, `接続済み: ${device.name || 'E-badge'}`);
  log('GATT ready', UUID);

  if (rememberForMac && state.preferredMac) {
    const map = readMap();
    map[state.preferredMac] = { deviceId: device.id, name: device.name || '', updatedAt: Date.now() };
    writeMap(map);
    log('Stored preferred device mapping', { mac: state.preferredMac, deviceId: device.id });
  }
}

async function chooseDevice() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth is not supported in this browser');
  const device = await navigator.bluetooth.requestDevice({
    filters: [
      { name: 'E-badge' },
      { services: ['0000af30-0000-1000-8000-00805f9b34fb'] },
    ],
    optionalServices: [UUID.service],
  });
  await connectDevice(device, true);
}

async function connectPreferred() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth is not supported in this browser');
  if (!navigator.bluetooth.getDevices) {
    log('navigator.bluetooth.getDevices() is not available; opening chooser');
    return chooseDevice();
  }

  const devices = await navigator.bluetooth.getDevices();
  log('Previously permitted Bluetooth devices', devices.map(d => ({ name:d.name, id:d.id })));

  let preferred = null;
  if (state.preferredMac) {
    const mapping = readMap()[state.preferredMac];
    if (mapping?.deviceId) preferred = devices.find(d => d.id === mapping.deviceId) || null;
  }
  if (!preferred && devices.length === 1) preferred = devices[0];
  if (!preferred) {
    log('No matching previously permitted device; opening chooser');
    return chooseDevice();
  }
  await connectDevice(preferred, false);
}

function onNotify(event) {
  const bytes = new Uint8Array(event.target.value.buffer, event.target.value.byteOffset, event.target.value.byteLength);
  log(`RX notify (${bytes.length} bytes)`, bytesToHex(bytes));
  const parsed = parseNotify(bytes);
  if (parsed) log('RX parsed', parsed);
}

function parseNotify(bytes) {
  if (bytes.length < 6 || bytes[0] !== 0xA0) return null;
  const len = bytes[4];
  if (5 + len >= bytes.length) return null;
  const payload = bytes.slice(5, 5 + len);
  let text = '';
  try { text = new TextDecoder().decode(payload); } catch {}
  const checksumOk = bytes.reduce((a,b) => (a+b)&0xff, 0) === 0;
  let json = null;
  if (text.startsWith('{') && text.endsWith('}')) {
    try { json = JSON.parse(text); } catch {}
  }
  return { opcode: bytes[1], length: len, text, json, checksumOk };
}

function additiveChecksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return (-sum) & 0xff;
}

function makeFrame(opcode, total, index, data) {
  const frame = new Uint8Array(8 + data.length + 1);
  frame[0] = 0xF1;
  frame[1] = opcode;
  frame[2] = (total >>> 8) & 0xff;
  frame[3] = total & 0xff;
  frame[4] = (index >>> 8) & 0xff;
  frame[5] = index & 0xff;
  frame[6] = (data.length >>> 8) & 0xff;
  frame[7] = data.length & 0xff;
  frame.set(data, 8);
  frame[frame.length - 1] = additiveChecksum(frame.slice(0, -1));
  return frame;
}

function createImbHeader(jpegLength, width = IMAGE.width, height = IMAGE.height) {
  const b = new Uint8Array(36);
  const v = new DataView(b.buffer);
  b.set([0x49,0x4D,0x42,0x00], 0); // IMB\0
  v.setUint32(0x04, 4, true);
  v.setUint32(0x08, 32 + jpegLength, true); // observed: IMB size minus 4
  v.setUint32(0x0C, 11, true);
  v.setUint16(0x10, width, true);
  v.setUint16(0x12, height, true);
  v.setUint32(0x14, 36, true);
  v.setUint32(0x18, jpegLength, true);
  return b;
}

function concatBytes(...parts) {
  const total = parts.reduce((n,p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function makePicturePayload(jpegBytes) {
  const prefix = new TextEncoder().encode('{"type":6,"data":');
  const imb = createImbHeader(jpegBytes.length);
  const suffix = new TextEncoder().encode('}');
  return concatBytes(prefix, imb, jpegBytes, suffix);
}

async function loadImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = $('previewCanvas');
  const ctx = canvas.getContext('2d', { alpha:false });
  ctx.fillStyle = '#000';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  const mode = $('fitMode').value;
  const sw = bitmap.width, sh = bitmap.height, dw = canvas.width, dh = canvas.height;
  if (mode === 'stretch') {
    ctx.drawImage(bitmap, 0, 0, dw, dh);
  } else {
    const scale = mode === 'cover' ? Math.max(dw/sw, dh/sh) : Math.min(dw/sw, dh/sh);
    const rw = sw * scale, rh = sh * scale;
    ctx.drawImage(bitmap, (dw-rw)/2, (dh-rh)/2, rw, rh);
  }
  bitmap.close();
  await generateJpeg();
}

async function generateJpeg() {
  const canvas = $('previewCanvas');
  const q = Number($('qualityInput').value);
  $('qualityValue').textContent = q.toFixed(2);
  const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('JPEG conversion failed')), 'image/jpeg', q));
  state.jpeg = new Uint8Array(await blob.arrayBuffer());
  state.payload = makePicturePayload(state.jpeg);
  const chunks = Math.ceil(state.payload.length / IMAGE.chunkSize);
  $('jpegSize').textContent = `${state.jpeg.length.toLocaleString()} bytes`;
  $('payloadSize').textContent = `${state.payload.length.toLocaleString()} bytes`;
  $('chunkCount').textContent = String(chunks);
  log('Image prepared', { jpegBytes:state.jpeg.length, payloadBytes:state.payload.length, chunks, quality:q });
  updateSendButton();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendImage() {
  if (!state.writer || !state.payload) throw new Error('Not ready');
  const delayMs = Math.max(0, Number($('chunkDelay').value) || 0);
  const total = Math.ceil(state.payload.length / IMAGE.chunkSize);
  state.sending = true;
  updateSendButton();
  $('sendProgress').value = 0;
  $('progressText').textContent = '0%';
  log('Image transfer start', { total, payloadBytes:state.payload.length, chunkSize:IMAGE.chunkSize, delayMs });

  try {
    for (let n = 0; n < total; n++) {
      const start = n * IMAGE.chunkSize;
      const data = state.payload.slice(start, start + IMAGE.chunkSize);
      const index = total - 1 - n;
      const frame = makeFrame(IMAGE.opcode, total, index, data);
      await state.writer.writeValueWithoutResponse(frame);
      const verbose = $('verboseTxLog').checked;
      log(
        `TX image chunk ${n+1}/${total} index=${index} payload=${data.length} frame=${frame.length}`,
        verbose ? bytesToHex(frame, frame.length) : bytesToHex(frame, 48)
      );
      const pct = Math.round(((n + 1) / total) * 100);
      $('sendProgress').value = pct;
      $('progressText').textContent = `${pct}%`;
      if (delayMs) await sleep(delayMs);
    }
    log('All image chunks written; waiting for device notification');
  } finally {
    state.sending = false;
    updateSendButton();
  }
}

async function sendHex() {
  if (!state.writer) throw new Error('Not connected');
  const clean = $('hexInput').value.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (!clean || clean.length % 2) throw new Error('HEX string must contain an even number of hex digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i=0; i<out.length; i++) out[i] = parseInt(clean.slice(i*2,i*2+2),16);
  log(`TX manual (${out.length} bytes)`, bytesToHex(out));
  await state.writer.writeValueWithoutResponse(out);
}

function wrapAsync(fn) {
  return async (...args) => {
    try { await fn(...args); }
    catch (e) { log(`ERROR: ${e?.message || e}`, { name:e?.name, stack:e?.stack }); alert(e?.message || String(e)); }
  };
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
  });
}

$('macInput').value = state.preferredMac || '';
$('connectPreferredBtn').addEventListener('click', wrapAsync(connectPreferred));
$('chooseDeviceBtn').addEventListener('click', wrapAsync(chooseDevice));
$('disconnectBtn').addEventListener('click', () => state.device?.gatt?.disconnect());
$('qualityInput').addEventListener('input', () => { $('qualityValue').textContent = Number($('qualityInput').value).toFixed(2); });
$('qualityInput').addEventListener('change', wrapAsync(generateJpeg));
$('fitMode').addEventListener('change', async () => {
  const file = $('imageInput').files?.[0];
  if (file) await wrapAsync(loadImageFile)(file);
});
$('imageInput').addEventListener('change', async () => {
  const file = $('imageInput').files?.[0];
  if (file) await wrapAsync(loadImageFile)(file);
});
$('prepareImageBtn').addEventListener('click', wrapAsync(async () => {
  const file = $('imageInput').files?.[0];
  if (!file) throw new Error('画像を選択してください');
  await loadImageFile(file);
}));
$('sendImageBtn').addEventListener('click', wrapAsync(sendImage));
$('sendHexBtn').addEventListener('click', wrapAsync(sendHex));
$('clearLogBtn').addEventListener('click', () => { $('debugLog').value=''; });
$('copyLogBtn').addEventListener('click', wrapAsync(async () => {
  await navigator.clipboard.writeText($('debugLog').value);
  log('Debug log copied to clipboard');
}));
$('downloadLogBtn').addEventListener('click', () => {
  const blob = new Blob([$('debugLog').value], { type:'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ebadge-debug-${new Date().toISOString().replace(/[:.]/g,'-')}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

log('App initialized', {
  href: location.href,
  preferredMac: state.preferredMac || null,
  bluetoothSupported: !!navigator.bluetooth,
  getDevicesSupported: !!navigator.bluetooth?.getDevices,
});
if (!window.isSecureContext) log('WARNING: Not a secure context. Web Bluetooth requires HTTPS or localhost.');

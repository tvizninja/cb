const UUID = Object.freeze({
  service: '000001f0-0000-1000-8000-00805f9b34fb',
  write:   '000001f1-0000-1000-8000-00805f9b34fb',
  notify:  '000001f2-0000-1000-8000-00805f9b34fb',
});

const IMAGE = Object.freeze({ width: 368, height: 368, chunkSize: 446, opcode: 0x06 });
const ANIMATION = Object.freeze({ width: 368, height: 368, chunkSize: 446, opcode: 0x05, imageType: 11 });
const STORAGE_KEY = 'ebadge.macDeviceMap.v1';
const APP_VERSION = '0.5.0';

const $ = (id) => document.getElementById(id);
const state = {
  device: null,
  server: null,
  writer: null,
  notifier: null,
  jpeg: null,
  payload: null,
  animationPayload: null,
  animationFrames: null,
  preferredMac: normalizeMac(new URLSearchParams(location.search).get('mac') || ''),
  sending: false,
  pendingTransferAck: null,
  postTransferInfoWaiter: null,
  imageBitmap: null,
  crop: { zoom: 1, offsetX: 0, offsetY: 0 },
  drag: null,
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
  $('sendAnimBtn').disabled = !(state.writer && state.animationPayload && !state.sending);
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
  if (!parsed) return;
  log('RX parsed', parsed);

  if (parsed.opcode === 0x0B && parsed.text === '{GetPacketSuccess}') {
    state.pendingTransferAck?.resolve(parsed);
    state.pendingTransferAck = null;
  }

  if (parsed.opcode === 0x0D && state.postTransferInfoWaiter) {
    state.postTransferInfoWaiter.resolve(parsed);
    state.postTransferInfoWaiter = null;
  }
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


function writeU32LE(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function makeAnimationPayload(jpegFrames, intervalMs) {
  if (!Array.isArray(jpegFrames) || jpegFrames.length < 2) throw new Error('Animation needs at least 2 frames');
  const frameCount = jpegFrames.length;
  const enc = new TextEncoder();
  const prefix = enc.encode('{"type":5,"data":');
  const suffix = enc.encode('}');
  const pathText = `output/${intervalMs}ms`;
  const pathBytes = enc.encode(pathText);
  if (pathBytes.length > 12) throw new Error(`Animation path field is too long: ${pathText}`);

  const firstRecordOffset = 32 + frameCount * 16;
  const recordOffsets = [];
  let cursor = firstRecordOffset;
  for (const jpeg of jpegFrames) {
    recordOffsets.push(cursor);
    cursor += 32 + jpeg.length;
  }
  const dataLength = cursor;
  const data = new Uint8Array(dataLength);
  const view = new DataView(data.buffer);

  // Confirmed from HCI capture: 0x12345678, directory-size field, frame count, frame interval.
  writeU32LE(view, 0, 0x12345678);
  writeU32LE(view, 4, 24 + frameCount * 16); // observed: firstRecordOffset - 8
  writeU32LE(view, 8, frameCount);
  writeU32LE(view, 12, intervalMs);
  data.set(pathBytes, 16); // fixed 12-byte field, zero padded
  writeU32LE(view, 28, dataLength - 1); // observed exact value in captures

  for (let i = 0; i < frameCount; i++) {
    const tableOffset = 32 + i * 16;
    const name = `frame_${String(i + 1).padStart(5, '0')}.`;
    const nameBytes = enc.encode(name);
    if (nameBytes.length !== 12) throw new Error(`Unexpected frame name length: ${name}`);
    data.set(nameBytes, tableOffset);
    writeU32LE(view, tableOffset + 12, recordOffsets[i]);
  }

  for (let i = 0; i < frameCount; i++) {
    const jpeg = jpegFrames[i];
    const recordOffset = recordOffsets[i];
    const nextOffset = i + 1 < frameCount ? recordOffsets[i + 1] : recordOffsets[0]; // circular list observed
    writeU32LE(view, recordOffset + 0, recordOffset);
    writeU32LE(view, recordOffset + 4, nextOffset);
    writeU32LE(view, recordOffset + 8, ANIMATION.imageType);
    view.setUint16(recordOffset + 12, ANIMATION.width, true);
    view.setUint16(recordOffset + 14, ANIMATION.height, true);
    writeU32LE(view, recordOffset + 16, recordOffset + 32);
    writeU32LE(view, recordOffset + 20, jpeg.length);
    writeU32LE(view, recordOffset + 24, 0);
    writeU32LE(view, recordOffset + 28, 0);
    data.set(jpeg, recordOffset + 32);
  }

  return concatBytes(prefix, data, suffix);
}

function animationSettings() {
  const durationSec = Number($('animDuration').value);
  const fps = Number($('animFps').value);
  const intervalMs = Math.max(1, Math.round(Number($('animIntervalMs').value) || (1000 / fps)));
  const frameCount = Math.max(2, Math.round(durationSec * fps));
  return { durationSec, fps, intervalMs, frameCount };
}

function updateAnimationSettingsUi(syncInterval = false) {
  const fps = Number($('animFps').value);
  if (syncInterval) $('animIntervalMs').value = String(Math.max(1, Math.round(1000 / fps)));
  const { frameCount } = animationSettings();
  $('animFrameCount').value = String(frameCount);
  $('animQualityValue').textContent = Number($('animQuality').value).toFixed(2);
}

function drawMovingColorBars(canvas, frameIndex, frameCount) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const w = canvas.width, h = canvas.height;
  const colors = ['#ffffff','#ffff00','#00ffff','#00ff00','#ff00ff','#ff0000','#0000ff','#000000'];
  const barW = w / colors.length;
  const shift = (frameIndex / frameCount) * w;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  for (let repeat = -1; repeat <= 1; repeat++) {
    for (let i = 0; i < colors.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.fillRect(i * barW + repeat * w + shift, 0, Math.ceil(barW) + 1, h);
    }
  }
  // A fixed reference line makes motion/direction obvious on the badge.
  ctx.fillStyle = '#000';
  ctx.fillRect(Math.floor(w / 2) - 2, 0, 4, h);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${frameIndex + 1}/${frameCount}`, w / 2, h - 12);
}

async function canvasToJpegBytes(canvas, quality) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    b => b ? resolve(b) : reject(new Error('JPEG conversion failed')),
    'image/jpeg', quality
  ));
  return new Uint8Array(await blob.arrayBuffer());
}


function drawSourceToCanvas(source, canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const dw = canvas.width, dh = canvas.height;
  const sw = source.displayWidth || source.videoWidth || source.naturalWidth || source.width;
  const sh = source.displayHeight || source.videoHeight || source.naturalHeight || source.height;
  if (!sw || !sh) throw new Error('メディアの寸法を取得できません');
  const scale = Math.max(dw / sw, dh / sh);
  const rw = sw * scale, rh = sh * scale;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(source, (dw - rw) / 2, (dh - rh) / 2, rw, rh);
}

function once(target, eventName) {
  return new Promise((resolve, reject) => {
    const ok = (e) => { cleanup(); resolve(e); };
    const bad = () => { cleanup(); reject(new Error(`${eventName} failed`)); };
    const cleanup = () => {
      target.removeEventListener(eventName, ok);
      target.removeEventListener('error', bad);
    };
    target.addEventListener(eventName, ok, { once: true });
    target.addEventListener('error', bad, { once: true });
  });
}

async function prepareVideoFrames(file, settings, quality, canvas) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await once(video, 'loadedmetadata');
    const sourceDuration = Number.isFinite(video.duration) ? video.duration : settings.durationSec;
    const durationSec = Math.min(settings.durationSec, Math.max(0.05, sourceDuration));
    const frameCount = Math.max(2, Math.round(durationSec * settings.fps));
    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      const t = Math.min(Math.max(0, sourceDuration - 0.001), i / settings.fps);
      if (Math.abs(video.currentTime - t) > 0.0005) {
        video.currentTime = t;
        await once(video, 'seeked');
      }
      drawSourceToCanvas(video, canvas);
      frames.push(await canvasToJpegBytes(canvas, quality));
      if ((i & 3) === 3) await sleep(0);
    }
    return { frames, sourceDuration, sampledDuration: durationSec, sourceKind: 'video' };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
  }
}

async function prepareGifFrames(file, settings, quality, canvas) {
  if (!('ImageDecoder' in window)) {
    throw new Error('このブラウザではGIFフレーム展開用 ImageDecoder が利用できません。GIFはChromium系の新しいブラウザで試してください。');
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const decoder = new ImageDecoder({ data, type: file.type || 'image/gif' });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  const sourceFrameCount = track?.frameCount || 0;
  if (!sourceFrameCount) throw new Error('GIFのフレーム数を取得できません');

  const decoded = [];
  let totalUs = 0;
  for (let i = 0; i < sourceFrameCount; i++) {
    const result = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
    const image = result.image;
    const durationUs = Math.max(1000, Number(image.duration) || 100000);
    decoded.push({ image, startUs: totalUs, durationUs });
    totalUs += durationUs;
  }

  try {
    const sourceDuration = totalUs / 1e6;
    const durationSec = Math.min(settings.durationSec, Math.max(0.05, sourceDuration));
    const frameCount = Math.max(2, Math.round(durationSec * settings.fps));
    const frames = [];
    let srcIdx = 0;
    for (let i = 0; i < frameCount; i++) {
      const targetUs = Math.floor((i / settings.fps) * 1e6);
      while (srcIdx + 1 < decoded.length && decoded[srcIdx + 1].startUs <= targetUs) srcIdx++;
      drawSourceToCanvas(decoded[srcIdx].image, canvas);
      frames.push(await canvasToJpegBytes(canvas, quality));
      if ((i & 3) === 3) await sleep(0);
    }
    return { frames, sourceDuration, sampledDuration: durationSec, sourceKind: 'gif', sourceFrameCount };
  } finally {
    for (const f of decoded) f.image.close?.();
    decoder.close?.();
  }
}

async function prepareMediaFrames(file, settings, quality, canvas) {
  if (!file) throw new Error('GIFまたは動画ファイルを選択してください');
  if (file.type === 'image/gif' || /\.gif$/i.test(file.name)) {
    return prepareGifFrames(file, settings, quality, canvas);
  }
  if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
    return prepareVideoFrames(file, settings, quality, canvas);
  }
  throw new Error(`未対応のアニメーション入力形式です: ${file.type || file.name}`);
}

async function prepareAnimationTest() {
  const settings = animationSettings();
  const quality = Number($('animQuality').value);
  const canvas = $('animPreviewCanvas');
  const mode = $('animSourceMode').value;
  let frames = [];
  let sourceMeta = { sourceKind: 'bars', sampledDuration: settings.durationSec };
  $('animTransferResult').className = 'transfer-result';
  $('animTransferResult').textContent = '生成中…';

  if (mode === 'file') {
    const file = $('animMediaInput').files?.[0];
    sourceMeta = await prepareMediaFrames(file, settings, quality, canvas);
    frames = sourceMeta.frames;
  } else {
    for (let i = 0; i < settings.frameCount; i++) {
      drawMovingColorBars(canvas, i, settings.frameCount);
      frames.push(await canvasToJpegBytes(canvas, quality));
      if ((i & 7) === 7) await sleep(0);
    }
    drawMovingColorBars(canvas, 0, settings.frameCount);
  }

  const jpegTotal = frames.reduce((n, b) => n + b.length, 0);
  const payload = makeAnimationPayload(frames, settings.intervalMs);
  state.animationFrames = frames;
  state.animationPayload = payload;
  const chunks = Math.ceil(payload.length / ANIMATION.chunkSize);
  $('animFrameCount').value = String(frames.length);
  $('animJpegBytes').textContent = `${jpegTotal.toLocaleString()} bytes`;
  $('animPayloadBytes').textContent = `${payload.length.toLocaleString()} bytes`;
  $('animChunkCount').textContent = String(chunks);
  $('animTransferResult').textContent = `生成完了。${frames.length} frames / interval ${settings.intervalMs} ms`;
  log('Animation prepared', {
    mode, durationSec: settings.durationSec, fps: settings.fps, intervalMs: settings.intervalMs,
    frameCount: frames.length, jpegTotal, payloadBytes: payload.length, chunks, quality,
    sourceMeta: { ...sourceMeta, frames: undefined }
  });
  updateSendButton();
}

async function sendAnimation() {
  if (!state.writer || !state.animationPayload) throw new Error('Animation is not ready');
  const payload = state.animationPayload;
  const delayMs = Math.max(0, Number($('animChunkDelay').value) || 0);
  const total = Math.ceil(payload.length / ANIMATION.chunkSize);
  state.sending = true;
  updateSendButton();
  $('animSendProgress').value = 0;
  $('animProgressText').textContent = '0%';
  $('animTransferResult').className = 'transfer-result';
  $('animTransferResult').textContent = '転送中…';
  log('Animation transfer start', { total, payloadBytes:payload.length, chunkSize:ANIMATION.chunkSize, delayMs, opcode:ANIMATION.opcode });

  const ackWait = deferredAck('GetPacketSuccess');
  state.pendingTransferAck = ackWait;
  try {
    for (let n = 0; n < total; n++) {
      const start = n * ANIMATION.chunkSize;
      const chunk = payload.slice(start, start + ANIMATION.chunkSize);
      const index = total - 1 - n;
      const frame = makeFrame(ANIMATION.opcode, total, index, chunk);
      await state.writer.writeValueWithoutResponse(frame);
      const verbose = $('verboseTxLog').checked;
      log(`TX animation chunk ${n+1}/${total} index=${index} payload=${chunk.length} frame=${frame.length}`,
          verbose ? bytesToHex(frame, frame.length) : bytesToHex(frame, 48));
      const pct = Math.round(((n + 1) / total) * 100);
      $('animSendProgress').value = pct;
      $('animProgressText').textContent = `${pct}%`;
      if (delayMs) await sleep(delayMs);
    }
    ackWait.arm(30000);
    log('All animation chunks written; waiting up to 30000 ms for {GetPacketSuccess}');
    const ack = await ackWait.promise;
    if (state.pendingTransferAck === ackWait) state.pendingTransferAck = null;
    log('Animation transfer acknowledged', { opcode: ack.opcode, text: ack.text });
    $('animTransferResult').className = 'transfer-result success';
    $('animTransferResult').textContent = '転送成功: type 5データをバッジが受理しました';

    if ($('animAutoDisconnect').checked) {
      log('Waiting for post-transfer device info before animation disconnect');
      try {
        const info = await waitForPostTransferDeviceInfo(3000);
        log('Post-transfer device info received', info.json || { text: info.text });
      } catch (e) {
        log('Post-transfer device info was not observed; disconnecting anyway', { message:e.message });
      }
      await sleep(150);
      if (state.device?.gatt?.connected) {
        log('Auto disconnect after successful animation transfer');
        state.device.gatt.disconnect();
      }
    }
  } catch (e) {
    if (state.pendingTransferAck === ackWait) state.pendingTransferAck = null;
    $('animTransferResult').className = 'transfer-result error';
    $('animTransferResult').textContent = `転送失敗: ${e?.message || e}`;
    throw e;
  } finally {
    state.sending = false;
    updateSendButton();
  }
}

function resetCrop(render = true) {
  state.crop.zoom = 1;
  state.crop.offsetX = 0;
  state.crop.offsetY = 0;
  $('zoomInput').value = '1';
  $('zoomValue').textContent = '1.00×';
  if (render && state.imageBitmap) renderPreview();
}

function clampCropOffset(rw, rh, dw, dh) {
  const maxX = Math.max(0, (rw - dw) / 2);
  const maxY = Math.max(0, (rh - dh) / 2);
  state.crop.offsetX = Math.max(-maxX, Math.min(maxX, state.crop.offsetX));
  state.crop.offsetY = Math.max(-maxY, Math.min(maxY, state.crop.offsetY));
}

function renderPreview() {
  const bitmap = state.imageBitmap;
  if (!bitmap) return;
  const canvas = $('previewCanvas');
  const ctx = canvas.getContext('2d', { alpha:false });
  const dw = canvas.width, dh = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, dw, dh);

  const mode = $('fitMode').value;
  const sw = bitmap.width, sh = bitmap.height;
  if (mode === 'stretch') {
    ctx.drawImage(bitmap, 0, 0, dw, dh);
  } else {
    const baseScale = mode === 'cover' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
    const zoom = mode === 'cover' ? state.crop.zoom : 1;
    const scale = baseScale * zoom;
    const rw = sw * scale, rh = sh * scale;
    if (mode === 'cover') clampCropOffset(rw, rh, dw, dh);
    const ox = mode === 'cover' ? state.crop.offsetX : 0;
    const oy = mode === 'cover' ? state.crop.offsetY : 0;
    ctx.drawImage(bitmap, (dw - rw) / 2 + ox, (dh - rh) / 2 + oy, rw, rh);
  }

  const cropEnabled = mode === 'cover';
  $('zoomInput').disabled = !cropEnabled;
  $('resetCropBtn').disabled = !cropEnabled;
  $('cropHint').classList.toggle('hidden', !cropEnabled);
  canvas.style.cursor = cropEnabled ? 'grab' : 'default';
}

async function loadImageFile(file) {
  state.imageBitmap?.close?.();
  state.imageBitmap = await createImageBitmap(file);
  resetCrop(false);
  renderPreview();
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

function deferredWithTimeout(timeoutMs, label) {
  let timer;
  let resolveOuter, rejectOuter;
  const promise = new Promise((resolve, reject) => {
    resolveOuter = (value) => { clearTimeout(timer); resolve(value); };
    rejectOuter = (err) => { clearTimeout(timer); reject(err); };
    timer = setTimeout(() => rejectOuter(new Error(`${label} timeout (${timeoutMs} ms)`)), timeoutMs);
  });
  return { promise, resolve: resolveOuter, reject: rejectOuter };
}

function deferredAck(label = 'GetPacketSuccess') {
  let timer = null;
  let settled = false;
  let resolveOuter, rejectOuter;
  const promise = new Promise((resolve, reject) => {
    resolveOuter = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    rejectOuter = (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); };
  });
  return {
    promise,
    resolve: resolveOuter,
    reject: rejectOuter,
    arm(timeoutMs) {
      if (settled || timer) return;
      timer = setTimeout(() => rejectOuter(new Error(`${label} timeout (${timeoutMs} ms after final chunk)`)), timeoutMs);
    },
    get settled() { return settled; }
  };
}

async function waitForTransferAck(timeoutMs = 5000) {
  const d = deferredWithTimeout(timeoutMs, 'GetPacketSuccess');
  state.pendingTransferAck = d;
  try { return await d.promise; }
  finally { if (state.pendingTransferAck === d) state.pendingTransferAck = null; }
}

async function waitForPostTransferDeviceInfo(timeoutMs = 3000) {
  const d = deferredWithTimeout(timeoutMs, 'post-transfer device info');
  state.postTransferInfoWaiter = d;
  try { return await d.promise; }
  finally { if (state.postTransferInfoWaiter === d) state.postTransferInfoWaiter = null; }
}

async function sendImage() {
  if (!state.writer || !state.payload) throw new Error('Not ready');
  const delayMs = Math.max(0, Number($('chunkDelay').value) || 0);
  const total = Math.ceil(state.payload.length / IMAGE.chunkSize);
  state.sending = true;
  updateSendButton();
  $('sendProgress').value = 0;
  $('progressText').textContent = '0%';
  $('transferResult').className = 'transfer-result';
  $('transferResult').textContent = '転送中…';
  log('Image transfer start', { total, payloadBytes:state.payload.length, chunkSize:IMAGE.chunkSize, delayMs });

  // ACK waiter must exist before the last chunk is sent, because the badge can answer quickly.
  const ackWait = deferredAck('GetPacketSuccess');
  state.pendingTransferAck = ackWait;

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

    ackWait.arm(15000);
    log('All image chunks written; waiting up to 15000 ms for {GetPacketSuccess}');
    const ack = await ackWait.promise;
    if (state.pendingTransferAck === ackWait) state.pendingTransferAck = null;
    log('Image transfer acknowledged', { opcode: ack.opcode, text: ack.text });
    $('transferResult').className = 'transfer-result success';
    $('transferResult').textContent = '転送成功: バッジがデータを受理しました';

    if ($('autoDisconnect').checked) {
      log('Waiting for post-transfer device info before disconnect');
      try {
        const info = await waitForPostTransferDeviceInfo(3000);
        log('Post-transfer device info received', info.json || { text: info.text });
      } catch (e) {
        log('Post-transfer device info was not observed; disconnecting anyway', { message:e.message });
      }
      await sleep(150);
      if (state.device?.gatt?.connected) {
        log('Auto disconnect after successful image transfer');
        state.device.gatt.disconnect();
      }
    }
  } catch (e) {
    if (state.pendingTransferAck === ackWait) state.pendingTransferAck = null;
    $('transferResult').className = 'transfer-result error';
    $('transferResult').textContent = `転送失敗: ${e?.message || e}`;
    throw e;
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
$('fitMode').addEventListener('change', wrapAsync(async () => {
  if (!state.imageBitmap) return;
  resetCrop(false);
  renderPreview();
  await generateJpeg();
}));
$('zoomInput').addEventListener('input', () => {
  state.crop.zoom = Number($('zoomInput').value);
  $('zoomValue').textContent = `${state.crop.zoom.toFixed(2)}×`;
  renderPreview();
});
$('zoomInput').addEventListener('change', wrapAsync(generateJpeg));
$('resetCropBtn').addEventListener('click', wrapAsync(async () => {
  if (!state.imageBitmap) return;
  resetCrop();
  await generateJpeg();
}));
$('imageInput').addEventListener('change', async () => {
  const file = $('imageInput').files?.[0];
  if (file) await wrapAsync(loadImageFile)(file);
});
$('prepareImageBtn').addEventListener('click', wrapAsync(async () => {
  if (!state.imageBitmap) {
    const file = $('imageInput').files?.[0];
    if (!file) throw new Error('画像を選択してください');
    await loadImageFile(file);
    return;
  }
  renderPreview();
  await generateJpeg();
}));

const cropCanvas = $('previewCanvas');
cropCanvas.addEventListener('pointerdown', (event) => {
  if (!state.imageBitmap || $('fitMode').value !== 'cover') return;
  event.preventDefault();
  cropCanvas.setPointerCapture(event.pointerId);
  const rect = cropCanvas.getBoundingClientRect();
  state.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: state.crop.offsetX,
    offsetY: state.crop.offsetY,
    scaleX: cropCanvas.width / rect.width,
    scaleY: cropCanvas.height / rect.height,
  };
  cropCanvas.classList.add('dragging');
});
cropCanvas.addEventListener('pointermove', (event) => {
  const d = state.drag;
  if (!d || d.pointerId !== event.pointerId) return;
  event.preventDefault();
  state.crop.offsetX = d.offsetX + (event.clientX - d.startX) * d.scaleX;
  state.crop.offsetY = d.offsetY + (event.clientY - d.startY) * d.scaleY;
  renderPreview();
});
async function endCropDrag(event) {
  const d = state.drag;
  if (!d || d.pointerId !== event.pointerId) return;
  state.drag = null;
  cropCanvas.classList.remove('dragging');
  try { cropCanvas.releasePointerCapture(event.pointerId); } catch {}
  try { await generateJpeg(); } catch (e) { log(`ERROR: ${e?.message || e}`); }
}
cropCanvas.addEventListener('pointerup', endCropDrag);
cropCanvas.addEventListener('pointercancel', endCropDrag);
$('sendImageBtn').addEventListener('click', wrapAsync(sendImage));
$('animDuration').addEventListener('change', () => { state.animationPayload = null; updateAnimationSettingsUi(); updateSendButton(); });
$('animFps').addEventListener('change', () => { state.animationPayload = null; updateAnimationSettingsUi(true); updateSendButton(); });
$('animIntervalMs').addEventListener('change', () => { state.animationPayload = null; updateAnimationSettingsUi(); updateSendButton(); });
$('animSourceMode').addEventListener('change', () => {
  const isFile = $('animSourceMode').value === 'file';
  $('animMediaInput').disabled = !isFile;
  state.animationPayload = null;
  updateSendButton();
});
$('animMediaInput').addEventListener('change', () => { state.animationPayload = null; updateSendButton(); });
$('animQuality').addEventListener('input', () => { $('animQualityValue').textContent = Number($('animQuality').value).toFixed(2); });
$('animQuality').addEventListener('change', () => { state.animationPayload = null; updateSendButton(); });
$('prepareAnimBtn').addEventListener('click', wrapAsync(prepareAnimationTest));
$('sendAnimBtn').addEventListener('click', wrapAsync(sendAnimation));
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

updateAnimationSettingsUi(true);
drawMovingColorBars($('animPreviewCanvas'), 0, animationSettings().frameCount);
$('appVersion').textContent = `E-badge Web BLE v${APP_VERSION}`;
log('App initialized', {
  version: APP_VERSION,
  href: location.href,
  preferredMac: state.preferredMac || null,
  bluetoothSupported: !!navigator.bluetooth,
  getDevicesSupported: !!navigator.bluetooth?.getDevices,
});
if (!window.isSecureContext) log('WARNING: Not a secure context. Web Bluetooth requires HTTPS or localhost.');

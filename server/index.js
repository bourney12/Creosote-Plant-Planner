const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const port = Number(process.env.PORT || 3000);
const upstreamBridgeUrl = process.env.MASTER_BRIDGE_URL || 'https://script.google.com/macros/s/AKfycbx1MO2PmRD7jkoFeKhIjAiSC5vOF6tMrVAXaKO-AU8jZF21e7upIG5BEr6V4ABz8atw/exec';
const masterCacheTtlMs = Number(process.env.MASTER_CACHE_TTL_MS || 5 * 60 * 1000);
const masterCacheStaleMs = Number(process.env.MASTER_CACHE_STALE_MS || 24 * 60 * 60 * 1000);
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 180 * 1000);
const syncLiveStateUpstream = String(process.env.LIVE_STATE_SYNC_UPSTREAM || '1') !== '0';
const compactMasterPayloadEnabled = String(process.env.COMPACT_MASTER_PAYLOAD || '1') !== '0';

const masterCache = new Map();
const masterInflight = new Map();
let upstreamLiveHydrated = false;
let liveWriteQueue = Promise.resolve();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readJsonFile(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(name, value) {
  ensureDataDir();
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

function send(req, res, status, body, headers = {}) {
  const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const shouldGzip = acceptsGzip && bodyBuffer.length > 1024 && !headers['Content-Encoding'];
  const finalBody = shouldGzip ? zlib.gzipSync(bodyBuffer) : bodyBuffer;
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    ...(shouldGzip ? { 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' } : {}),
    ...headers
  });
  res.end(finalBody);
}

function sendJson(req, res, payload, callback) {
  const body = JSON.stringify(payload);
  if (callback) {
    send(req, res, 200, `${callback}(${body});`, { 'Content-Type': 'application/javascript; charset=utf-8' });
    return;
  }
  send(req, res, 200, body, { 'Content-Type': 'application/json; charset=utf-8' });
}

function sendError(req, res, err, callback) {
  sendJson(req, res, { ok: false, error: err && err.message ? err.message : String(err) }, callback);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const text = await response.text();
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status}: ${text.slice(0, 240)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

const compactRowKeys = new Set([
  'productCode', 'productDescription', 'description', 'm3PerPole', 'cubeEachM3', 'quantity', 'totalM3'
]);

function compactRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  Object.keys(row).forEach(key => {
    if (compactRowKeys.has(key) || key[0] === '_') out[key] = row[key];
  });
  return out;
}

function compactRows(rows) {
  return Array.isArray(rows) ? rows.map(compactRow) : rows;
}

function compactProductsByCharge(productsByCharge) {
  const out = {};
  Object.entries(productsByCharge || {}).forEach(([charge, rows]) => {
    out[charge] = compactRows(rows);
  });
  return out;
}

function compactMasterPayload(payload) {
  if (!compactMasterPayloadEnabled || !payload || payload.ok === false) return payload;
  const compact = { ...payload };
  compact.productsByCharge = compactProductsByCharge(payload.productsByCharge);
  compact.unassignedProducts = compactRows(payload.unassignedProducts);
  compact.plannedScheduleProducts = compactRows(payload.plannedScheduleProducts);
  compact.greenTreatmentProducts = compactRows(payload.greenTreatmentProducts);
  compact.inventoryMovements = compactRows(payload.inventoryMovements);
  compact.allocationToStackRows = compactRows(payload.allocationToStackRows || payload.allocationToStack);
  compact.allocationToStack = compact.allocationToStackRows;
  compact.rawPoleProducts = [];
  compact.allProducts = [];
  if (payload.poleForecast && typeof payload.poleForecast === 'object') {
    compact.poleForecast = {
      ...payload.poleForecast,
      rows: compactRows(payload.poleForecast.rows),
      products: compactRows(payload.poleForecast.products)
    };
  }
  compact.serverCompact = { enabled: true, duplicateAllProductsRemoved: true, duplicateRawPoleProductsRemoved: true };
  return compact;
}

function upstreamUrl(params) {
  const url = new URL(upstreamBridgeUrl);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function masterCacheKey(params) {
  return JSON.stringify({
    includeInventory: params.includeInventory === '1' ? '1' : '',
    includeAllocationToStack: params.includeAllocationToStack === '1' ? '1' : '',
    includeProductMaster: params.includeProductMaster === '1' ? '1' : ''
  });
}

async function refreshMasterPayload(key, params) {
  if (masterInflight.has(key)) return masterInflight.get(key);
  const work = (async () => {
    const payload = compactMasterPayload(await fetchJson(upstreamUrl(params)));
    if (!payload || payload.ok === false) throw new Error(payload && payload.error ? payload.error : 'Upstream returned no master data');
    const record = { payload: { ...payload, serverCache: { refreshedAt: new Date().toISOString(), key } }, savedAt: Date.now() };
    masterCache.set(key, record);
    writeJsonFile(`master-cache-${Buffer.from(key).toString('base64url')}.json`, record);
    return record;
  })().finally(() => masterInflight.delete(key));
  masterInflight.set(key, work);
  return work;
}

async function getMasterPayload(params) {
  const key = masterCacheKey(params);
  let record = masterCache.get(key) || readJsonFile(`master-cache-${Buffer.from(key).toString('base64url')}.json`, null);
  if (record) masterCache.set(key, record);
  const age = record ? Date.now() - Number(record.savedAt || 0) : Infinity;
  if (age < masterCacheTtlMs) return { ...record.payload, serverCache: { ...(record.payload.serverCache || {}), ageMs: age, fresh: true } };
  if (record && age < masterCacheStaleMs) {
    refreshMasterPayload(key, params).catch(err => console.warn('background master refresh failed:', err.message));
    return { ...record.payload, serverCache: { ...(record.payload.serverCache || {}), ageMs: age, fresh: false, refreshing: true } };
  }
  record = await refreshMasterPayload(key, params);
  return { ...record.payload, serverCache: { ...(record.payload.serverCache || {}), ageMs: 0, fresh: true } };
}

function currentWeekIsoDateSet() {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const out = new Set();
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    out.add(day.toISOString().slice(0, 10));
  }
  return out;
}

function pruneLiveBucket(bucket) {
  const allowed = currentWeekIsoDateSet();
  let changed = false;
  Object.keys(bucket || {}).forEach(key => {
    const entry = bucket[key];
    if (!entry || !allowed.has(String(entry.actualDate || ''))) {
      delete bucket[key];
      changed = true;
    }
  });
  return changed;
}

function readLiveState() {
  const state = readJsonFile('live-state.json', { ok: true, actuals: {}, gaps: {}, updatedAt: '' });
  state.ok = true;
  state.actuals = state.actuals || {};
  state.gaps = state.gaps || {};
  if (pruneLiveBucket(state.actuals) || pruneLiveBucket(state.gaps)) {
    state.updatedAt = new Date().toISOString();
    writeJsonFile('live-state.json', state);
  }
  return state;
}

function saveLiveState(state) {
  state.ok = true;
  state.updatedAt = new Date().toISOString();
  writeJsonFile('live-state.json', state);
  return { ...state, serverTime: new Date().toISOString() };
}

function withLiveMutation(work) {
  const next = liveWriteQueue.then(work, work);
  liveWriteQueue = next.catch(() => {});
  return next;
}

async function hydrateLiveStateFromUpstream() {
  if (upstreamLiveHydrated || !upstreamBridgeUrl) return;
  upstreamLiveHydrated = true;
  let local = readLiveState();
  if (local.updatedAt && Object.keys(local.actuals || {}).length + Object.keys(local.gaps || {}).length > 0) return;
  try {
    const remote = await fetchJson(upstreamUrl({ action: 'getLiveState' }));
    local = readLiveState();
    if (local.updatedAt || Object.keys(local.actuals || {}).length + Object.keys(local.gaps || {}).length > 0) return;
    if (remote && remote.ok !== false) {
      writeJsonFile('live-state.json', {
        ok: true,
        actuals: remote.actuals || {},
        gaps: remote.gaps || {},
        updatedAt: remote.updatedAt || new Date().toISOString()
      });
    }
  } catch (err) {
    console.warn('live-state upstream hydration failed:', err.message);
  }
}

async function syncActionUpstream(params) {
  if (!syncLiveStateUpstream || !upstreamBridgeUrl) return;
  try {
    await fetchJson(upstreamUrl(params));
  } catch (err) {
    console.warn('live-state upstream sync failed:', err.message);
  }
}

async function handleLiveAction(params) {
  hydrateLiveStateFromUpstream();
  const action = String(params.action || '');
  if (action === 'getLiveState') return { ...readLiveState(), serverTime: new Date().toISOString() };
  if (action === 'saveActual' || action === 'saveGap') {
    return withLiveMutation(() => {
      const state = readLiveState();
      const bucketName = action === 'saveGap' ? 'gaps' : 'actuals';
      if (!params.key) throw new Error('Missing live state key');
      state[bucketName][String(params.key)] = typeof params.value === 'string' ? JSON.parse(params.value || '{}') : (params.value || {});
      const saved = saveLiveState(state);
      syncActionUpstream(params);
      return saved;
    });
  }
  if (action === 'deleteActual' || action === 'deleteGap') {
    return withLiveMutation(() => {
      const state = readLiveState();
      const bucketName = action === 'deleteGap' ? 'gaps' : 'actuals';
      if (!params.key) throw new Error('Missing live state key');
      delete state[bucketName][String(params.key)];
      const saved = saveLiveState(state);
      syncActionUpstream(params);
      return saved;
    });
  }
  if (action === 'clearPlant') {
    return withLiveMutation(() => {
      const state = readLiveState();
      const prefix = `${params.day}_${params.pid}_`;
      Object.keys(state.actuals).forEach(key => { if (key.startsWith(prefix)) delete state.actuals[key]; });
      Object.keys(state.gaps).forEach(key => { if (key.startsWith(`${prefix}gap`)) delete state.gaps[key]; });
      const saved = saveLiveState(state);
      syncActionUpstream(params);
      return saved;
    });
  }
  if (action === 'clearAllLive') {
    return withLiveMutation(() => {
      const saved = saveLiveState({ ok: true, actuals: {}, gaps: {}, updatedAt: '' });
      syncActionUpstream(params);
      return saved;
    });
  }
  return fetchJson(upstreamUrl(params));
}

async function handleBridge(req, res, url) {
  const callback = url.searchParams.get('callback') || '';
  try {
    const params = req.method === 'POST'
      ? { ...Object.fromEntries(url.searchParams), ...(await parseBody(req)) }
      : Object.fromEntries(url.searchParams);
    delete params.callback;
    delete params._;
    if (params.action === 'saveDeliveryPlan') {
      writeJsonFile('delivery-plan.json', { ok: true, data: params.data || {}, updatedAt: new Date().toISOString() });
      sendJson(req, res, { ok: true, updatedAt: new Date().toISOString() }, callback);
      return;
    }
    if (params.action === 'saveTankLevels') {
      writeJsonFile('tank-levels.json', { ok: true, data: params.data || {}, updatedAt: new Date().toISOString() });
      sendJson(req, res, { ok: true, updatedAt: new Date().toISOString() }, callback);
      return;
    }
    if (params.action) {
      sendJson(req, res, await handleLiveAction(params), callback);
      return;
    }
    sendJson(req, res, await getMasterPayload(params), callback);
  } catch (err) {
    sendError(req, res, err, callback);
  }
}

function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const absolutePath = path.resolve(rootDir, `.${requested}`);
  if (!absolutePath.startsWith(rootDir)) {
    send(req, res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  fs.readFile(absolutePath, (err, data) => {
    if (err) {
      send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    send(req, res, 200, data, {
      'Content-Type': mimeTypes[path.extname(absolutePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': requested.startsWith('/assets/') ? 'public, max-age=3600' : 'no-store'
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    send(req, res, 204, '');
    return;
  }
  if (url.pathname === '/api/health') {
    sendJson(req, res, { ok: true, service: 'creosote-plant-planner', time: new Date().toISOString() });
    return;
  }
  if (url.pathname === '/api/bridge') {
    await handleBridge(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(port, () => {
  ensureDataDir();
  console.log(`Creosote Plant Planner listening on ${port}`);
});

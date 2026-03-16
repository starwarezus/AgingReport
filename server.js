const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const SC_BASE = 'https://blny.api.sellercloud.com/rest/api';
const PAGE_SIZE = 50;
const BATCH = 20;
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'data');
const CACHE_TTL = 48 * 60 * 60 * 1000; // 48 hours

try {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log('Cache dir ready:', CACHE_DIR);
} catch(e) {
  console.error('Cache dir error:', e.message);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ──
function cachePath(companyId) { return path.join(CACHE_DIR, `cache_${companyId}.json`); }

function readCache(companyId) {
  try {
    const p = cachePath(companyId);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data;
  } catch(e) { return null; }
}

function writeCache(companyId, items, lastSync) {
  try {
    const p = cachePath(companyId);
    const data = JSON.stringify({ items, lastSync, savedAt: Date.now() });
    fs.writeFileSync(p, data);
    const kb = Math.round(data.length / 1024);
    console.log(`Cache saved: ${items.length} items (${kb}KB) for company ${companyId} at ${p}`);
  } catch(e) {
    console.error('Cache write error:', e.message, 'path:', cachePath(companyId));
  }
}

async function getToken(username, password) {
  const r = await fetch(`${SC_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: username, Password: password })
  });
  const d = await r.json();
  const token = d.access_token || d.token || d.Token;
  if (!token) throw new Error('Failed to get token');
  return token;
}

async function fetchInventoryPage(token, params) {
  const r = await fetch(`${SC_BASE}/inventory?${params}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return { status: r.status, data: r.status === 200 ? await r.json() : null };
}

function buildParams(page, companyId, extra = {}) {
  return new URLSearchParams({
    'model.pageNumber': page,
    'model.pageSize': PAGE_SIZE,
    'model.companyID': companyId,
    'model.kitType': 0,
    ...extra
  }).toString();
}

function isChildSku(id) { return id && /^i\d+$/i.test(id); }

// Fetch all pages for given params, returns array of items
async function fetchAllPages(token, companyId, username, password, extra = {}, onBatch = null) {
  const first = await fetchInventoryPage(token, buildParams(1, companyId, extra));
  if (first.status === 401) {
    token = await getToken(username, password);
    const retry = await fetchInventoryPage(token, buildParams(1, companyId, extra));
    first.status = retry.status;
    first.data = retry.data;
  }
  const total = first.data?.TotalResults || 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  let items = (first.data?.Items || []).filter(i => isChildSku(i.ID));
  if (onBatch) onBatch(items, 1, totalPages, total);

  for (let batchStart = 2; batchStart <= totalPages; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH - 1, totalPages);
    const pages = [];
    for (let p = batchStart; p <= batchEnd; p++) pages.push(p);
    let results = await Promise.all(pages.map(p => fetchInventoryPage(token, buildParams(p, companyId, extra))));
    const has401 = results.some(r => r.status === 401);
    if (has401) {
      token = await getToken(username, password);
      results = await Promise.all(pages.map(p => fetchInventoryPage(token, buildParams(p, companyId, extra))));
    }
    const batchItems = [];
    results.forEach(r => { (r.data?.Items || []).filter(i => isChildSku(i.ID)).forEach(i => batchItems.push(i)); });
    items = items.concat(batchItems);
    if (onBatch) onBatch(batchItems, batchEnd, totalPages, total);
    console.log(`Batch ${batchStart}-${batchEnd} done — ${items.length} items so far`);
  }
  return { items, token };
}

// ── TOKEN ──
app.post('/proxy/token', async (req, res) => {
  try {
    const r = await fetch(`${SC_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── COMPANIES ──
app.get('/proxy/cache-status', (req, res) => {
  const { companyId } = req.query;
  const cached = readCache(companyId);
  if (cached) {
    const ageMs = Date.now() - cached.savedAt;
    const ageHrs = (ageMs / 3600000).toFixed(1);
    const valid = ageMs < CACHE_TTL;
    res.json({ exists: true, valid, items: cached.items.length, savedAt: cached.savedAt, ageHrs });
  } else {
    res.json({ exists: false });
  }
});

app.get('/proxy/companies', async (req, res) => {
  try {
    const token = req.headers['authorization'];
    const r = await fetch(`${SC_BASE}/inventory?model.pageNumber=1&model.pageSize=500`, {
      headers: { 'Authorization': token, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    const items = data.Items || [];
    const seen = new Map();
    items.forEach(i => {
      if (i.CompanyID && i.CompanyName && !seen.has(i.CompanyID)) {
        seen.set(i.CompanyID, i.CompanyName);
      }
    });
    const companies = Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
    res.json({ companies, total: data.TotalResults || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STREAMING INVENTORY (full + delta) ──
app.get('/proxy/inventory-stream', async (req, res) => {
  const { companyId, username, password } = req.query;
  if (!companyId || !username || !password) {
    return res.status(400).json({ error: 'companyId, username and password required' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    const cached = readCache(companyId);
    const cacheAge = cached ? Date.now() - cached.savedAt : Infinity;
    const cacheValid = cached && cacheAge < CACHE_TTL;

    // ── SERVE CACHE IMMEDIATELY ──
    if (cacheValid && cached.items.length > 0) {
      console.log(`Serving cache for company ${companyId}: ${cached.items.length} items, age ${Math.round(cacheAge/3600000)}h`);
      send({ type: 'cached', items: cached.items, savedAt: cached.savedAt, lastSync: cached.lastSync });

      // ── DELTA SYNC IN BACKGROUND ──
      const lastSync = cached.lastSync;
      if (lastSync) {
        console.log(`Starting delta sync from ${new Date(lastSync).toISOString()}`);
        send({ type: 'delta-start' });
        let token = await getToken(username, password);

        // Format date for SellerCloud: mm/dd/yyyy hh:mm
        const d = new Date(lastSync);
        const fmt = `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;

        const { items: updatedItems } = await fetchAllPages(token, companyId, username, password,
          { 'model.lastUpdatedFrom': fmt },
          (batch, page, totalPages) => {
            send({ type: 'delta-progress', page, totalPages, count: batch.length });
          }
        );

        console.log(`Delta: ${updatedItems.length} changed items`);

        if (updatedItems.length > 0) {
          // Merge: replace existing + add new
          const map = new Map(cached.items.map(i => [i.ID, i]));
          updatedItems.forEach(i => {
            if ((i.PhysicalQty || 0) > 0) map.set(i.ID, i);
            else map.delete(i.ID); // sold out — remove
          });
          const merged = Array.from(map.values());
          writeCache(companyId, merged, Date.now());
          send({ type: 'delta-done', updatedCount: updatedItems.length, totalCount: merged.length, items: updatedItems });
        } else {
          writeCache(companyId, cached.items, Date.now()); // update lastSync timestamp
          send({ type: 'delta-done', updatedCount: 0, totalCount: cached.items.length });
        }
      }

      send({ type: 'done' });
      res.end();
      return;
    }

    // ── FULL FETCH (no cache or expired) ──
    console.log(`Full fetch for company ${companyId}`);
    let token = await getToken(username, password);
    let allItems = [];
    const syncStart = Date.now();

    const { items } = await fetchAllPages(token, companyId, username, password,
      { 'model.physicalQtyFrom': 1 },
      (batch, page, totalPages, total) => {
        allItems = allItems.concat(batch);
        if (page === 1) send({ type: 'meta', total, totalPages });
        if (batch.length) send({ type: 'items', items: batch });
        send({ type: 'progress', page, totalPages });
      }
    );

    writeCache(companyId, items, syncStart);
    send({ type: 'done' });
    res.end();

  } catch (e) {
    console.error('Stream error:', e.message);
    send({ type: 'error', error: e.message });
    res.end();
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

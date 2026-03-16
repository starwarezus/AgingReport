const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const SC_BASE = 'https://blny.api.sellercloud.com/rest/api';
const PAGE_SIZE = 50;
const BATCH = 20;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

async function fetchInventoryPage(token, companyId, page) {
  const params = new URLSearchParams({
    'model.pageNumber': page,
    'model.pageSize': PAGE_SIZE,
    'model.companyID': companyId,
    'model.physicalQtyFrom': 1,
    'model.kitType': 0
  });
  const r = await fetch(`${SC_BASE}/inventory?${params}`, {
    headers: { 'Authorization': token, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error(`SellerCloud returned ${r.status} on page ${page}`);
  return r.json();
}

// Streaming endpoint — sends newline-delimited JSON chunks so connection stays alive
app.get('/proxy/inventory-stream', async (req, res) => {
  const token = req.headers['authorization'];
  const companyId = req.query.companyId;
  if (!companyId) return res.status(400).json({ error: 'companyId required' });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    console.log(`Fetching page 1 for company ${companyId}`);
    const first = await fetchInventoryPage(token, companyId, 1);
    const total = first.TotalResults || 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    console.log(`Total: ${total} items, ${totalPages} pages`);

    send({ type: 'meta', total, totalPages });

    let firstItems = (first.Items || []).filter(i => i.ID && /^i\d+$/i.test(i.ID));
    if (firstItems.length) send({ type: 'items', items: firstItems });

    for (let batchStart = 2; batchStart <= totalPages; batchStart += BATCH) {
      const batchEnd = Math.min(batchStart + BATCH - 1, totalPages);
      const pages = [];
      for (let p = batchStart; p <= batchEnd; p++) pages.push(p);

      const results = await Promise.all(pages.map(p => fetchInventoryPage(token, companyId, p)));
      const batchItems = [];
      results.forEach(d => {
        (d.Items || []).filter(i => i.ID && /^i\d+$/i.test(i.ID)).forEach(i => batchItems.push(i));
      });

      if (batchItems.length) send({ type: 'items', items: batchItems });
      send({ type: 'progress', page: batchEnd, totalPages });
      console.log(`Batch ${batchStart}-${batchEnd} done`);
    }

    send({ type: 'done' });
    res.end();
  } catch (e) {
    console.error('Stream error:', e.message);
    send({ type: 'error', error: e.message });
    res.end();
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

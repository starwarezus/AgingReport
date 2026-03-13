const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const SC_BASE = 'https://blny.api.sellercloud.com/rest/api';

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

app.get('/proxy/inventory', async (req, res) => {
  try {
    const token = req.headers['authorization'];
    const qs = new URLSearchParams(req.query).toString();
    const r = await fetch(`${SC_BASE}/inventory?${qs}`, {
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json'
      }
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/proxy/companies', async (req, res) => {
  try {
    const token = req.headers['authorization'];
    const r = await fetch(`${SC_BASE}/inventory?pageNumber=1&pageSize=200`, {
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json'
      }
    });
    const data = await r.json();
    const items = data.Items || data.items || [];
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

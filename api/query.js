export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type = 'A', city, district } = req.query;
  if (!city) return res.status(400).json({ error: '缺少 city 參數' });

  const quarters = getRecentQuarters(4);
  const allRecords = [];

  try {
    for (const q of quarters) {
      const url = `https://plvr.land.moi.gov.tw/DownloadSeason?season=${q.rok}S${q.quarter}&type=${type}&fileName=${type}_lvr_land_${city}.csv`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      console.log('url:', url, 'status:', response.status);
      if (!response.ok) continue;
      const text = await response.text();
      console.log('text preview:', text.substring(0, 200));
      if (text.includes('<') ) continue;
      const records = parseCsv(text);
      const filtered = district ? records.filter(r => r['鄉鎮市區'] === district) : records;
      allRecords.push(...filtered);
    }

    return res.status(200).json({
      total: allRecords.length,
      stats: calcStats(allRecords),
      records: allRecords.filter(r => r['土地位置建物門牌'] && r['土地位置建物門牌'].length > 5).slice(0, 50),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function getRecentQuarters(n) {
  const now = new Date();
  let y = now.getFullYear() - 1911;
  let q = Math.ceil((now.getMonth() + 1) / 3) - 1;
  if (q < 1) { q = 4; y--; }
  const result = [];
  for (let i = 0; i < n; i++) {
    result.unshift({ rok: y, quarter: q });
    q--; if (q < 1) { q = 4; y--; }
  }
  return result;
}

function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 3) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const records = [];
  for (let i = 2; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < headers.length) continue;
    const rec = {};
    headers.forEach((h, idx) => { rec[h] = (cols[idx] || '').trim().replace(/"/g, ''); });
    if (rec['單價元平方公尺'] && rec['單價元平方公尺'] !== '0' && rec['交易標的'] && rec['交易標的'].includes('建物')) {
      rec['單價萬坪'] = Math.round(parseFloat(rec['單價元平方公尺']) * 3.3058 / 10000 * 10) / 10;
      rec['總價萬'] = Math.round(parseFloat(rec['總價元']) / 10000);
      rec['坪數'] = Math.round(parseFloat(rec['建物移轉總面積平方公尺']) * 0.3025 * 10) / 10;
      records.push(rec);
    }
  }
  return records;
}

function splitCsvLine(line) {
  const result = []; let cur = ''; let inQuote = false;
  for (const ch of line) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ',' && !inQuote) { result.push(cur); cur = ''; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

function calcStats(records) {
  if (!records.length) return null;
  const prices = records.map(r => r['單價萬坪']).filter(p => p > 0 && p < 500);
  const totals = records.map(r => r['總價萬']).filter(p => p > 0);
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : 0;
  const median = arr => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m-1]+s[m])/2*10)/10;
  };
  return { avgUnitPrice: avg(prices), medianUnitPrice: median(prices), minUnitPrice: Math.min(...prices), maxUnitPrice: Math.max(...prices), avgTotal: avg(totals) };
}

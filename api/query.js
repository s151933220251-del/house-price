import { promisify } from 'util';
import { inflate } from 'zlib';

const inflateAsync = promisify(inflate);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type = 'A', city, district } = req.query;
  if (!city) return res.status(400).json({ error: '缺少 city 參數' });

  try {
    const now = new Date();
    const rok = now.getFullYear() - 1911;
    const q = Math.ceil((now.getMonth() + 1) / 3);
    const zipUrl = `https://plvr.land.moi.gov.tw/DownloadSeason?season=${rok}S${q}&type=zip&fileName=lvr_landcsv.zip`;
    const response = await fetch(zipUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return res.status(500).json({ error: '下載失敗' });

    const buffer = Buffer.from(await response.arrayBuffer());
    const csvText = await extractFromZip(buffer, type, city);
    if (!csvText) return res.status(404).json({ error: '找不到該縣市資料' });

    const records = parseCsv(csvText);
    const filtered = district ? records.filter(r => r['鄉鎮市區'] === district) : records;

    return res.status(200).json({
      total: filtered.length,
      stats: calcStats(filtered),
      records: filtered.filter(r => r['土地位置建物門牌'] && r['土地位置建物門牌'].length > 5).slice(0, 50),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function extractFromZip(buffer, type, city) {
  const target = `${city.toLowerCase()}_lvr_land_${type.toLowerCase()}.csv`;
  let i = 0;
  while (i < buffer.length - 4) {
    if (buffer[i] === 0x50 && buffer[i+1] === 0x4B && buffer[i+2] === 0x03 && buffer[i+3] === 0x04) {
      const compression = buffer.readUInt16LE(i + 8);
      const compSize = buffer.readUInt32LE(i + 18);
      const uncompSize = buffer.readUInt32LE(i + 22);
      const nameLen = buffer.readUInt16LE(i + 26);
      const extraLen = buffer.readUInt16LE(i + 28);
      const fileName = buffer.slice(i + 30, i + 30 + nameLen).toString('utf8').toLowerCase();
      const dataStart = i + 30 + nameLen + extraLen;

      if (fileName === target) {
        const compData = buffer.slice(dataStart, dataStart + compSize);
        if (compression === 0) {
          return compData.toString('latin1');
        } else if (compression === 8) {
          const decompressed = await inflateAsync(compData);
          return decompressed.toString('latin1');
        }
      }
      i = dataStart + compSize;
    } else {
      i++;
    }
  }
  return null;
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

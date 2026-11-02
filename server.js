// server.js - Marina Tekne ve Mürettebat Rehberi (Zero-dependency Node.js Server)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const DB_PATH = path.join(DATA_DIR, 'rehber.db');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Initialize SQLite Database
const db = new DatabaseSync(DB_PATH);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS boats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    captain_title TEXT DEFAULT 'KAPTAN',
    captain_name TEXT,
    captain_surname TEXT,
    notes TEXT,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS crew_members (
    id TEXT PRIMARY KEY,
    boat_id TEXT NOT NULL,
    name TEXT NOT NULL,
    surname TEXT NOT NULL,
    role TEXT NOT NULL,
    phone TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY(boat_id) REFERENCES boats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// MIME types helper
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

// Helper to parse JSON body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) { // 50MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Gemini Vision API parser function with model fallback
async function analyzeImageWithGemini(base64Data, mimeType = 'image/jpeg', apiKey) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('Gemini API anahtarı ayarlanmamış.');
  }

  const prompt = `Sen denizcilik ve marina belgeleri konusunda uzman bir asistansın.
Ekli görsel Setur Marinas veya benzeri bir "Mürettebat Bilgi Formu" el yazısı belgesidir.
Görseldeki el yazısını dikkatlice oku ve JSON formatında döndür.

Önemli Not: Bazen formdaki "Soyisim" alanına parantez içinde görev (örn: Temiz (Kaptan), Esen (Gemici)), "Görev" alanına ise telefon numarası yazılmış olabilir.
Bunu akıllıca tespit et:
- Telefon numarasını mutlaka "phone" alanına koy.
- Görevi (Kaptan, Gemici, Aşçı, vb.) "role" alanına koy.
- Soyismini parantez içindeki görevden arındırarak "surname" alanına koy.

Yalnızca şu JSON formatında cevap ver, Markdown kod bloğu veya başka bir metin ekleme:
{
  "boat_name": "Tekne Adı",
  "captain_title": "Ünvan (örn: KAPTAN)",
  "captain_name": "Sorumlu İsim",
  "captain_surname": "Sorumlu Soyisim",
  "notes": "Varsa notlar",
  "crew": [
    {
      "name": "İsim",
      "surname": "Soyisim",
      "role": "Görev (Kaptan, Gemici, Aşçı, vb.)",
      "phone": "05XX XXX XX XX"
    }
  ]
}`;

  const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: mimeType,
              data: cleanBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  // Model priority list
  const models = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
  let lastError = null;

  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        lastError = new Error(`Gemini (${model}) Hatası HTTP ${response.status}: ${errText}`);
        continue;
      }

      const result = await response.json();
      const textOutput = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!textOutput) {
        lastError = new Error('Yapay zekadan yanıt metni alınamadı.');
        continue;
      }

      try {
        return JSON.parse(textOutput);
      } catch (e) {
        const cleaned = textOutput.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
      }
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('Gemini API isteği başarısız oldu.');
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-gemini-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    // API: GET /api/boats
    if (req.method === 'GET' && pathname === '/api/boats') {
      const boats = db.prepare('SELECT * FROM boats ORDER BY created_at DESC').all();
      const crewStmt = db.prepare('SELECT * FROM crew_members WHERE boat_id = ? ORDER BY sort_order ASC');

      const result = boats.map(b => ({
        ...b,
        crew: crewStmt.all(b.id)
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: GET /api/contacts
    if (req.method === 'GET' && pathname === '/api/contacts') {
      const contacts = db.prepare(`
        SELECT c.*, b.name as boat_name, b.image_url as boat_image_url
        FROM crew_members c
        JOIN boats b ON c.boat_id = b.id
        ORDER BY c.name ASC, c.surname ASC
      `).all();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(contacts));
      return;
    }

    // API: POST /api/boats
    if (req.method === 'POST' && pathname === '/api/boats') {
      const body = await parseJsonBody(req);
      const boatId = crypto.randomUUID();

      db.prepare(`
        INSERT INTO boats (id, name, captain_title, captain_name, captain_surname, notes, image_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        boatId,
        body.name || 'İsimsiz Tekne',
        body.captain_title || 'KAPTAN',
        body.captain_name || '',
        body.captain_surname || '',
        body.notes || '',
        body.image_url || ''
      );

      if (Array.isArray(body.crew)) {
        const insertCrew = db.prepare(`
          INSERT INTO crew_members (id, boat_id, name, surname, role, phone, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        body.crew.forEach((c, idx) => {
          insertCrew.run(
            crypto.randomUUID(),
            boatId,
            c.name || '',
            c.surname || '',
            c.role || '',
            c.phone || '',
            idx + 1
          );
        });
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: boatId }));
      return;
    }

    // API: DELETE /api/boats/:id
    if (req.method === 'DELETE' && pathname.startsWith('/api/boats/')) {
      const boatId = pathname.replace('/api/boats/', '');
      const boat = db.prepare('SELECT * FROM boats WHERE id = ?').get(boatId);
      
      if (boat) {
        db.prepare('DELETE FROM crew_members WHERE boat_id = ?').run(boatId);
        db.prepare('DELETE FROM boats WHERE id = ?').run(boatId);
        
        if (boat.image_url && boat.image_url.startsWith('/uploads/')) {
          const imgFile = path.join(__dirname, 'public', boat.image_url);
          if (fs.existsSync(imgFile) && !boat.image_url.includes('ya79_form.jpg')) {
            try { fs.unlinkSync(imgFile); } catch (e) {}
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // API: POST /api/upload-and-analyze
    if (req.method === 'POST' && pathname === '/api/upload-and-analyze') {
      const body = await parseJsonBody(req);
      if (!body.image) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Görsel verisi bulunamadı.' }));
        return;
      }

      // Save base64 image to uploads/
      const match = body.image.match(/^data:image\/([a-zA-Z]+);base64,/);
      const ext = match ? (match[1] === 'jpeg' ? 'jpg' : match[1]) : 'jpg';
      const filename = `form_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, filename);
      const cleanBase64 = body.image.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

      fs.writeFileSync(filePath, Buffer.from(cleanBase64, 'base64'));
      const imageUrl = `/uploads/${filename}`;

      // Check API key
      const settingRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('gemini_api_key');
      const apiKey = body.apiKey || req.headers['x-gemini-api-key'] || settingRow?.value || process.env.GEMINI_API_KEY;

      if (!apiKey || apiKey.trim() === '') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          imageUrl,
          requiresApiKey: true,
          message: 'Fotoğraf kaydedildi ancak yapay zekânın el yazısını okuması için Google Gemini API anahtarı tanımlanmalıdır.'
        }));
        return;
      }

      try {
        const analyzedData = await analyzeImageWithGemini(cleanBase64, `image/${ext === 'jpg' ? 'jpeg' : ext}`, apiKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          imageUrl,
          data: analyzedData
        }));
      } catch (aiErr) {
        console.error('Gemini analiz hatası:', aiErr);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          imageUrl,
          aiError: aiErr.message,
          message: `Yapay zekâ analizinde hata oluştu: ${aiErr.message}`
        }));
      }
      return;
    }

    // API: POST /api/analyze-existing
    // Allows analyzing an already uploaded image with a freshly entered API key
    if (req.method === 'POST' && pathname === '/api/analyze-existing') {
      const body = await parseJsonBody(req);
      if (!body.imageUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Görsel URL bulunamadı.' }));
        return;
      }

      const filePath = path.join(__dirname, 'public', body.imageUrl);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dosya bulunamadı.' }));
        return;
      }

      const fileBuffer = fs.readFileSync(filePath);
      const cleanBase64 = fileBuffer.toString('base64');
      const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'jpeg';

      const settingRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('gemini_api_key');
      const apiKey = body.apiKey || settingRow?.value || process.env.GEMINI_API_KEY;

      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API anahtarı bulunamadı.' }));
        return;
      }

      try {
        const analyzedData = await analyzeImageWithGemini(cleanBase64, `image/${ext === 'jpg' ? 'jpeg' : ext}`, apiKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          imageUrl: body.imageUrl,
          data: analyzedData
        }));
      } catch (aiErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: aiErr.message }));
      }
      return;
    }

    // API: GET /api/settings / POST /api/settings
    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        const keyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('gemini_api_key');
        const activeKey = keyRow?.value || process.env.GEMINI_API_KEY || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hasGeminiApiKey: activeKey.length > 5,
          maskedKey: activeKey.length > 5 ? `${activeKey.substring(0, 6)}...${activeKey.slice(-4)}` : null
        }));
        return;
      }
      if (req.method === 'POST') {
        const body = await parseJsonBody(req);
        if (body.gemini_api_key !== undefined) {
          const val = body.gemini_api_key.trim();
          db.prepare(`
            INSERT INTO settings (key, value) VALUES ('gemini_api_key', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(val);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
    }

    // API: GET /api/export-vcard/:id
    if (req.method === 'GET' && pathname.startsWith('/api/export-vcard/')) {
      const boatId = pathname.replace('/api/export-vcard/', '');
      const boat = db.prepare('SELECT * FROM boats WHERE id = ?').get(boatId);
      if (!boat) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Tekne bulunamadı');
        return;
      }

      const crew = db.prepare('SELECT * FROM crew_members WHERE boat_id = ?').all(boatId);
      let vcardContent = '';
      
      for (const m of crew) {
        vcardContent += 'BEGIN:VCARD\r\n';
        vcardContent += 'VERSION:3.0\r\n';
        vcardContent += `FN:${m.name} ${m.surname} (${boat.name} - ${m.role})\r\n`;
        vcardContent += `N:${m.surname};${m.name};;;\r\n`;
        vcardContent += `ORG:${boat.name}\r\n`;
        vcardContent += `TITLE:${m.role}\r\n`;
        vcardContent += `TEL;TYPE=CELL:${m.phone}\r\n`;
        vcardContent += `NOTE:Tekne: ${boat.name} | Görev: ${m.role}\r\n`;
        vcardContent += 'END:VCARD\r\n';
      }

      res.writeHead(200, {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(boat.name)}_Rehber.vcf"`
      });
      res.end(vcardContent);
      return;
    }

    // API: GET /api/export-csv
    if (req.method === 'GET' && pathname === '/api/export-csv') {
      const rows = db.prepare(`
        SELECT b.name as tekne_adi, b.captain_name || ' ' || b.captain_surname as kaptan,
               c.name as personel_isim, c.surname as personel_soyisim, c.role as gorev, c.phone as telefon
        FROM boats b
        LEFT JOIN crew_members c ON b.id = c.boat_id
        ORDER BY b.name ASC, c.sort_order ASC
      `).all();

      let csv = '\uFEFFTekne Adı;Sorumlu Kaptan;Personel İsim;Personel Soyisim;Görev;Telefon\r\n';
      for (const r of rows) {
        csv += `"${r.tekne_adi || ''}";"${r.kaptan || ''}";"${r.personel_isim || ''}";"${r.personel_soyisim || ''}";"${r.gorev || ''}";"${r.telefon || ''}"\r\n`;
      }

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Marina_Tekne_Rehberi.csv"'
      });
      res.end(csv);
      return;
    }

    // Static file serving
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\') safePath = '/index.html';

    const fullPath = path.join(__dirname, 'public', safePath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err) {
    console.error('Server hatası:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚓ Marina Servisi Yeniden Başlatıldı (Port: ${PORT})`);
});

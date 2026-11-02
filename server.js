// server.js - Marina Tekne ve Mürettebat Rehberi (100% Taşınabilir & Bağımsız Node.js Sunucusu)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const DB_FILE = path.join(DATA_DIR, 'rehber.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Initial seed data if rehber.json does not exist
const initialData = {
  boats: [
    {
      id: 'boat-ya79',
      name: 'Ya 79',
      captain_title: 'KAPTAN',
      captain_name: 'Bekir',
      captain_surname: 'Temiz',
      notes: 'Setur Marinas Mürettebat Bilgi Formu',
      image_url: '/uploads/ya79_form.jpg',
      created_at: new Date().toISOString(),
      crew: [
        { id: 'c1', name: 'Bekir', surname: 'Temiz', role: 'Kaptan', phone: '0532 553 51 11' },
        { id: 'c2', name: 'Ceyhun', surname: 'Esen', role: 'Gemici', phone: '0553 494 04 44' },
        { id: 'c3', name: 'Yusuf', surname: 'Şahin', role: 'Gemici', phone: '0533 321 58 83' },
        { id: 'c4', name: 'Batuhan', surname: 'Demirhan', role: 'Gemici', phone: '0507 707 83 97' },
        { id: 'c5', name: 'Mehmet', surname: 'Erevciler', role: 'Aşçı', phone: '0531 524 56 94' }
      ]
    },
    {
      id: 'boat-turmepa',
      name: 'DTO TURMEPA (Atık Teknesi)',
      captain_title: 'KAPTAN',
      captain_name: 'Aytaç',
      captain_surname: 'Akboyun',
      notes: 'Setur Marinas Formu',
      image_url: '/uploads/form_1793614609974_7ff6bd63.jpg',
      created_at: new Date().toISOString(),
      crew: [
        { id: 'c6', name: 'İbrahim Aytaç', surname: 'Akboyun', role: 'Kaptan', phone: '0543 395 50 73' }
      ]
    }
  ],
  settings: {
    gemini_api_key: process.env.GEMINI_API_KEY || ''
  }
};

// Database helper functions (JSON based, 100% portable on all Node versions)
function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
    return initialData;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Veritabanı okuma hatası, yedek yükleniyor:', err);
    return initialData;
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Initialize DB file
readDb();

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
      if (body.length > 50 * 1024 * 1024) {
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

// Gemini Vision API parser with model fallback
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
    const db = readDb();

    // API: GET /api/boats
    if (req.method === 'GET' && pathname === '/api/boats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(db.boats || []));
      return;
    }

    // API: GET /api/contacts
    if (req.method === 'GET' && pathname === '/api/contacts') {
      const contacts = [];
      (db.boats || []).forEach(b => {
        (b.crew || []).forEach(c => {
          contacts.push({
            ...c,
            boat_id: b.id,
            boat_name: b.name,
            boat_image_url: b.image_url
          });
        });
      });
      contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(contacts));
      return;
    }

    // API: POST /api/boats
    if (req.method === 'POST' && pathname === '/api/boats') {
      const body = await parseJsonBody(req);
      const boatId = crypto.randomUUID();

      const newBoat = {
        id: boatId,
        name: body.name || 'İsimsiz Tekne',
        captain_title: body.captain_title || 'KAPTAN',
        captain_name: body.captain_name || '',
        captain_surname: body.captain_surname || '',
        notes: body.notes || '',
        image_url: body.image_url || '',
        created_at: new Date().toISOString(),
        crew: (body.crew || []).map((c, idx) => ({
          id: crypto.randomUUID(),
          name: c.name || '',
          surname: c.surname || '',
          role: c.role || '',
          phone: c.phone || '',
          sort_order: idx + 1
        }))
      };

      db.boats.unshift(newBoat);
      writeDb(db);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: boatId }));
      return;
    }

    // API: DELETE /api/boats/:id
    if (req.method === 'DELETE' && pathname.startsWith('/api/boats/')) {
      const boatId = pathname.replace('/api/boats/', '');
      const boatIndex = db.boats.findIndex(b => b.id === boatId);
      
      if (boatIndex !== -1) {
        const boat = db.boats[boatIndex];
        if (boat.image_url && boat.image_url.startsWith('/uploads/')) {
          const imgFile = path.join(__dirname, 'public', boat.image_url);
          if (fs.existsSync(imgFile) && !boat.image_url.includes('ya79_form.jpg') && !boat.image_url.includes('7ff6bd63')) {
            try { fs.unlinkSync(imgFile); } catch (e) {}
          }
        }
        db.boats.splice(boatIndex, 1);
        writeDb(db);
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

      const match = body.image.match(/^data:image\/([a-zA-Z]+);base64,/);
      const ext = match ? (match[1] === 'jpeg' ? 'jpg' : match[1]) : 'jpg';
      const filename = `form_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, filename);
      const cleanBase64 = body.image.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

      fs.writeFileSync(filePath, Buffer.from(cleanBase64, 'base64'));
      const imageUrl = `/uploads/${filename}`;

      const apiKey = body.apiKey || req.headers['x-gemini-api-key'] || db.settings?.gemini_api_key || process.env.GEMINI_API_KEY;

      if (!apiKey || apiKey.trim() === '') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          imageUrl,
          requiresApiKey: true,
          message: 'Fotoğraf kaydedildi ancak otomatik okuma için API anahtarı girilmelidir.'
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
          message: `Yapay zekâ hatası: ${aiErr.message}`
        }));
      }
      return;
    }

    // API: POST /api/analyze-existing
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

      const apiKey = body.apiKey || db.settings?.gemini_api_key || process.env.GEMINI_API_KEY;

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
        const activeKey = db.settings?.gemini_api_key || process.env.GEMINI_API_KEY || '';
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
          db.settings = db.settings || {};
          db.settings.gemini_api_key = body.gemini_api_key.trim();
          writeDb(db);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
    }

    // API: GET /api/export-vcard/:id
    if (req.method === 'GET' && pathname.startsWith('/api/export-vcard/')) {
      const boatId = pathname.replace('/api/export-vcard/', '');
      const boat = db.boats.find(b => b.id === boatId);
      if (!boat) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Tekne bulunamadı');
        return;
      }

      let vcardContent = '';
      for (const m of (boat.crew || [])) {
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
      let csv = '\uFEFFTekne Adı;Sorumlu Kaptan;Personel İsim;Personel Soyisim;Görev;Telefon\r\n';
      (db.boats || []).forEach(b => {
        const kaptan = `${b.captain_name || ''} ${b.captain_surname || ''}`.trim();
        (b.crew || []).forEach(c => {
          csv += `"${b.name || ''}";"${kaptan}";"${c.name || ''}";"${c.surname || ''}";"${c.role || ''}";"${c.phone || ''}"\r\n`;
        });
      });

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
  console.log(`⚓ Marina Tekne & Mürettebat Rehberi Servisi Başlatıldı!`);
  console.log(`Port: ${PORT}`);
});

// server.js - Marina Tekne ve Mürettebat Rehberi (Kalıcı Bulut Veritabanı & Otomatik Yedekleme)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const DB_FILE = path.join(DATA_DIR, 'rehber.json');

// Supabase Configuration (Permanent Cloud Storage for Images, DB & Backups)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cxepumcfugqnxixznvir.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_80esJnSeEstFkWVztcCgdg_VGXC5yO0';
const SUPABASE_BUCKET = 'marina-croquis';

// GitHub Sync Configuration (Branch: data-storage)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'PierreC48/marina-tekne-rehberi';
const GITHUB_BRANCH = 'data-storage';
const GITHUB_FILE = 'database.json';

// Ensure local directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ==========================================
// NORMALIZATION & DEDUPLICATION ENGINE
// ==========================================
function toTitleCaseTr(str) {
  if (!str) return '';
  return String(str)
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => {
      if (!w) return '';
      const upper = w.toLocaleUpperCase('tr-TR');
      if (['M/Y', 'S/Y', 'DTO', 'TURMEPA', 'TC', 'T.C.', 'II', 'III', 'IV'].includes(upper)) {
        return upper;
      }
      return w.charAt(0).toLocaleUpperCase('tr-TR') + w.slice(1).toLocaleLowerCase('tr-TR');
    })
    .join(' ');
}

function normalizeBoatName(name) {
  if (!name) return 'İsimsiz Tekne';
  const cleaned = String(name).trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'İsimsiz Tekne';
  return toTitleCaseTr(cleaned);
}

function getBoatComparisonKey(name) {
  if (!name) return '';
  return String(name)
    .toLocaleLowerCase('tr-TR')
    .replace(/^(m\/y|s\/y|teknesi|tekne|yat|boat)\s+/g, '')
    .replace(/[^a-z0-9ğüşıöç]/g, '');
}

function normalizePersonName(name) {
  if (!name) return '';
  return toTitleCaseTr(String(name));
}

function normalizeRole(role) {
  if (!role) return 'Gemici';
  const raw = String(role).trim();
  if (!raw) return 'Gemici';
  const lower = raw.toLocaleLowerCase('tr-TR');
  if (lower.includes('kaptan') || lower === 'kpt' || lower === 'kpt.' || lower.includes('captain') || lower.includes('reis')) {
    return 'Kaptan';
  }
  if (lower.includes('gemici') || lower.includes('gemıcı') || lower.includes('deckhand') || lower.includes('denizci')) {
    return 'Gemici';
  }
  if (lower.includes('aşçı') || lower.includes('asci') || lower.includes('ascı') || lower.includes('ahçı') || lower.includes('ahci') || lower.includes('chef') || lower.includes('cook')) {
    return 'Aşçı';
  }
  if (lower.includes('çarkçı') || lower.includes('carkci') || lower.includes('makin') || lower.includes('engineer')) {
    return 'Çarkçı';
  }
  if (lower.includes('kamarot') || lower.includes('hostes') || lower.includes('steward') || lower.includes('servis')) {
    return 'Kamarot / Hostes';
  }
  return toTitleCaseTr(raw);
}

function getPhoneDigitsKey(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0090') && digits.length === 14) {
    digits = digits.slice(4);
  } else if (digits.startsWith('90') && digits.length === 12) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.slice(1);
  }
  return digits;
}

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = getPhoneDigitsKey(phone);
  if (digits.length === 10) {
    return `0${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8, 10)}`;
  }
  return String(phone).trim().replace(/\s+/g, ' ');
}

function normalizeFormDate(dateStr, fallbackIso) {
  const defaultDate = (fallbackIso || new Date().toISOString()).slice(0, 10);
  if (!dateStr) return defaultDate;
  const s = String(dateStr).trim();
  const isoMatch = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const trMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (trMatch) {
    const [, d, m, y] = trMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return defaultDate;
}

function deduplicateCrewList(crewArray) {
  const mergedMap = new Map();
  for (const rawMember of (crewArray || [])) {
    if (!rawMember) continue;
    let name = normalizePersonName(rawMember.name || '');
    let surname = normalizePersonName(rawMember.surname || '');
    let role = normalizeRole(rawMember.role || 'Gemici');
    let phone = normalizePhone(rawMember.phone || '');

    // Skip completely empty rows
    if (!name && !surname && (!phone || phone === '05')) continue;

    const phoneKey = getPhoneDigitsKey(phone);
    const nameKey = `${name} ${surname}`.toLocaleLowerCase('tr-TR').trim();
    const dedupKey = (phoneKey && phoneKey.length >= 7) ? `tel:${phoneKey}` : `name:${nameKey}`;

    if (!mergedMap.has(dedupKey)) {
      mergedMap.set(dedupKey, {
        id: rawMember.id || crypto.randomUUID(),
        name,
        surname,
        role,
        phone
      });
    } else {
      const existing = mergedMap.get(dedupKey);
      if (!existing.name && name) existing.name = name;
      if (!existing.surname && surname) existing.surname = surname;
      if ((!existing.phone || existing.phone.length < 7) && phone) existing.phone = phone;
      if (role === 'Kaptan' || (!existing.role && role)) existing.role = role;
    }
  }

  const list = Array.from(mergedMap.values());
  // Put Kaptan first
  list.sort((a, b) => {
    if (a.role === 'Kaptan' && b.role !== 'Kaptan') return -1;
    if (a.role !== 'Kaptan' && b.role === 'Kaptan') return 1;
    return 0;
  });
  return list.map((c, idx) => ({ ...c, sort_order: idx + 1 }));
}

function normalizeSingleBoat(b) {
  const nowIso = new Date().toISOString();
  const createdAt = b.created_at || nowIso;
  const updatedAt = b.updated_at || createdAt;
  const formDate = normalizeFormDate(b.form_date, createdAt);
  const crew = deduplicateCrewList(b.crew || []);

  let captainName = normalizePersonName(b.captain_name || '');
  let captainSurname = normalizePersonName(b.captain_surname || '');

  // If captain is empty, infer from crew member with role 'Kaptan'
  if (!captainName && !captainSurname) {
    const cap = crew.find(c => c.role === 'Kaptan');
    if (cap) {
      captainName = cap.name;
      captainSurname = cap.surname;
    }
  }

  return {
    id: b.id || crypto.randomUUID(),
    name: normalizeBoatName(b.name),
    captain_title: 'KAPTAN',
    captain_name: captainName,
    captain_surname: captainSurname,
    notes: String(b.notes || '').trim(),
    image_url: String(b.image_url || '').trim(),
    form_date: formDate,
    created_at: createdAt,
    updated_at: updatedAt,
    crew
  };
}

function deduplicateAndNormalizeBoats(boatsArray) {
  if (!Array.isArray(boatsArray)) return [];
  const boatMap = new Map();

  for (const rawBoat of boatsArray) {
    if (!rawBoat) continue;
    const norm = normalizeSingleBoat(rawBoat);
    const key = getBoatComparisonKey(norm.name);
    if (!key) continue;

    if (!boatMap.has(key)) {
      boatMap.set(key, norm);
    } else {
      const existing = boatMap.get(key);
      const existingTime = new Date(existing.updated_at || existing.created_at || 0).getTime();
      const normTime = new Date(norm.updated_at || norm.created_at || 0).getTime();
      const newer = normTime >= existingTime ? norm : existing;
      const older = normTime >= existingTime ? existing : norm;

      const mergedCrew = deduplicateCrewList([...(newer.crew || []), ...(older.crew || [])]);
      boatMap.set(key, {
        ...older,
        ...newer,
        id: existing.id,
        name: newer.name || older.name,
        captain_name: newer.captain_name || older.captain_name,
        captain_surname: newer.captain_surname || older.captain_surname,
        image_url: newer.image_url || older.image_url,
        notes: newer.notes || older.notes,
        form_date: newer.form_date >= older.form_date ? newer.form_date : older.form_date,
        created_at: older.created_at || newer.created_at,
        updated_at: newer.updated_at || older.updated_at,
        crew: mergedCrew
      });
    }
  }

  return Array.from(boatMap.values());
}

// Initial seed data
const initialData = {
  boats: deduplicateAndNormalizeBoats([
    {
      id: 'boat-ya79',
      name: 'Ya 79',
      captain_title: 'KAPTAN',
      captain_name: 'Bekir',
      captain_surname: 'Temiz',
      notes: 'Setur Marinas Mürettebat Bilgi Formu',
      image_url: 'https://cxepumcfugqnxixznvir.supabase.co/storage/v1/object/public/marina-croquis/ya79_form.jpg',
      form_date: '2026-11-01',
      created_at: '2026-11-01T10:00:00.000Z',
      updated_at: '2026-11-01T10:00:00.000Z',
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
      image_url: 'https://cxepumcfugqnxixznvir.supabase.co/storage/v1/object/public/marina-croquis/turmepa_form.jpg',
      form_date: '2026-11-01',
      created_at: '2026-11-01T10:00:00.000Z',
      updated_at: '2026-11-01T10:00:00.000Z',
      crew: [
        { id: 'c6', name: 'İbrahim Aytaç', surname: 'Akboyun', role: 'Kaptan', phone: '0543 395 50 73' }
      ]
    }
  ]),
  last_backup_at: new Date().toISOString()
};

let inMemoryDb = null;

// Read local cache
function readLocalDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
    return JSON.parse(JSON.stringify(initialData));
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      boats: deduplicateAndNormalizeBoats(parsed.boats || initialData.boats),
      last_backup_at: parsed.last_backup_at || new Date().toISOString()
    };
  } catch (err) {
    return JSON.parse(JSON.stringify(initialData));
  }
}

// Fetch permanent database from Supabase Storage & GitHub
async function fetchCloudDb() {
  const collectedBoats = [];

  // 1. Try Supabase Storage permanent DB
  try {
    const sbUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/db/database.json?t=${Date.now()}`;
    const res = await fetch(sbUrl);
    if (res.ok) {
      const parsed = await res.json();
      if (parsed && Array.isArray(parsed.boats)) {
        console.log(`☁️ Supabase Bulut Veritabanından ${parsed.boats.length} tekne kaydı yüklendi.`);
        collectedBoats.push(...parsed.boats);
      }
    }
  } catch (err) {
    console.warn('Supabase DB okuma uyarısı:', err.message);
  }

  // 2. Try GitHub data-storage branch
  if (GITHUB_TOKEN) {
    try {
      const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'Marina-App'
        }
      });
      if (res.ok) {
        const data = await res.json();
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const parsed = JSON.parse(content);
        if (parsed && Array.isArray(parsed.boats)) {
          console.log(`☁️ GitHub Bulut Veritabanından ${parsed.boats.length} tekne kaydı yüklendi.`);
          collectedBoats.push(...parsed.boats);
        }
      }
    } catch (err) {
      console.error('GitHub veritabanı okuma hatası:', err.message);
    }
  }

  if (collectedBoats.length > 0) {
    return { boats: deduplicateAndNormalizeBoats(collectedBoats) };
  }
  return null;
}

// Upload JSON file to Supabase Storage (with upsert)
async function uploadJsonToSupabase(objectPath, dataObj) {
  try {
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`;
    const jsonBuffer = Buffer.from(JSON.stringify(dataObj, null, 2), 'utf-8');
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'x-upsert': 'true',
        'cache-control': 'no-cache'
      },
      body: jsonBuffer
    });
    return res.ok;
  } catch (err) {
    console.error('Supabase JSON yedekleme hatası:', err.message);
    return false;
  }
}

// Sync in-memory DB to Supabase Storage, Local Backups, and GitHub
let isSyncing = false;
async function syncToCloud(createDailyBackup = true) {
  if (isSyncing || !inMemoryDb) return;
  isSyncing = true;
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    inMemoryDb.last_backup_at = new Date().toISOString();

    // 1. Local timestamped daily backup
    if (createDailyBackup) {
      try {
        const localBackupPath = path.join(BACKUPS_DIR, `backup_${todayStr}.json`);
        fs.writeFileSync(localBackupPath, JSON.stringify(inMemoryDb, null, 2), 'utf-8');
      } catch (e) {}
    }

    // 2. Supabase Storage Permanent DB + Daily Backup
    await uploadJsonToSupabase('db/database.json', inMemoryDb);
    if (createDailyBackup) {
      await uploadJsonToSupabase(`db/backups/backup_${todayStr}.json`, inMemoryDb);
    }

    // 3. GitHub data-storage branch sync (if GITHUB_TOKEN configured)
    if (GITHUB_TOKEN) {
      const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
      let sha = null;
      const getRes = await fetch(`${url}?ref=${GITHUB_BRANCH}`, {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'Marina-App'
        }
      });
      if (getRes.ok) {
        const d = await getRes.json();
        sha = d.sha;
      }

      const payload = {
        message: `Otomatik Veritabanı Yedeği (${todayStr})`,
        branch: GITHUB_BRANCH,
        content: Buffer.from(JSON.stringify(inMemoryDb, null, 2)).toString('base64'),
        sha: sha || undefined
      };

      await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'Marina-App',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    }
    console.log(`✓ Kalıcı veritabanı ve günlük yedek (${todayStr}) buluta kaydedildi.`);
  } catch (err) {
    console.error('Bulut senkronizasyon hatası:', err.message);
  } finally {
    isSyncing = false;
  }
}

// Save locally, normalize/deduplicate, and trigger cloud sync + backup
function saveDb() {
  if (!inMemoryDb) return;
  if (inMemoryDb.settings) delete inMemoryDb.settings;
  inMemoryDb.boats = deduplicateAndNormalizeBoats(inMemoryDb.boats || []);
  inMemoryDb.last_backup_at = new Date().toISOString();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(inMemoryDb, null, 2), 'utf-8');
  } catch (e) {}
  syncToCloud(true);
}

// Scheduled automatic backup every 6 hours
setInterval(() => {
  if (inMemoryDb) {
    syncToCloud(true);
  }
}, 6 * 60 * 60 * 1000).unref();

// Initialize database, merge cloud + local, normalize & deduplicate
(async () => {
  inMemoryDb = readLocalDb();
  const cloudData = await fetchCloudDb();
  if (cloudData && Array.isArray(cloudData.boats)) {
    inMemoryDb.boats = deduplicateAndNormalizeBoats([
      ...cloudData.boats,
      ...(inMemoryDb.boats || [])
    ]);
  } else {
    inMemoryDb.boats = deduplicateAndNormalizeBoats(inMemoryDb.boats || []);
  }
  saveDb();
})();

// ==========================================
// SECURITY: RATE LIMITER & FILE VALIDATION
// ==========================================
const rateLimitStore = new Map();

// Clean up expired rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    const validTimestamps = entry.timestamps.filter(t => now - t < entry.windowMs);
    if (validTimestamps.length === 0) {
      rateLimitStore.delete(key);
    } else {
      entry.timestamps = validTimestamps;
    }
  }
}, 5 * 60 * 1000).unref();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(req, res, bucket, maxRequests, windowMs) {
  const ip = getClientIp(req);
  const key = `${bucket}:${ip}`;
  const now = Date.now();

  let record = rateLimitStore.get(key);
  if (!record) {
    record = { timestamps: [], windowMs };
    rateLimitStore.set(key, record);
  }

  record.timestamps = record.timestamps.filter(t => now - t < windowMs);

  const remaining = Math.max(0, maxRequests - record.timestamps.length);
  res.setHeader('X-RateLimit-Limit', String(maxRequests));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining - 1)));

  if (record.timestamps.length >= maxRequests) {
    const oldest = record.timestamps[0];
    const retryAfterSec = Math.ceil((windowMs - (now - oldest)) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    res.writeHead(429, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({
      error: `Çok fazla istek gönderdiniz (Rate Limit). Lütfen ${retryAfterSec} saniye bekleyip tekrar deneyin.`
    }));
    return false;
  }

  record.timestamps.push(now);
  return true;
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB max decoded image size
const MIN_IMAGE_BYTES = 512; // 512 B min decoded image size

function validateImagePayload(imageDataUrl) {
  if (!imageDataUrl || typeof imageDataUrl !== 'string') {
    return { valid: false, status: 400, error: 'Görsel verisi bulunamadı.' };
  }

  // 1. Fast header split without running giant regex over multi-MB base64 string
  const commaIdx = imageDataUrl.indexOf(',');
  let rawFormat = 'jpeg';
  let cleanBase64 = imageDataUrl;

  if (commaIdx !== -1) {
    const header = imageDataUrl.slice(0, commaIdx).toLowerCase();
    cleanBase64 = imageDataUrl.slice(commaIdx + 1).trim();
    const mimeMatch = header.match(/data:image\/([a-z0-9+.-]+)/);
    if (!mimeMatch && !header.includes('base64')) {
      return {
        valid: false,
        status: 400,
        error: 'Geçersiz dosya formatı. Yalnızca fotoğraf (JPEG, PNG, WEBP) yüklenebilir.'
      };
    }
    if (mimeMatch) rawFormat = mimeMatch[1];
  } else {
    cleanBase64 = imageDataUrl.trim();
  }

  // 2. Decode base64 and check byte size
  const buffer = Buffer.from(cleanBase64, 'base64');
  if (buffer.length < MIN_IMAGE_BYTES) {
    return {
      valid: false,
      status: 400,
      error: 'Yüklenen görsel dosyası çok küçük veya bozuk.'
    };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return {
      valid: false,
      status: 413,
      error: 'Görsel boyutu çok büyük. Maksimum 15 MB fotoğraf yüklenebilir.'
    };
  }

  // 3. Verify Binary Magic Bytes (File Signature)
  const isJpeg = buffer.length >= 3 &&
    buffer[0] === 0xFF &&
    buffer[1] === 0xD8 &&
    buffer[2] === 0xFF;

  const isPng = buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A;

  const isWebp = buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP';

  if (!isJpeg && !isPng && !isWebp) {
    return {
      valid: false,
      status: 400,
      error: 'Dosya içeriği doğrulanamadı. Lütfen geçerli bir resim dosyası (JPG, PNG, WEBP) yükleyin.'
    };
  }

  let ext = 'jpg';
  let mimeType = 'image/jpeg';
  if (isPng) {
    ext = 'png';
    mimeType = 'image/png';
  } else if (isWebp) {
    ext = 'webp';
    mimeType = 'image/webp';
  } else if (rawFormat === 'jpeg' || rawFormat === 'jpg' || isJpeg) {
    ext = 'jpg';
    mimeType = 'image/jpeg';
  }

  return {
    valid: true,
    buffer,
    cleanBase64,
    ext,
    mimeType
  };
}

// Helper: Upload image buffer to Supabase Storage
async function uploadToSupabaseStorage(filename, buffer, mimeType = 'image/jpeg') {
  try {
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${encodeURIComponent(filename)}`;
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': mimeType,
        'cache-control': '31536000'
      },
      body: buffer
    });

    if (res.ok) {
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${encodeURIComponent(filename)}`;
      console.log('✓ Görsel Supabase CDN kalıcı bulutuna yüklendi:', publicUrl);
      return publicUrl;
    } else {
      console.warn('Supabase storage yükleme yanıtı:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Supabase storage hatası:', err.message);
  }
  return null;
}

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

// Helper to parse JSON body with strict byte limit
function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let receivedBytes = 0;
    let aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        aborted = true;
        const err = new Error('Gönderilen veri boyutu sınırı aşıldı (Maksimum 15 MB görsel).');
        err.statusCode = 413;
        reject(err);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        const parseErr = new Error('Geçersiz JSON verisi gönderildi.');
        parseErr.statusCode = 400;
        reject(parseErr);
      }
    });
    req.on('error', reject);
  });
}

// ==========================================
// GEMINI VISION ENGINE WITH SMART MODEL POOL & COOLDOWN
// ==========================================
const modelCooldownUntil = new Map();

const VISION_MODELS_POOL = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-flash-lite-latest',
  'gemini-2.5-pro',
  'gemini-3.1-pro-preview',
  'gemini-4-argon',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-pro-latest'
];

function extractPhoneFromText(str) {
  if (!str) return { cleanText: '', phone: '' };
  const s = String(str).trim();
  const phoneRegex = /(\+?\d[\d\s()-]{8,16}\d)/;
  const match = s.match(phoneRegex);
  if (match) {
    const digits = match[1].replace(/\D/g, '');
    if (digits.length >= 9) {
      const cleanText = s.replace(match[0], '').replace(/[()/-]/g, ' ').replace(/\s+/g, ' ').trim();
      return { cleanText, phone: match[1].trim() };
    }
  }
  return { cleanText: s, phone: '' };
}

function postProcessGeminiFormOutput(parsed) {
  if (Array.isArray(parsed)) {
    parsed = parsed[0] || {};
  }
  if (!parsed || typeof parsed !== 'object') {
    parsed = {};
  }

  let capName = String(parsed.captain_name || '').trim();
  let capSurname = String(parsed.captain_surname || '').trim();
  let capPhone = String(parsed.captain_phone || '').trim();
  let capTitle = String(parsed.captain_title || 'KAPTAN').trim();

  // Check if a phone number was written inside captain_name or captain_surname (e.g. Ocean's Five or Ocean MY forms)
  const nameExtracted = extractPhoneFromText(capName);
  if (nameExtracted.phone) {
    if (!capPhone) capPhone = nameExtracted.phone;
    capName = nameExtracted.cleanText;
  }
  const surnameExtracted = extractPhoneFromText(capSurname);
  if (surnameExtracted.phone) {
    if (!capPhone) capPhone = surnameExtracted.phone;
    capSurname = surnameExtracted.cleanText;
  }

  // If captain_surname became empty because the phone number was written on the SOYİSİM line, split captain_name
  if (capName && !capSurname && capName.includes(' ')) {
    const parts = capName.split(/\s+/);
    capSurname = parts.pop() || '';
    capName = parts.join(' ');
  }

  const rawCrew = Array.isArray(parsed.crew) ? parsed.crew : [];
  const cleanedCrew = [];

  for (const item of rawCrew) {
    if (!item || typeof item !== 'object') continue;
    let cName = String(item.name || '').trim();
    let cSurname = String(item.surname || '').trim();
    let cRole = String(item.role || '').trim();
    let cPhone = String(item.phone || '').trim();

    // Check if role in parentheses is inside surname, e.g. "Temiz (Kaptan)"
    const parenMatch = cSurname.match(/\(([^)]+)\)/);
    if (parenMatch) {
      const inside = parenMatch[1].trim();
      cSurname = cSurname.replace(parenMatch[0], '').trim();
      if (!cRole || /\d{4}/.test(cRole)) {
        cRole = inside;
      }
    }

    // Check if phone number was placed inside cRole (since Setur form's 3rd column is titled "Görev")
    const rolePhone = extractPhoneFromText(cRole);
    if (rolePhone.phone) {
      if (!cPhone) cPhone = rolePhone.phone;
      cRole = rolePhone.cleanText || 'Gemici';
    }

    // Check if phone number was placed inside cSurname
    const surPhone = extractPhoneFromText(cSurname);
    if (surPhone.phone) {
      if (!cPhone) cPhone = surPhone.phone;
      cSurname = surPhone.cleanText;
    }

    // Check if cName has full name while cSurname is empty
    if (cName && !cSurname && cName.includes(' ')) {
      const p = cName.split(/\s+/);
      cSurname = p.pop() || '';
      cName = p.join(' ');
    }

    // If this person matches the Captain in the top section, assign Kaptan role & captain's phone if missing
    const isSameAsCaptain = capName &&
      cName.toLocaleLowerCase('tr-TR') === capName.toLocaleLowerCase('tr-TR') &&
      (!capSurname || !cSurname || cSurname.toLocaleLowerCase('tr-TR') === capSurname.toLocaleLowerCase('tr-TR'));

    if (isSameAsCaptain) {
      if (!cRole || cRole.toLocaleLowerCase('tr-TR') === 'mürettebat' || cRole.toLocaleLowerCase('tr-TR') === 'gemici') {
        cRole = capTitle || 'Kaptan';
      }
      if (!cPhone && capPhone) {
        cPhone = capPhone;
      }
    }

    cleanedCrew.push({
      name: cName,
      surname: cSurname,
      role: cRole || (isSameAsCaptain ? 'Kaptan' : 'Gemici'),
      phone: cPhone
    });
  }

  // Ensure the Captain / Responsible person from top section is included in crew list if not already present
  if (capName || capSurname || capPhone) {
    const capFullLower = `${capName} ${capSurname}`.toLocaleLowerCase('tr-TR').trim();
    const capPhoneKey = getPhoneDigitsKey(capPhone);
    const alreadyInCrew = cleanedCrew.some(c => {
      const cFullLower = `${c.name} ${c.surname}`.toLocaleLowerCase('tr-TR').trim();
      const cPhoneKey = getPhoneDigitsKey(c.phone);
      return (capFullLower && cFullLower === capFullLower) || (capPhoneKey && capPhoneKey.length >= 7 && cPhoneKey === capPhoneKey);
    });

    if (!alreadyInCrew && (capName || capSurname)) {
      cleanedCrew.unshift({
        name: capName,
        surname: capSurname,
        role: normalizeRole(capTitle || 'Kaptan'),
        phone: capPhone
      });
    }
  }

  return {
    boat_name: parsed.boat_name ? normalizeBoatName(parsed.boat_name) : '',
    form_date: parsed.form_date ? normalizeFormDate(parsed.form_date) : new Date().toISOString().slice(0, 10),
    captain_title: 'KAPTAN',
    captain_name: normalizePersonName(capName),
    captain_surname: normalizePersonName(capSurname),
    notes: String(parsed.notes || '').trim(),
    crew: deduplicateCrewList(cleanedCrew)
  };
}

// Gemini Vision API parser with multi-model pool & cooldown memory
async function analyzeImageWithGemini(cleanBase64, mimeType = 'image/jpeg') {
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
  if (apiKeys.length === 0) {
    throw new Error('Sunucu ortam değişkeninde (env) GEMINI_API_KEY tanımlı değil.');
  }

  const prompt = `Sen denizcilik ve marina belgeleri konusunda uzman bir asistansın.
Ekli görsel Setur Marinas veya benzeri bir "Mürettebat Bilgi Formu" el yazısı belgesidir.

ÇOK ÖNEMLİ TALİMATLAR:
1. Görsel yamuk, 90 derece yan (dikey/yatay), baş aşağı ters veya perspektif bozukluğu ile çekilmiş olabilir. Metinlerin yönü ve açısı ne olursa olsun belgedeki tüm el yazılarını zihninde doğru yöne çevir ve eksiksiz oku.
2. Form iki ana bölümden oluşur:
   - ÜST BÖLÜM ("TEKNE SAHİBİ / KAPTANI / SORUMLUSU BİLGİLERİ"): Burada TEKNE ADI, ÜNVAN, İSİM ve SOYİSİM satırları bulunur. Çok dikkat et: Kaptanlar bazen telefon numarasını üst bölümdeki İSİM veya SOYİSİM satırına yazarlar (örneğin İSİM satırına "İknur Adar", SOYİSİM satırına "0533 308 26 53" veya İSİM satırına "Vladimirs +37129691803"). Üst bölümde telefon numarası varsa bunu mutlaka "captain_phone" alanına yaz ve üst bölümdeki kaptanı/sorumluyu aşağıdaki "crew" (mürettebat) listesine de ilk sıradan ekle!
   - ALT BÖLÜM ("MÜRETTEBAT BİLGİLERİ"): Tabloda "İsim", "Soyisim" ve "Görev" sütunları vardır. Basılı formda "Telefon" sütunu olmadığı için kaptanlar telefon numaralarını genellikle "Görev" sütununa yazarlar, görevi ise ya Soyisim'in yanına parantez içinde yazarlar ya da boş bırakırlar.
   - Telefon numarasını mutlaka "phone" alanına koy (Türk numarası ise 05XX XXX XX XX formatında, yabancı numara ise + ülke koduyla).
   - Görev belirtilmemişse ve kişi üst bölümdeki kaptan ise görevine "Kaptan", diğer kişiler ise görevine "Gemici" yaz.
3. Formun altında veya üstünde "TARİH" alanı varsa YYYY-MM-DD formatına çevirerek "form_date" alanına yaz (yoksa "" bırak).

Yalnızca şu JSON formatında cevap ver, Markdown kod bloğu veya açıklama ekleme:
{
  "boat_name": "Tekne Adı",
  "form_date": "YYYY-MM-DD",
  "captain_title": "Ünvan (örn: KAPTAN)",
  "captain_name": "Sorumlu İsim",
  "captain_surname": "Sorumlu Soyisim",
  "captain_phone": "Varsa Sorumlu/Kaptan Telefonu",
  "notes": "Varsa notlar",
  "crew": [
    {
      "name": "İsim",
      "surname": "Soyisim",
      "role": "Görev (Kaptan, Gemici, Aşçı, Çarkçı, Kamarot / Hostes)",
      "phone": "05XX XXX XX XX"
    }
  ]
}`;

  const now = Date.now();
  // Sort models: available (not on cooldown) models first, then models with earliest cooldown expiration
  const orderedModels = [...VISION_MODELS_POOL].sort((a, b) => {
    const cdA = modelCooldownUntil.get(a) || 0;
    const cdB = modelCooldownUntil.get(b) || 0;
    const activeA = cdA <= now ? 0 : cdA;
    const activeB = cdB <= now ? 0 : cdB;
    return activeA - activeB;
  });

  let lastError = null;

  for (const apiKey of apiKeys) {
    for (const model of orderedModels) {
      try {
        const isGemma = model.startsWith('gemma-');
        // Note: Do NOT include deprecated 'temperature' parameter (causes HTTP 400 on Gemini 3.5-flash-lite / 3.6-flash+)
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
          ...(isGemma ? {} : {
            generationConfig: {
              responseMimeType: 'application/json'
            }
          })
        };

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 429) {
            // If daily quota exhausted on this model, put on 60-minute cooldown so next requests skip it in 0ms
            const isDaily = errText.includes('PerDay') || errText.includes('retryDelay');
            modelCooldownUntil.set(model, Date.now() + (isDaily ? 60 * 60 * 1000 : 45 * 1000));
          } else if (response.status === 404 || response.status === 400) {
            modelCooldownUntil.set(model, Date.now() + 30 * 60 * 1000);
          }
          lastError = new Error(`Gemini (${model}) Hatası HTTP ${response.status}`);
          continue;
        }

        const result = await response.json();
        const parts = result.candidates?.[0]?.content?.parts || [];
        const textPart = parts.find(p => typeof p.text === 'string' && p.text.trim().length > 0);
        const textOutput = textPart?.text;

        if (!textOutput) {
          lastError = new Error(`Model (${model}) boş yanıt döndürdü.`);
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(textOutput);
        } catch (e) {
          const cleaned = textOutput.replace(/```json/gi, '').replace(/```/g, '').trim();
          const firstBrace = cleaned.indexOf('{');
          const lastBrace = cleaned.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
          } else {
            parsed = JSON.parse(cleaned);
          }
        }

        // Clear any cooldown on success
        modelCooldownUntil.delete(model);
        console.log(`✓ Form "${model}" modeli ile başarıyla okundu.`);
        return postProcessGeminiFormOutput(parsed);
      } catch (e) {
        lastError = e;
      }
    }
  }

  throw lastError || new Error('Yapay zekâ servisi şu an yanıt veremedi, lütfen tekrar deneyin.');
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    if (!inMemoryDb) inMemoryDb = readLocalDb();

    // API: GET /api/boats
    if (req.method === 'GET' && pathname === '/api/boats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(inMemoryDb.boats || []));
      return;
    }

    // API: GET /api/contacts
    if (req.method === 'GET' && pathname === '/api/contacts') {
      const contacts = [];
      (inMemoryDb.boats || []).forEach(b => {
        (b.crew || []).forEach(c => {
          contacts.push({
            ...c,
            boat_id: b.id,
            boat_name: b.name,
            boat_image_url: b.image_url,
            boat_form_date: b.form_date || (b.created_at || '').slice(0, 10),
            boat_updated_at: b.updated_at || b.created_at
          });
        });
      });
      contacts.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(contacts));
      return;
    }

    // API: POST /api/boats (Create or Merge & Normalize)
    if (req.method === 'POST' && pathname === '/api/boats') {
      if (!checkRateLimit(req, res, 'write-boats', 200, 5 * 60 * 1000)) return;

      const body = await parseJsonBody(req, 512 * 1024);
      const rawName = String(body.name || '').trim().slice(0, 120);
      if (!rawName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Tekne adı zorunludur.' }));
        return;
      }

      const nowIso = new Date().toISOString();
      const normalizedCrew = deduplicateCrewList(Array.isArray(body.crew) ? body.crew.slice(0, 50) : []);
      const formDate = normalizeFormDate(body.form_date, nowIso);
      const mergeTargetId = body.mergeWithBoatId ? String(body.mergeWithBoatId).trim() : null;

      if (mergeTargetId) {
        const targetIdx = inMemoryDb.boats.findIndex(b => b.id === mergeTargetId);
        if (targetIdx !== -1) {
          const existing = inMemoryDb.boats[targetIdx];
          const mergedBoat = normalizeSingleBoat({
            ...existing,
            name: normalizeBoatName(rawName),
            captain_name: body.captain_name ? normalizePersonName(body.captain_name) : existing.captain_name,
            captain_surname: body.captain_surname ? normalizePersonName(body.captain_surname) : existing.captain_surname,
            notes: body.notes ? String(body.notes).trim().slice(0, 500) : existing.notes,
            image_url: body.image_url ? String(body.image_url).trim().slice(0, 500) : existing.image_url,
            form_date: formDate,
            updated_at: nowIso,
            crew: [...normalizedCrew, ...(existing.crew || [])]
          });
          inMemoryDb.boats.splice(targetIdx, 1);
          inMemoryDb.boats.unshift(mergedBoat);
          saveDb();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: mergedBoat.id, merged: true, boat: mergedBoat }));
          return;
        }
      }

      const boatId = crypto.randomUUID();
      const newBoat = normalizeSingleBoat({
        id: boatId,
        name: rawName,
        captain_title: 'KAPTAN',
        captain_name: String(body.captain_name || '').trim().slice(0, 80),
        captain_surname: String(body.captain_surname || '').trim().slice(0, 80),
        notes: String(body.notes || '').trim().slice(0, 500),
        image_url: String(body.image_url || '').trim().slice(0, 500),
        form_date: formDate,
        created_at: nowIso,
        updated_at: nowIso,
        crew: normalizedCrew
      });

      inMemoryDb.boats.unshift(newBoat);
      saveDb();

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: boatId, merged: false, boat: newBoat }));
      return;
    }

    // API: DELETE /api/boats/:id
    if (req.method === 'DELETE' && pathname.startsWith('/api/boats/')) {
      if (!checkRateLimit(req, res, 'delete-boats', 100, 5 * 60 * 1000)) return;

      const boatId = pathname.replace('/api/boats/', '');
      const boatIndex = inMemoryDb.boats.findIndex(b => b.id === boatId);
      
      if (boatIndex !== -1) {
        inMemoryDb.boats.splice(boatIndex, 1);
        saveDb();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // API: POST /api/upload-and-analyze (Rate Limited + File Validation + Server Env API Key Only)
    if (req.method === 'POST' && pathname === '/api/upload-and-analyze') {
      // Rate Limit: Max 120 uploads per 15 minutes per IP (supports bulk scanning at marina)
      if (!checkRateLimit(req, res, 'upload-analyze', 120, 15 * 60 * 1000)) return;

      // Max 20 MB JSON payload (~15 MB binary image)
      const body = await parseJsonBody(req, 20 * 1024 * 1024);

      // Strict file check (MIME, size, magic bytes)
      const validation = validateImagePayload(body.image);
      if (!validation.valid) {
        res.writeHead(validation.status || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: validation.error }));
        return;
      }

      const { buffer: imageBuffer, cleanBase64, ext, mimeType } = validation;
      const filename = `form_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, filename);

      // Save locally as temporary/cache
      fs.writeFileSync(filePath, imageBuffer);

      // Upload to Supabase Storage for permanent global CDN URL
      const permanentCloudUrl = await uploadToSupabaseStorage(filename, imageBuffer, mimeType);
      const imageUrl = permanentCloudUrl || `/uploads/${filename}`;

      // API Key strictly from Server Environment Variable
      if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEYS) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          imageUrl,
          aiError: 'Sunucu GEMINI_API_KEY ortam değişkeni tanımlı değil.',
          message: 'Fotoğraf kaydedildi ancak sunucuda GEMINI_API_KEY ortam değişkeni bulunamadı.'
        }));
        return;
      }

      try {
        const analyzedData = await analyzeImageWithGemini(cleanBase64, mimeType);
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

    // API: GET /api/export-vcard-person (Single Person vCard)
    if (req.method === 'GET' && pathname === '/api/export-vcard-person') {
      const name = normalizePersonName(parsedUrl.searchParams.get('name') || '');
      const surname = normalizePersonName(parsedUrl.searchParams.get('surname') || '');
      const role = normalizeRole(parsedUrl.searchParams.get('role') || 'Mürettebat');
      const boatName = normalizeBoatName(parsedUrl.searchParams.get('boat') || 'Marina Teknesi');
      const rawPhone = parsedUrl.searchParams.get('phone') || '';
      const digits = getPhoneDigitsKey(rawPhone);
      const telFormatted = digits.length === 10 ? `+90${digits}` : rawPhone;

      const fullName = `${name} ${surname}`.trim() || 'İsimsiz Personel';
      let vcard = 'BEGIN:VCARD\r\n';
      vcard += 'VERSION:3.0\r\n';
      vcard += `FN:${fullName} (${boatName} - ${role})\r\n`;
      vcard += `N:${surname};${name};;;\r\n`;
      vcard += `ORG:${boatName}\r\n`;
      vcard += `TITLE:${role}\r\n`;
      if (telFormatted) {
        vcard += `TEL;TYPE=CELL,VOICE:${telFormatted}\r\n`;
      }
      vcard += `NOTE:Tekne: ${boatName} | Görev: ${role}\r\n`;
      vcard += 'END:VCARD\r\n';

      res.writeHead(200, {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fullName)}_${encodeURIComponent(boatName)}.vcf"`
      });
      res.end(vcard);
      return;
    }

    // API: GET /api/export-vcard/:id (Entire Boat Crew vCard)
    if (req.method === 'GET' && pathname.startsWith('/api/export-vcard/')) {
      const boatId = pathname.replace('/api/export-vcard/', '');
      const boat = inMemoryDb.boats.find(b => b.id === boatId);
      if (!boat) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Tekne bulunamadı');
        return;
      }

      let vcardContent = '';
      for (const m of (boat.crew || [])) {
        const digits = getPhoneDigitsKey(m.phone);
        const telFormatted = digits.length === 10 ? `+90${digits}` : (m.phone || '');
        const fullName = `${m.name || ''} ${m.surname || ''}`.trim();
        vcardContent += 'BEGIN:VCARD\r\n';
        vcardContent += 'VERSION:3.0\r\n';
        vcardContent += `FN:${fullName} (${boat.name} - ${m.role})\r\n`;
        vcardContent += `N:${m.surname || ''};${m.name || ''};;;\r\n`;
        vcardContent += `ORG:${boat.name}\r\n`;
        vcardContent += `TITLE:${m.role || ''}\r\n`;
        if (telFormatted) {
          vcardContent += `TEL;TYPE=CELL,VOICE:${telFormatted}\r\n`;
        }
        vcardContent += `NOTE:Tekne: ${boat.name} | Görev: ${m.role || ''} | Form Tarihi: ${boat.form_date || '-'}\r\n`;
        vcardContent += 'END:VCARD\r\n';
      }

      res.writeHead(200, {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(boat.name)}_Tum_Murettebat.vcf"`
      });
      res.end(vcardContent);
      return;
    }

    // Helper: Verify Admin Password for sensitive exports (Backup & Excel)
    if (req.method === 'GET' && (pathname === '/api/backup' || pathname === '/api/export-csv')) {
      const expectedPassword = (process.env.ADMIN_PASSWORD || 'Setur2026').trim();
      const providedPassword = String(
        req.headers['x-admin-password'] || parsedUrl.searchParams.get('pwd') || ''
      ).trim();

      if (!providedPassword || providedPassword !== expectedPassword) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Yetkisiz erişim: Şifre hatalı veya girilmedi.' }));
        return;
      }
    }

    // API: GET /api/backup (Download Full Database JSON Backup)
    if (req.method === 'GET' && pathname === '/api/backup') {
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="Marina_Rehber_Yedek_${today}.json"`
      });
      res.end(JSON.stringify(inMemoryDb, null, 2));
      return;
    }

    // API: GET /api/export-csv
    if (req.method === 'GET' && pathname === '/api/export-csv') {
      let csv = '\uFEFFTekne Adı;Form Tarihi;Son Güncelleme;Sorumlu Kaptan;Personel İsim;Personel Soyisim;Görev;Telefon\r\n';
      (inMemoryDb.boats || []).forEach(b => {
        const kaptan = `${b.captain_name || ''} ${b.captain_surname || ''}`.trim();
        const formDate = b.form_date || (b.created_at || '').slice(0, 10);
        const updatedDate = (b.updated_at || b.created_at || '').slice(0, 10);
        (b.crew || []).forEach(c => {
          csv += `"${b.name || ''}";"${formDate}";"${updatedDate}";"${kaptan}";"${c.name || ''}";"${c.surname || ''}";"${c.role || ''}";"${c.phone || ''}"\r\n`;
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
      const headers = { 'Content-Type': contentType };
      if (ext === '.html') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      }
      res.writeHead(200, headers);
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=UTF-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err) {
    console.error('Server hatası:', err);
    const statusCode = err.statusCode || 500;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || 'Sunucu hatası oluştu.' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚓ Marina Tekne & Mürettebat Rehberi Servisi Başlatıldı!`);
  console.log(`Port: ${PORT}`);
});

// server/soundLibrary.js
// จัดการ "คลังเสียง" ของเกม: ไฟล์ในโฟลเดอร์ assets/sounds + เสียงที่ดึงมาจาก myinstants.com
// พร้อมวิเคราะห์ envelope ล่วงหน้าเก็บไว้ใน data/library.json เพื่อไม่ต้องวิเคราะห์ซ้ำทุกครั้ง

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { analyzeFile } = require('./audio');

const ROOT = path.join(__dirname, '..');
const LOCAL_SOUNDS_DIR = path.join(ROOT, 'assets', 'sounds');
const CACHE_SOUNDS_DIR = path.join(ROOT, 'library_cache', 'sounds');
const LIBRARY_JSON = path.join(ROOT, 'data', 'library.json');

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac']);

for (const dir of [LOCAL_SOUNDS_DIR, CACHE_SOUNDS_DIR, path.dirname(LIBRARY_JSON)]) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadLibraryMeta() {
  try {
    const raw = fs.readFileSync(LIBRARY_JSON, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveLibraryMeta(meta) {
  fs.writeFileSync(LIBRARY_JSON, JSON.stringify(meta, null, 2), 'utf-8');
}

let libraryMeta = loadLibraryMeta();

function idFor(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

/**
 * สแกนไฟล์เสียงในโฟลเดอร์ assets/sounds (ไฟล์ที่ผู้ใช้ก็อปวางเองได้) และไฟล์ที่แคชไว้จาก myinstants
 * วิเคราะห์ envelope ให้ไฟล์ใหม่ที่ยังไม่เคยวิเคราะห์ แล้ว sync กับ meta
 */
async function scanAndSync() {
  const results = [];

  const scanDir = async (dir, source) => {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const filename of files) {
      const ext = path.extname(filename).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      const filePath = path.join(dir, filename);
      const id = idFor(filePath);
      let entry = libraryMeta[id];
      if (!entry || entry.mtimeMs !== fs.statSync(filePath).mtimeMs) {
        try {
          const sig = await analyzeFile(filePath);
          entry = {
            id,
            name: entry?.name || path.basename(filename, ext),
            source,
            relPath: path.relative(ROOT, filePath),
            mtimeMs: fs.statSync(filePath).mtimeMs,
            durationMs: sig.durationMs,
            envelope: sig.envelope,
            onsets: sig.onsets,
            pitch: sig.pitch,
            voicedRatio: sig.voicedRatio,
            addedAt: entry?.addedAt || Date.now(),
          };
          libraryMeta[id] = entry;
        } catch (err) {
          console.error(`[soundLibrary] วิเคราะห์ไฟล์ล้มเหลว: ${filePath}`, err.message);
          continue;
        }
      }
      results.push(entry);
    }
  };

  await scanDir(LOCAL_SOUNDS_DIR, 'local');
  await scanDir(CACHE_SOUNDS_DIR, 'myinstants');

  saveLibraryMeta(libraryMeta);
  results.sort((a, b) => b.addedAt - a.addedAt);
  return results;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80) || 'sound';
}

/**
 * รับลิงก์จาก myinstants.com (หน้า instant หรือลิงก์ mp3 ตรง) แล้วดาวน์โหลดมาเก็บในคลัง
 */
async function addFromMyInstants(url) {
  let pageUrl;
  try {
    pageUrl = new URL(url);
  } catch {
    throw new Error('ลิงก์ไม่ถูกต้อง');
  }
  if (!/myinstants\.com$/i.test(pageUrl.hostname.replace(/^www\./, ''))) {
    throw new Error('รองรับเฉพาะลิงก์จาก myinstants.com เท่านั้น');
  }

  let mp3Url;
  let title = null;

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
    Referer: 'https://www.myinstants.com/',
  };

  if (/\.mp3(\?.*)?$/i.test(pageUrl.pathname)) {
    mp3Url = pageUrl.toString();
  } else {
    const { data: html } = await axios.get(pageUrl.toString(), {
      headers: browserHeaders,
      timeout: 15000,
    });
    const mp3Match = html.match(/(?:https?:\/\/[^"'()\s]*)?\/?media\/sounds\/[^"'()\s]+\.mp3/i);
    if (!mp3Match) {
      throw new Error('หาไฟล์เสียงในหน้านี้ไม่เจอ ลองใช้ลิงก์หน้า instant ของ myinstants โดยตรง');
    }
    const rawPath = mp3Match[0].replace(/^https?:\/\/[^/]+/i, '');
    mp3Url = `https://www.myinstants.com${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;

    const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].replace(/\s*\|\s*Myinstants.*/i, '').trim();
    }
  }

  const resp = await axios.get(mp3Url, {
    responseType: 'arraybuffer',
    headers: browserHeaders,
    timeout: 20000,
  });

  const baseName = sanitizeFilename(title || path.basename(mp3Url, '.mp3'));
  let filePath = path.join(CACHE_SOUNDS_DIR, `${baseName}.mp3`);
  let counter = 1;
  while (fs.existsSync(filePath)) {
    filePath = path.join(CACHE_SOUNDS_DIR, `${baseName}_${counter}.mp3`);
    counter++;
  }
  fs.writeFileSync(filePath, resp.data);

  const id = idFor(filePath);
  const sig = await analyzeFile(filePath);
  const entry = {
    id,
    name: title || baseName,
    source: 'myinstants',
    sourceUrl: pageUrl.toString(),
    relPath: path.relative(ROOT, filePath),
    mtimeMs: fs.statSync(filePath).mtimeMs,
    durationMs: sig.durationMs,
    envelope: sig.envelope,
    onsets: sig.onsets,
    pitch: sig.pitch,
    voicedRatio: sig.voicedRatio,
    addedAt: Date.now(),
  };
  libraryMeta[id] = entry;
  saveLibraryMeta(libraryMeta);
  return entry;
}

function getAll() {
  return Object.values(libraryMeta).sort((a, b) => b.addedAt - a.addedAt);
}

function getById(id) {
  return libraryMeta[id] || null;
}

function removeById(id) {
  const entry = libraryMeta[id];
  if (!entry) return false;
  try {
    const filePath = path.join(ROOT, entry.relPath);
    if (entry.source === 'myinstants' && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error('[soundLibrary] ลบไฟล์ล้มเหลว', err.message);
  }
  delete libraryMeta[id];
  saveLibraryMeta(libraryMeta);
  return true;
}

function absolutePathFor(entry) {
  return path.join(ROOT, entry.relPath);
}

module.exports = {
  scanAndSync,
  addFromMyInstants,
  getAll,
  getById,
  removeById,
  absolutePathFor,
  LOCAL_SOUNDS_DIR,
  CACHE_SOUNDS_DIR,
};

// server/index.js
// Mimic Party (เวอร์ชันเว็บ) — ปาร์ตี้เกมเลียนแบบเสียง เล่นผ่านเบราว์เซอร์ ควบคุมด้วยมือถือผ่าน QR Code
// รัน: npm install แล้ว npm start

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const http = require('http');
const https = require('https');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const soundLibrary = require('./soundLibrary');
const { analyzeFile, scoreAgainstReference, calibratedSilenceThreshold } = require('./audio');
const { RoomManager, PHASES } = require('./rooms');
const { getOrCreateCert } = require('./certs');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const ROOT = path.join(__dirname, '..');
const UPLOADS_TAKES_DIR = path.join(ROOT, 'uploads', 'takes');
fs.mkdirSync(UPLOADS_TAKES_DIR, { recursive: true });
const UPLOADS_CALIBRATION_DIR = path.join(ROOT, 'uploads', 'calibration');
fs.mkdirSync(UPLOADS_CALIBRATION_DIR, { recursive: true });

// ไฟล์เสียงที่ผู้เล่นอัดส่งมาเก็บอยู่ในเครื่อง host เอง (เกมนี้รันเซิร์ฟเวอร์บนเครื่อง host เอง ไม่ได้มี server
// แยกต่างหากที่ไหน) ไม่อยากให้โฟลเดอร์นี้พอกพูนไปเรื่อยๆ ตามจำนวนรอบ/จำนวนครั้งที่เล่น จึงลบทิ้งทันทีที่ไม่ต้องใช้แล้ว
// (ดู cleanupRoundTakeFiles) แต่เผื่อกรณีปิด server กะทันหันกลางเกม (ไฟล์ค้างไม่ได้ถูกลบ) เลยเคลียร์ไฟล์ที่ตกค้าง
// จากการรันครั้งก่อนทิ้งไปเลยตอนเริ่ม server ใหม่ทุกครั้งด้วย
try {
  for (const f of fs.readdirSync(UPLOADS_TAKES_DIR)) {
    try { fs.unlinkSync(path.join(UPLOADS_TAKES_DIR, f)); } catch { /* เพิกเฉย ไฟล์เดียวลบไม่ได้ก็ข้ามไป */ }
  }
} catch (err) {
  console.error('[cleanup] เคลียร์ไฟล์เสียงที่อัดค้างจากรอบก่อนไม่สำเร็จ:', err.message);
}

/** ลบไฟล์เสียงที่ผู้เล่นอัดส่งมาของรอบหนึ่งๆ ทิ้งจากดิสก์ เรียกตอนรอบนั้นเฉลยผลจบแล้ว (ไม่มีที่ไหนอ้างอิงไฟล์นี้ต่อแล้ว) */
function cleanupRoundTakeFiles(round) {
  if (!round || !round.submissions) return;
  for (const sub of round.submissions.values()) {
    if (!sub.url) continue; // เงียบ/หมดเวลา/วิเคราะห์ล้มเหลว ไม่มีไฟล์อยู่แล้ว
    const filePath = path.join(UPLOADS_TAKES_DIR, path.basename(sub.url));
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error('[cleanup] ลบไฟล์เสียงที่อัดไม่สำเร็จ:', filePath, err.message);
      }
    });
  }
}

const MIN_RECORD_MS = 3000;
const RECORD_BUFFER_MS = 1200;
const FORCE_FINISH_EXTRA_MS = 15000;
// เวลาที่แต่ละคนถูกเฉลยผล/โชว์คะแนนค้างอยู่บนจอ ก่อนขึ้นคนถัดไป (นับรวมเวลาที่เล่นเสียงเลียนแบบด้วย)
// ปรับให้นานขึ้นตามที่ผู้ใช้ขอ เพื่อให้มีเวลาอ่านคะแนน/รูปคลื่นเทียบกันจริงๆ ก่อนเปลี่ยนคนถัดไป
const REVEAL_MIN_GAP_MS = 3000; // กรณีไม่มีเสียงเล่น (เงียบ/timeout/failed) — เดิม 1800
const REVEAL_SCORE_VIEW_MS = 2800; // เวลาที่เผื่อไว้ "หลังจากเสียงเล่นจบ" ให้มองคะแนนได้ทัน — เดิม 1300
const REVEAL_MAX_GAP_MS = 10000; // เพดานสูงสุดต่อคน กันไม่ให้เสียงยาวๆ ทำให้ค้างนานเกินไป — เดิม 8000
const ROUND_RESULT_AUTO_MS = 8000;

const app = express();
const server = http.createServer(app);
// ตั้ง ping ให้ถี่ขึ้นกว่าค่า default (25s/20s) เพื่อให้เซิร์ฟเวอร์รู้ไวขึ้นเวลาผู้เล่นปิดเว็บ/หลุดการเชื่อมต่อ
// โดยไม่ต้องรอนานเกือบ 45 วินาทีเหมือนค่า default (ยังมีกลไก sendBeacon ตอนปิดหน้าเว็บช่วยแจ้งทันทีอีกชั้นด้วย)
const io = new Server(server, { maxHttpBufferSize: 2e7, pingInterval: 10000, pingTimeout: 8000 });

let httpsServer = null;
let httpsReady = false;
try {
  const { key, cert } = getOrCreateCert();
  httpsServer = https.createServer({ key, cert }, app);
  io.attach(httpsServer);
  httpsReady = true;
} catch (err) {
  console.error('[https] เปิดใช้งาน HTTPS ในวง LAN ไม่สำเร็จ:', err.message);
  console.error('[https] ผู้เล่นที่เข้าผ่าน IP วง LAN ด้วย http:// ธรรมดาจะขอสิทธิ์ไมโครโฟนไม่ได้ (เบราว์เซอร์บล็อก) — แนะนำให้ใช้ tunnel/deploy แบบ https แทน (ดู README)');
}

const manager = new RoomManager();

// ---------- static & media ----------
app.use(express.json());
// ปิด cache ของหน้าเว็บ/ไฟล์ JS/CSS ไว้ก่อน (เกมนี้ยังแก้โค้ดกันบ่อย) กัน browser cache ค้างไฟล์เก่า
// ทำให้ html รุ่นใหม่กับ js รุ่นเก่า (หรือกลับกัน) ไม่ตรงกันจนอ้างอิง element ที่ไม่มีจริงแล้วพัง
app.use(express.static(path.join(ROOT, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));
app.use('/media/sounds', express.static(soundLibrary.LOCAL_SOUNDS_DIR));
app.use('/media/cache', express.static(soundLibrary.CACHE_SOUNDS_DIR));
app.use('/media/takes', express.static(UPLOADS_TAKES_DIR));

app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/join', (req, res) => res.sendFile(path.join(ROOT, 'public', 'play.html')));
app.get('/host', (req, res) => res.sendFile(path.join(ROOT, 'public', 'host.html')));

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/api/network-info', (req, res) => {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push(net.address);
    }
  }
  res.json({ port: PORT, httpsPort: HTTPS_PORT, httpsReady, lanIps: candidates });
});

app.get('/api/qrcode', async (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).send('missing text');
  const size = Math.max(100, Math.min(1024, parseInt(req.query.size, 10) || 320));
  try {
    const buf = await QRCode.toBuffer(String(text), { width: size, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (err) {
    res.status(500).send('qrcode error: ' + err.message);
  }
});

// ---------- audio submission upload ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function extFromMime(m) {
  if (!m) return '.webm';
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('mp4')) return '.m4a';
  if (m.includes('wav')) return '.wav';
  return '.webm';
}

app.post('/api/rooms/:code/submit', upload.single('audio'), (req, res) => {
  const room = manager.get(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: 'ไม่พบห้อง' });

  const { playerId } = req.body;
  const roundIndex = parseInt(req.body.roundIndex, 10);

  if (room.phase !== PHASES.LISTEN_RECORD || roundIndex !== room.roundIndex) {
    return res.json({ ok: false, error: 'stale_round' });
  }
  const player = room.getPlayerById(playerId);
  if (!player || player.role !== 'player') {
    return res.status(400).json({ ok: false, error: 'invalid_player' });
  }
  if (room.currentRound.submissions.has(playerId)) {
    return res.json({ ok: true, duplicate: true });
  }
  if (!req.file) return res.status(400).json({ ok: false, error: 'missing_audio' });

  const ext = extFromMime(req.file.mimetype);
  const filename = `${room.code}_${roundIndex}_${player.id}${ext}`;
  const filePath = path.join(UPLOADS_TAKES_DIR, filename);
  fs.writeFileSync(filePath, req.file.buffer);
  res.json({ ok: true });

  processSubmission(room, roundIndex, player, filename, filePath);
});

async function processSubmission(room, roundIndex, player, filename, filePath) {
  try {
    // ใช้ threshold ตรวจจับความเงียบเฉพาะคน (จากการ calibrate ไมค์ก่อนเกม) ถ้ามี ไม่งั้น analyzeFile จะใช้ค่ากลางเอง
    const sig = await analyzeFile(filePath, { silenceThreshold: player.silenceThreshold });
    if (room.phase !== PHASES.LISTEN_RECORD || room.roundIndex !== roundIndex) return;
    const soundEntry = room.currentRound.soundEntry;
    const { score, shapeScore, rhythmScore, melodyScore, effectivelySilent } = scoreAgainstReference(soundEntry, sig);
    room.currentRound.submissions.set(player.id, {
      url: `/media/takes/${filename}`,
      score,
      shapeScore,
      rhythmScore,
      melodyScore,
      durationMs: sig.durationMs,
      envelope: sig.envelope,
      // ไม่ได้พูดจริงจัง (เงียบสนิท หรือมีแต่ noise ไม่มีเสียงพูด/ทำนองเลยทั้งที่ต้นฉบับคาดว่าต้องมี)
      // ใช้บอกฝั่งแสดงผลไม่ให้กราฟดูเหมือนมีคนพูดทั้งที่จริงๆ ไม่มี
      silent: !!effectivelySilent,
      name: player.name,
    });
    // ส่งผลวิเคราะห์จริง (envelope เดียวกับที่ตอนเฉลยผลจะโชว์ เป๊ะๆ ไม่ใช่ค่าประมาณ) กลับไปให้ "เจ้าของเสียงคนนั้น"
    // คนเดียวทันทีที่วิเคราะห์เสร็จ (ไม่ต้องรอถึงคิวเฉลยผลของรอบ) เพื่อให้หน้า "ส่งเสียงแล้ว" โชว์รูปคลื่นที่แท้จริง
    // แทนกราฟประมาณสดๆ ตอนอัด (ซึ่งมาจากคนละ pipeline กัน เลยไม่มีทางตรงกันเป๊ะ) — อันนี้เป็นข้อมูลชุดเดียวกับที่
    // จะใช้ตอนเฉลยผลจริงๆ เลย รับประกันว่าตรงกัน 100%
    io.to(player.socketId).emit('take:analyzed', {
      envelope: sig.envelope,
      durationMs: sig.durationMs,
      silent: !!effectivelySilent,
    });
    broadcastSubmitProgress(room, player);
    finishRoundIfReady(room);
  } catch (err) {
    console.error('[submit] วิเคราะห์เสียงล้มเหลว:', err.message);
    if (room.phase === PHASES.LISTEN_RECORD && room.roundIndex === roundIndex) {
      room.currentRound.submissions.set(player.id, {
        url: null, score: 0, shapeScore: 0, rhythmScore: 0, melodyScore: 0, envelope: null, silent: true, name: player.name, failed: true,
      });
      io.to(player.socketId).emit('take:analyzed', { envelope: null, durationMs: 0, silent: true, failed: true });
      broadcastSubmitProgress(room, player);
      finishRoundIfReady(room);
    }
  }
}

// ผู้เล่นปิดแท็บ/เบราว์เซอร์ — ฝั่ง client ใช้ navigator.sendBeacon ยิงมาบอกตอนหน้าเว็บกำลังจะปิด (pagehide)
// เพื่อให้เซิร์ฟเวอร์รู้ทันทีว่าออกจากห้องแล้ว ไม่ต้องรอ socket.io ตรวจจับการหลุดการเชื่อมต่อเอง (ซึ่งอาจช้าถึงหลักสิบวินาที
// โดยเฉพาะบนมือถือที่ปิดแอป/ปิดแท็บแล้วระบบปฏิบัติการอาจไม่ปิด connection ให้ทันที)
// หมายเหตุ: req.body ถูก parse ให้แล้วโดย express.json() middleware ตัวกลาง (บรรทัดบนสุดของไฟล์)
// ฝั่ง client ต้องส่งมาเป็น Blob ชนิด 'application/json' (ดู public/js/play.js) ไม่งั้น body parser จะไม่ทำงาน
app.post('/api/rooms/:code/leave', (req, res) => {
  const room = manager.get(req.params.code);
  if (!room) return res.status(204).end();
  const playerId = req.body && req.body.playerId;
  if (playerId) {
    const player = room.getPlayerById(playerId);
    if (player) {
      if (room.phase === PHASES.LOBBY) {
        // ยังไม่เริ่มเกม — เอาออกจากลิสต์ไปเลยเพื่อไม่ให้ค้างรก ไม่กระทบคะแนนอะไรอยู่แล้ว
        room.removePlayer(playerId);
      } else {
        // เริ่มเกมไปแล้ว — แค่ทำเครื่องหมายว่าหลุดการเชื่อมต่อ (เก็บคะแนนไว้ เผื่อกลับมาต่อได้)
        player.connected = false;
      }
      emitState(room);
      finishRoundIfReady(room);
    }
  }
  res.status(204).end();
});

function broadcastSubmitProgress(room, player) {
  io.to(room.code).emit('round:submitted', {
    playerId: player.id,
    name: player.name,
    submittedCount: room.currentRound.submissions.size,
    total: room.currentRound.requiredIds.size,
  });
}

// ---------- game flow ----------
function emitState(room) {
  io.to(room.code).emit('state:update', room.publicState());
}

function soundUrlFor(entry) {
  const base = path.basename(entry.relPath);
  return entry.source === 'local' ? `/media/sounds/${base}` : `/media/cache/${base}`;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildRoundPool(chosenEntries, rounds, shuffle) {
  const pool = [];
  let source = shuffle ? shuffleArray(chosenEntries) : chosenEntries.slice();
  let lastId = null;
  let guard = 0;
  while (pool.length < rounds && guard < rounds * 10 + 20) {
    guard++;
    if (source.length === 0) source = shuffle ? shuffleArray(chosenEntries) : chosenEntries.slice();
    let next = source.shift();
    if (next.id === lastId && source.length > 0 && chosenEntries.length > 1) {
      source.push(next);
      next = source.shift();
    }
    pool.push(next);
    lastId = next.id;
  }
  return pool;
}

function startRound(room) {
  room.clearTimers();
  room.roundIndex += 1;
  if (room.roundIndex >= room.roundPool.length) {
    endGame(room);
    return;
  }
  const soundEntry = room.roundPool[room.roundIndex];
  room.phase = PHASES.LISTEN_RECORD;
  const recordMs = Math.max(MIN_RECORD_MS, soundEntry.durationMs + RECORD_BUFFER_MS);
  // จดจำว่า "ใครบ้าง" ที่ต้องส่งเสียงในรอบนี้ ณ ตอนเริ่มรอบ — กันไม่ให้คนที่เพิ่งเข้าห้องมาระหว่างรอบ (late join)
  // ไปทำให้รอบค้าง เพราะรอ submission จากคนที่ไม่ได้อยู่ตั้งแต่ต้นรอบ
  const requiredIds = new Set(room.activePlayers().map((p) => p.id));
  room.currentRound = { soundEntry, recordMs, submissions: new Map(), requiredIds };

  emitState(room);
  io.to(room.code).emit('round:sound', {
    roundIndex: room.roundIndex,
    totalRounds: room.roundPool.length,
    soundName: soundEntry.name,
    soundUrl: soundUrlFor(soundEntry),
    durationMs: soundEntry.durationMs,
    recordMs,
    envelope: soundEntry.envelope,
  });

  room.addTimer(() => forceFinishRound(room, room.roundIndex), soundEntry.durationMs + recordMs + FORCE_FINISH_EXTRA_MS);
}

function requiredPlayersFor(room) {
  return [...room.currentRound.requiredIds]
    .map((id) => room.getPlayerById(id))
    .filter((p) => p && p.connected);
}

function finishRoundIfReady(room) {
  if (room.phase !== PHASES.LISTEN_RECORD) return;
  const needed = requiredPlayersFor(room);
  if (needed.length === 0) return;
  const allIn = needed.every((p) => room.currentRound.submissions.has(p.id));
  if (allIn) {
    room.clearTimers();
    beginReveal(room);
  }
}

function forceFinishRound(room, roundIndex) {
  if (room.phase !== PHASES.LISTEN_RECORD || room.roundIndex !== roundIndex) return;
  for (const p of requiredPlayersFor(room)) {
    if (!room.currentRound.submissions.has(p.id)) {
      room.currentRound.submissions.set(p.id, {
        url: null, score: 0, shapeScore: 0, rhythmScore: 0, melodyScore: 0, envelope: null, silent: true, name: p.name, timedOut: true,
      });
    }
  }
  beginReveal(room);
}

function beginReveal(room) {
  room.phase = PHASES.REVEAL;
  const list = [...room.currentRound.submissions.entries()].map(([playerId, sub]) => ({ playerId, ...sub }));
  room.currentRound.revealQueue = list;
  room.currentRound.revealPos = 0;
  emitState(room);
  scheduleNextReveal(room);
}

function scheduleNextReveal(room) {
  const queue = room.currentRound.revealQueue;
  const pos = room.currentRound.revealPos;
  if (pos >= queue.length) {
    beginRoundResult(room);
    return;
  }
  const take = queue[pos];
  const player = room.getPlayerById(take.playerId);
  if (player) {
    player.lastRoundScore = take.score;
    player.score += take.score;
  }
  io.to(room.code).emit('round:reveal_take', {
    index: pos,
    total: queue.length,
    playerId: take.playerId,
    name: take.name,
    url: take.url,
    score: take.score,
    shapeScore: take.shapeScore,
    rhythmScore: take.rhythmScore,
    melodyScore: take.melodyScore,
    envelope: take.envelope || null,
    referenceEnvelope: room.currentRound.soundEntry.envelope,
    silent: !!take.silent,
    timedOut: !!take.timedOut,
    failed: !!take.failed,
  });
  emitState(room);
  room.currentRound.revealPos += 1;
  const gap = take.durationMs
    ? Math.min(REVEAL_MAX_GAP_MS, take.durationMs + REVEAL_SCORE_VIEW_MS)
    : REVEAL_MIN_GAP_MS;
  room.addTimer(() => scheduleNextReveal(room), gap);
}

function beginRoundResult(room) {
  // เฉลยผลของทุกคนในรอบนี้จบแล้ว ไม่มีที่ไหนอ้างอิงไฟล์เสียงที่อัดมาของรอบนี้ต่อแล้ว ลบทิ้งจากเครื่อง host ได้เลย
  // กันไม่ให้โฟลเดอร์ uploads/takes พอกพูนไปเรื่อยๆ ตามจำนวนรอบที่เล่น
  cleanupRoundTakeFiles(room.currentRound);
  room.phase = PHASES.ROUND_RESULT;
  emitState(room);
  io.to(room.code).emit('round:result', {
    roundIndex: room.roundIndex,
    totalRounds: room.roundPool.length,
    autoAdvanceMs: ROUND_RESULT_AUTO_MS,
  });
  room.addTimer(() => advanceRound(room), ROUND_RESULT_AUTO_MS);
}

function advanceRound(room) {
  room.clearTimers();
  if (room.roundIndex + 1 >= room.roundPool.length) {
    endGame(room);
  } else {
    startRound(room);
  }
}

function endGame(room) {
  room.clearTimers();
  room.phase = PHASES.GAME_OVER;
  room.currentRound = null;
  emitState(room);
  io.to(room.code).emit('game:over', { standings: room.publicState().players });
}

// ---------- socket.io ----------
function requireHostRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return null;
  const room = manager.get(code);
  if (!room || room.hostSocketId !== socket.id) return null;
  return room;
}

io.on('connection', (socket) => {
  socket.on('host:create_room', (_data, cb) => {
    const room = manager.createRoom(socket.id);
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    cb && cb({ ok: true, code: room.code, hostToken: room.hostToken, state: room.publicState() });
  });

  socket.on('host:rejoin_room', ({ code, hostToken } = {}, cb) => {
    const room = manager.get(code);
    if (!room || room.hostToken !== hostToken) {
      return cb && cb({ ok: false, error: 'ไม่พบห้องนี้แล้ว (อาจปิดเซิร์ฟเวอร์ไปแล้ว) กรุณาสร้างห้องใหม่' });
    }
    room.hostSocketId = socket.id;
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    cb && cb({ ok: true, state: room.publicState() });
  });

  socket.on('host:list_library', async (_data, cb) => {
    try {
      const list = await soundLibrary.scanAndSync();
      cb && cb({ ok: true, list });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('host:add_myinstants', async ({ url } = {}, cb) => {
    try {
      const entry = await soundLibrary.addFromMyInstants(url);
      cb && cb({ ok: true, entry });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  // อัปโหลดไฟล์เสียงจากเครื่อง host แบบลาก-วาง/เลือกไฟล์ (ไม่ต้องไปก็อปลง assets/sounds เอง)
  // ส่งเป็นไฟล์ไบนารีตรงๆ ผ่าน socket.io (ขนาดไฟล์ถูกจำกัดโดย maxHttpBufferSize ของ io ด้านบน)
  socket.on('host:upload_sound', async ({ filename, data } = {}, cb) => {
    try {
      if (!filename || !data) throw new Error('ไม่มีข้อมูลไฟล์');
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const entry = await soundLibrary.addLocalFile(filename, buffer);
      cb && cb({ ok: true, entry });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('host:remove_sound', ({ id } = {}, cb) => {
    soundLibrary.removeById(id);
    cb && cb({ ok: true });
  });

  socket.on('host:set_pool', ({ soundIds, rounds, shuffle } = {}, cb) => {
    const room = requireHostRoom(socket);
    if (!room) return cb && cb({ ok: false, error: 'ไม่พบห้องของคุณ' });
    const chosen = (soundIds || []).map((id) => soundLibrary.getById(id)).filter(Boolean);
    if (chosen.length === 0) return cb && cb({ ok: false, error: 'กรุณาเลือกเสียงอย่างน้อย 1 เสียง' });
    const roundCount = Math.max(1, Math.min(200, parseInt(rounds, 10) || chosen.length));
    room.roundPool = buildRoundPool(chosen, roundCount, !!shuffle);
    emitState(room);
    cb && cb({ ok: true, totalRounds: room.roundPool.length, names: room.roundPool.map((s) => s.name) });
  });

  socket.on('host:start_game', (_data, cb) => {
    const room = requireHostRoom(socket);
    if (!room) return cb && cb({ ok: false, error: 'ไม่พบห้องของคุณ' });
    if (room.roundPool.length === 0) return cb && cb({ ok: false, error: 'ยังไม่ได้เลือกเสียง/จำนวนรอบ' });
    if (room.activePlayers().length === 0) return cb && cb({ ok: false, error: 'ยังไม่มีผู้เล่นเข้าร่วม' });
    room.roundIndex = -1;
    startRound(room);
    cb && cb({ ok: true });
  });

  socket.on('host:next_round', (_data, cb) => {
    const room = requireHostRoom(socket);
    if (!room) return cb && cb({ ok: false, error: 'ไม่พบห้องของคุณ' });
    if (room.phase !== PHASES.ROUND_RESULT) return cb && cb({ ok: false, error: 'ยังไม่ถึงจังหวะไปต่อ' });
    advanceRound(room);
    cb && cb({ ok: true });
  });

  socket.on('host:restart', (_data, cb) => {
    const room = requireHostRoom(socket);
    if (!room) return cb && cb({ ok: false, error: 'ไม่พบห้องของคุณ' });
    room.clearTimers();
    room.phase = PHASES.LOBBY;
    room.roundIndex = -1;
    room.roundPool = [];
    room.currentRound = null;
    for (const p of room.players.values()) {
      p.score = 0;
      p.lastRoundScore = null;
    }
    emitState(room);
    cb && cb({ ok: true });
  });

  socket.on('host:kick', ({ playerId } = {}, cb) => {
    const room = requireHostRoom(socket);
    if (!room) return cb && cb({ ok: false, error: 'ไม่พบห้องของคุณ' });
    const p = room.getPlayerById(playerId);
    if (p) {
      io.to(p.socketId).emit('you:kicked');
      room.removePlayer(playerId);
    }
    emitState(room);
    cb && cb({ ok: true });
  });

  socket.on('player:join', ({ code, name, role, existingId } = {}, cb) => {
    const room = manager.get(code);
    if (!room) return cb && cb({ ok: false, error: 'ไม่พบห้องนี้ ตรวจสอบรหัสห้องอีกครั้ง' });
    const player = room.addOrRejoinPlayer(socket.id, name, role, existingId);
    socket.join(room.code);
    socket.data.role = 'player';
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;

    cb && cb({
      ok: true,
      player: { id: player.id, name: player.name, role: player.role },
      state: room.publicState(),
    });
    emitState(room);

    if (room.phase === PHASES.LISTEN_RECORD && room.currentRound) {
      const soundEntry = room.currentRound.soundEntry;
      socket.emit('round:sound', {
        roundIndex: room.roundIndex,
        totalRounds: room.roundPool.length,
        soundName: soundEntry.name,
        soundUrl: soundUrlFor(soundEntry),
        durationMs: soundEntry.durationMs,
        recordMs: room.currentRound.recordMs,
        envelope: soundEntry.envelope,
        lateJoin: true,
      });
    }
  });

  // ผู้เล่น calibrate ไมค์ก่อนเริ่มเกม: อัดเสียง 2 คลิปสั้นๆ ส่งมาจริง (เงียบๆ 1 คลิป + พูดดังๆ 1 คลิป)
  // แล้ววิเคราะห์ด้วย pipeline เดียวกับตอนส่งคำตอบจริงระหว่างเกมทุกประการ (analyzeFile ตัวเดียวกัน) เพื่อให้ค่าที่วัดได้
  // อยู่ใน "สเกลเดียวกัน" กับที่จะใช้เทียบจริงตอนเล่น (ถ้าวัดด้วยวิธีอื่น เช่น Web Audio analyser สดๆ ในเบราว์เซอร์
  // ค่าจะไม่ตรงสเกลกับที่ ffmpeg ถอดรหัสได้ เพราะผ่านการเข้ารหัส/ประมวลผลเสียงคนละขั้นตอนกัน)
  socket.on('player:calibrate', async ({ silenceData, voiceData } = {}, cb) => {
    const room = manager.get(socket.data.roomCode);
    if (!room) return cb && cb({ ok: false, error: 'ไม่พบห้อง' });
    const player = room.getPlayerById(socket.data.playerId);
    if (!player) return cb && cb({ ok: false, error: 'ไม่พบผู้เล่น' });
    if (!silenceData || !voiceData) return cb && cb({ ok: false, error: 'ไม่มีข้อมูลเสียง' });

    const tag = `${player.id}_${Date.now()}`;
    const silencePath = path.join(UPLOADS_CALIBRATION_DIR, `${tag}_silence.webm`);
    const voicePath = path.join(UPLOADS_CALIBRATION_DIR, `${tag}_voice.webm`);
    try {
      fs.writeFileSync(silencePath, Buffer.isBuffer(silenceData) ? silenceData : Buffer.from(silenceData));
      fs.writeFileSync(voicePath, Buffer.isBuffer(voiceData) ? voiceData : Buffer.from(voiceData));
      const [silenceSig, voiceSig] = await Promise.all([analyzeFile(silencePath), analyzeFile(voicePath)]);
      player.silenceThreshold = calibratedSilenceThreshold(silenceSig.peakRaw, voiceSig.peakRaw);
      player.calibrated = true;
      cb && cb({ ok: true, threshold: player.silenceThreshold, noiseFloor: silenceSig.peakRaw, voicePeak: voiceSig.peakRaw });
    } catch (err) {
      cb && cb({ ok: false, error: 'วิเคราะห์เสียง calibrate ไม่สำเร็จ: ' + err.message });
    } finally {
      // ลบไฟล์ชั่วคราวทิ้งทันที ไม่ต้องเก็บไว้ (ต่างจาก take จริงที่เก็บไว้ให้ host เปิดฟังตอนเฉลยผล)
      try { fs.unlinkSync(silencePath); } catch { /* เพิกเฉย */ }
      try { fs.unlinkSync(voicePath); } catch { /* เพิกเฉย */ }
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = manager.get(code);
    if (!room) return;
    if (socket.data.role === 'host') {
      if (room.hostSocketId === socket.id) room.hostSocketId = null;
      return;
    }
    room.markDisconnected(socket.id);
    emitState(room);
    finishRoundIfReady(room);
  });
});

function printBanner() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log('='.repeat(60));
  console.log(' Mimic Party server กำลังทำงาน');
  console.log(` - บนเครื่องนี้ (HTTP):  http://localhost:${PORT}/host`);
  ips.forEach((ip) => console.log(` - ในวง LAN (HTTP):     http://${ip}:${PORT}/host`));
  if (httpsReady) {
    ips.forEach((ip) => console.log(` - ในวง LAN (HTTPS):    https://${ip}:${HTTPS_PORT}/host  ← ใช้ลิงก์นี้ให้ผู้เล่นเข้า (ต้องกดยอมรับใบรับรอง self-signed ครั้งแรก)`));
  } else {
    console.log(' - HTTPS ใช้งานไม่ได้: ผู้เล่นที่เข้าผ่าน LAN IP ด้วย http:// จะขอสิทธิ์ไมค์ไม่ได้ ให้ใช้ tunnel (ngrok/cloudflared) หรือ deploy จริงแทน');
  }
  console.log(' หมายเหตุ: ผู้เล่น (ไม่ใช่ observer) ต้องเข้าผ่านลิงก์ที่เป็น https:// หรือ localhost เท่านั้น เบราว์เซอร์ถึงจะอนุญาตใช้ไมโครโฟน');
  console.log('='.repeat(60));
}

server.listen(PORT, '0.0.0.0', () => {
  if (!httpsServer) printBanner();
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', printBanner);
}

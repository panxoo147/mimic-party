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
const { analyzeFile, scoreAgainstReference } = require('./audio');
const { RoomManager, PHASES } = require('./rooms');
const { getOrCreateCert } = require('./certs');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const ROOT = path.join(__dirname, '..');
const UPLOADS_TAKES_DIR = path.join(ROOT, 'uploads', 'takes');
fs.mkdirSync(UPLOADS_TAKES_DIR, { recursive: true });

const MIN_RECORD_MS = 3000;
const RECORD_BUFFER_MS = 1200;
const FORCE_FINISH_EXTRA_MS = 15000;
const REVEAL_MIN_GAP_MS = 1800;
const REVEAL_MAX_GAP_MS = 8000;
const ROUND_RESULT_AUTO_MS = 8000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7 });

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
app.use(express.static(path.join(ROOT, 'public')));
app.use('/media/sounds', express.static(soundLibrary.LOCAL_SOUNDS_DIR));
app.use('/media/cache', express.static(soundLibrary.CACHE_SOUNDS_DIR));
app.use('/media/takes', express.static(UPLOADS_TAKES_DIR));

app.get('/', (req, res) => res.redirect('/join'));
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
    const sig = await analyzeFile(filePath);
    if (room.phase !== PHASES.LISTEN_RECORD || room.roundIndex !== roundIndex) return;
    const soundEntry = room.currentRound.soundEntry;
    const { score, shapeScore, rhythmScore, melodyScore } = scoreAgainstReference(soundEntry, sig);
    room.currentRound.submissions.set(player.id, {
      url: `/media/takes/${filename}`,
      score,
      shapeScore,
      rhythmScore,
      melodyScore,
      durationMs: sig.durationMs,
      envelope: sig.envelope,
      name: player.name,
    });
    broadcastSubmitProgress(room, player);
    finishRoundIfReady(room);
  } catch (err) {
    console.error('[submit] วิเคราะห์เสียงล้มเหลว:', err.message);
    if (room.phase === PHASES.LISTEN_RECORD && room.roundIndex === roundIndex) {
      room.currentRound.submissions.set(player.id, {
        url: null, score: 0, shapeScore: 0, rhythmScore: 0, melodyScore: 0, envelope: null, name: player.name, failed: true,
      });
      broadcastSubmitProgress(room, player);
      finishRoundIfReady(room);
    }
  }
}

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
        url: null, score: 0, shapeScore: 0, rhythmScore: 0, melodyScore: 0, envelope: null, name: p.name, timedOut: true,
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
    timedOut: !!take.timedOut,
    failed: !!take.failed,
  });
  emitState(room);
  room.currentRound.revealPos += 1;
  const gap = take.durationMs
    ? Math.min(REVEAL_MAX_GAP_MS, take.durationMs + 1300)
    : REVEAL_MIN_GAP_MS;
  room.addTimer(() => scheduleNextReveal(room), gap);
}

function beginRoundResult(room) {
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

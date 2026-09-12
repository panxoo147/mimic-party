// server/rooms.js
// สถานะห้องเกมทั้งหมดอยู่ในหน่วยความจำ (in-memory) — เหมาะกับปาร์ตี้เกมที่เล่นจบในทีเดียว
// ผู้เล่นอ้างอิงด้วย "id" ที่คงที่ (เก็บไว้ใน localStorage ฝั่ง client) ส่วน socketId เปลี่ยนได้เวลาเน็ตหลุด/มือถือล็อกหน้าจอ

const { v4: uuidv4 } = require('uuid');

const PHASES = {
  LOBBY: 'LOBBY',
  LISTEN_RECORD: 'LISTEN_RECORD',
  REVEAL: 'REVEAL',
  ROUND_RESULT: 'ROUND_RESULT',
  GAME_OVER: 'GAME_OVER',
};

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ตัดตัวที่สับสนออก (I,O,0,1)
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

class Room {
  constructor(code, hostSocketId, hostToken) {
    this.code = code;
    this.hostSocketId = hostSocketId;
    this.hostToken = hostToken;
    this.players = new Map();     // id -> player object
    this.socketToId = new Map();  // socketId -> player id
    this.phase = PHASES.LOBBY;
    this.roundPool = [];          // sound entries ตามลำดับรอบของเกมนี้
    this.roundIndex = -1;
    this.currentRound = null;     // { soundEntry, submissions: Map(id -> {...}), revealQueue, revealPos }
    this.createdAt = Date.now();
    this.timers = [];
  }

  clearTimers() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  addTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    this.timers.push(t);
    return t;
  }

  addOrRejoinPlayer(socketId, name, role, existingId) {
    let player = existingId ? this.players.get(existingId) : null;
    if (player) {
      // เคยอยู่ในห้องนี้แล้ว (reconnect) — ผูก socket ใหม่ให้ id เดิม รักษาคะแนนไว้
      const oldSocketId = player.socketId;
      if (oldSocketId) this.socketToId.delete(oldSocketId);
      player.socketId = socketId;
      player.connected = true;
      if (name) player.name = name.slice(0, 24);
      if (role) player.role = role === 'observer' ? 'observer' : 'player';
      this.socketToId.set(socketId, player.id);
      return player;
    }
    const id = uuidv4();
    player = {
      id,
      socketId,
      name: (name || 'ผู้เล่น').slice(0, 24),
      role: role === 'observer' ? 'observer' : 'player',
      connected: true,
      score: 0,
      lastRoundScore: null,
      // ผลจาก calibrate ไมค์ (ถ้ายังไม่ได้ calibrate จะเป็น null แล้วใช้ค่ากลางของระบบแทนตอนวิเคราะห์เสียง)
      silenceThreshold: null,
      calibrated: false,
    };
    this.players.set(id, player);
    this.socketToId.set(socketId, id);
    return player;
  }

  getPlayerBySocket(socketId) {
    const id = this.socketToId.get(socketId);
    return id ? this.players.get(id) : null;
  }

  getPlayerById(id) {
    return this.players.get(id) || null;
  }

  markDisconnected(socketId) {
    const p = this.getPlayerBySocket(socketId);
    if (p) p.connected = false;
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p) this.socketToId.delete(p.socketId);
    this.players.delete(id);
  }

  activePlayers() {
    return [...this.players.values()].filter((p) => p.role === 'player' && p.connected);
  }

  allParticipants() {
    return [...this.players.values()];
  }

  publicState() {
    return {
      code: this.code,
      phase: this.phase,
      roundIndex: this.roundIndex,
      totalRounds: this.roundPool.length,
      currentSoundName:
        this.roundIndex >= 0 && this.roundPool[this.roundIndex]
          ? this.roundPool[this.roundIndex].name
          : null,
      players: this.allParticipants()
        .sort((a, b) => b.score - a.score)
        .map((p) => ({
          id: p.id,
          name: p.name,
          role: p.role,
          connected: p.connected,
          score: p.score,
          lastRoundScore: p.lastRoundScore,
        })),
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(hostSocketId) {
    let code;
    do {
      code = makeRoomCode();
    } while (this.rooms.has(code));
    const hostToken = uuidv4();
    const room = new Room(code, hostSocketId, hostToken);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  delete(code) {
    const room = this.rooms.get(code.toUpperCase());
    if (room) room.clearTimers();
    this.rooms.delete(code.toUpperCase());
  }
}

module.exports = { RoomManager, Room, PHASES };

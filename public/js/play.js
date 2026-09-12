// public/js/play.js — ตรรกะฝั่งผู้เล่น/ผู้ชม (มือถือ)
(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);

  let me = null; // {id, name, role}
  let roomCode = null;
  let mediaStream = null;
  let latestState = null;
  let currentRecorder = null;
  let currentReferenceEnvelope = null;

  // กราฟพลังเสียง 3 จุด: ตอนฟัง / ตอนอัด (มีเงาต้นฉบับให้ไล่ตาม) / ตอนเฉลยเทียบกัน
  const pListenWave = MimicWaveGraph.create($('pListenWaveGraph'));
  const pRecordWave = MimicWaveGraph.create($('pRecordWaveGraph'));
  const pRevealWave = MimicWaveGraph.create($('revealWaveGraph'));

  // สำหรับวัดระดับเสียงไมค์แบบสดๆ ระหว่างอัด (Web Audio API)
  let audioCtx = null;
  let analyser = null;
  let analyserData = null;
  function setupAnalyser() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserData = new Uint8Array(analyser.fftSize);
    } catch (err) {
      analyser = null; // เบราว์เซอร์บางตัวอาจไม่รองรับ ไม่เป็นไร ข้ามกราฟสดไป
    }
  }
  function readMicLevel() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(analyserData);
    let sum = 0;
    for (let i = 0; i < analyserData.length; i++) {
      const v = (analyserData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / analyserData.length) * 3.2); // ขยายสัญญาณให้เห็นชัดขึ้น
  }

  const views = ['join', 'waiting', 'play', 'reveal', 'roundresult', 'gameover'];
  function showView(name) {
    views.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== name));
  }
  function showPlayStage(name) {
    ['listen', 'record', 'sent', 'observe', 'late'].forEach((s) => $(`pStage${cap(s)}`).classList.toggle('hidden', s !== name));
  }
  function cap(s) { return s[0].toUpperCase() + s.slice(1); }

  function toast(msg, ms = 3500) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // เติมรหัสห้องจาก query string ?room=XXXX ถ้ามี (มาจากการสแกน QR)
  const params = new URLSearchParams(window.location.search);
  if (params.get('room')) $('roomCodeInput').value = params.get('room').toUpperCase();
  const savedName = localStorage.getItem('mp_name');
  if (savedName) $('nameInput').value = savedName;

  $('roomCodeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  async function requestMic() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setupAnalyser();
      $('micStatus').textContent = '🎙️ พร้อมใช้ไมค์แล้ว';
      $('retryMicBtn').style.display = 'none';
      return true;
    } catch (err) {
      $('micStatus').textContent = '⚠️ ไม่ได้รับอนุญาตใช้ไมค์ — จะฟังได้แต่เลียนแบบเสียงไม่ได้';
      $('retryMicBtn').style.display = 'inline-block';
      return false;
    }
  }
  $('retryMicBtn').addEventListener('click', requestMic);

  $('joinBtn').addEventListener('click', async () => {
    const code = $('roomCodeInput').value.trim().toUpperCase();
    const name = $('nameInput').value.trim() || 'ผู้เล่น';
    const role = document.querySelector('input[name=role]:checked').value;
    $('joinError').textContent = '';
    if (!code) { $('joinError').textContent = 'กรุณาใส่รหัสห้อง'; return; }
    localStorage.setItem('mp_name', name);

    const storageKey = `mp_player_${code}`;
    const existingId = localStorage.getItem(storageKey) || null;

    // ปลดล็อกการเล่นเสียงอัตโนมัติของเบราว์เซอร์ด้วยการโต้ตอบครั้งนี้
    const unlockAudio = new Audio();
    unlockAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    unlockAudio.play().catch(() => {});

    socket.emit('player:join', { code, name, role, existingId }, async (res) => {
      if (!res.ok) { $('joinError').textContent = res.error; return; }
      me = res.player;
      roomCode = code;
      localStorage.setItem(storageKey, me.id);
      $('myScoreBadge').classList.remove('hidden');
      if (me.role === 'player') {
        await requestMic();
      } else {
        $('micStatus').textContent = 'โหมดดูอย่างเดียว ไม่ต้องใช้ไมค์';
      }
      applyState(res.state);
    });
  });

  function renderPlayerList(container) {
    container.innerHTML = '';
    const players = latestState?.players || [];
    players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'player-row' + (p.connected ? '' : ' disconnected');
      const roleBadge = p.role === 'observer' ? '<span class="badge observer">👀</span>' : '<span class="badge player">🎤</span>';
      const youTag = me && p.id === me.id ? ' (คุณ)' : '';
      row.innerHTML = `<span class="name">${escapeHtml(p.name)}${youTag} ${roleBadge}</span><span class="score">${p.score}</span>`;
      container.appendChild(row);
    });
  }

  function applyState(state) {
    latestState = state;
    if (me) {
      const mine = state.players.find((p) => p.id === me.id);
      if (mine) $('myScore').textContent = mine.score;
    }
    if (!me) return; // ยังไม่ join

    if (state.phase === 'LOBBY') {
      showView('waiting');
      renderPlayerList($('waitingPlayerList'));
    } else if (state.phase === 'LISTEN_RECORD') {
      showView('play');
      $('pRoundIndex').textContent = state.roundIndex + 1;
      $('pTotalRounds').textContent = state.totalRounds;
    } else if (state.phase === 'REVEAL') {
      showView('reveal');
    } else if (state.phase === 'ROUND_RESULT') {
      showView('roundresult');
      renderRoundResultList();
    } else if (state.phase === 'GAME_OVER') {
      showView('gameover');
      renderGameOver();
    }
  }

  function renderRoundResultList() {
    const container = $('roundResultList');
    container.innerHTML = '';
    const players = [...(latestState?.players || [])].filter((p) => p.role === 'player');
    players.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'player-row' + (idx === 0 ? ' rank-1' : '') + (me && p.id === me.id ? '' : '');
      const delta = p.lastRoundScore != null ? ` <span class="muted small">(+${p.lastRoundScore})</span>` : '';
      const youTag = me && p.id === me.id ? ' (คุณ)' : '';
      row.innerHTML = `<span class="name">${escapeHtml(p.name)}${youTag}</span><span class="score">${p.score}${delta}</span>`;
      container.appendChild(row);
    });
  }

  function renderGameOver() {
    const players = [...(latestState?.players || [])].filter((p) => p.role === 'player').sort((a, b) => b.score - a.score);
    $('winnerText').textContent = players.length ? `🏆 ผู้ชนะ: ${players[0].name}` : '';
    const container = $('finalList');
    container.innerHTML = '';
    players.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'player-row' + (idx === 0 ? ' rank-1' : idx === 1 ? ' rank-2' : idx === 2 ? ' rank-3' : '');
      const youTag = me && p.id === me.id ? ' (คุณ)' : '';
      row.innerHTML = `<span class="name">#${idx + 1} ${escapeHtml(p.name)}${youTag}</span><span class="score">${p.score}</span>`;
      container.appendChild(row);
    });
  }

  socket.on('state:update', applyState);
  socket.on('you:kicked', () => { $('kickedOverlay').classList.remove('hidden'); });

  socket.on('round:sound', (data) => {
    showView('play');
    $('pRoundIndex').textContent = data.roundIndex + 1;
    $('pTotalRounds').textContent = data.totalRounds;

    if (!me) return;

    if (data.lateJoin) {
      showPlayStage('late');
      return;
    }
    if (me.role === 'observer') {
      showPlayStage('observe');
      const audio = new Audio(data.soundUrl);
      audio.play().catch(() => {});
      return;
    }

    showPlayStage('listen');
    currentReferenceEnvelope = data.envelope || null;
    pListenWave.setGhost(currentReferenceEnvelope);
    const audio = new Audio(data.soundUrl);
    let started = false;
    const startRec = () => {
      if (started) return;
      started = true;
      beginRecording(data.recordMs, data.roundIndex);
    };
    audio.addEventListener('ended', startRec);
    audio.addEventListener('error', () => setTimeout(startRec, 300));
    audio.play().catch(() => setTimeout(startRec, Math.max(500, data.durationMs)));
    // เผื่อไฟล์เสียงโหลดช้า/ค้าง ตั้ง timeout สำรอง
    setTimeout(startRec, data.durationMs + 4000);
  });

  function beginRecording(recordMs, roundIndex) {
    if (!mediaStream) {
      // ไม่มีไมค์ (โดนปฏิเสธสิทธิ์) — ข้ามไปสถานะส่งแล้วเลย เพื่อไม่ให้ค้าง
      showPlayStage('sent');
      return;
    }
    showPlayStage('record');
    pRecordWave.setGhost(currentReferenceEnvelope);
    pRecordWave.reset();
    const chunks = [];
    let mimeType = 'audio/webm';
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = '';
    }
    try {
      currentRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
    } catch {
      currentRecorder = new MediaRecorder(mediaStream);
    }
    currentRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    currentRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: currentRecorder.mimeType || 'audio/webm' });
      uploadTake(blob, roundIndex);
    };
    currentRecorder.start();

    const startedAt = Date.now();
    $('pRecordFill').style.width = '0%';
    const timerInterval = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const pct = Math.min(100, (elapsed / recordMs) * 100);
      $('pRecordFill').style.width = pct + '%';
      $('pRecordTimer').textContent = `${Math.max(0, ((recordMs - elapsed) / 1000)).toFixed(1)} วิ`;
      if (elapsed >= recordMs) clearInterval(timerInterval);
    }, 100);

    // อัปเดตกราฟพลังเสียงสดๆ ให้เห็นว่าตัวเองพูดดัง-เบายังไง เทียบกับเงาต้นฉบับด้านหลัง
    const barCount = MimicWaveGraph.BAR_COUNT;
    const waveInterval = setInterval(() => {
      pRecordWave.pushLive(readMicLevel());
    }, Math.max(30, recordMs / barCount));

    setTimeout(() => {
      clearInterval(timerInterval);
      clearInterval(waveInterval);
      if (currentRecorder && currentRecorder.state !== 'inactive') currentRecorder.stop();
    }, recordMs);
  }

  function uploadTake(blob, roundIndex) {
    showPlayStage('sent');
    const form = new FormData();
    form.append('playerId', me.id);
    form.append('roundIndex', String(roundIndex));
    form.append('audio', blob, 'take.webm');
    fetch(`/api/rooms/${roomCode}/submit`, { method: 'POST', body: form })
      .then((r) => r.json())
      .then((res) => { if (!res.ok && res.error !== 'stale_round') toast('ส่งเสียงไม่สำเร็จ: ' + res.error); })
      .catch(() => toast('ส่งเสียงไม่สำเร็จ (เน็ตหลุด?)'));
  }

  socket.on('round:reveal_take', (data) => {
    showView('reveal');
    $('revealPos').textContent = data.index + 1;
    $('revealTotal').textContent = data.total;
    $('revealName').textContent = data.timedOut ? `${data.name} (หมดเวลา ⏱️)` : `🎙️ ${data.name}${data.silent ? ' 🔇 (ไม่มีเสียงพูด)' : ''}`;
    $('revealYouTag').classList.toggle('hidden', !(me && data.playerId === me.id));
    $('revealScoreWrap').classList.add('hidden');
    pRevealWave.setGhost(data.referenceEnvelope);
    pRevealWave.reset();
    if (data.url) {
      const audio = new Audio(data.url);
      audio.play().catch(() => {});
    }
    setTimeout(() => {
      $('revealScore').textContent = data.score;
      $('revealShape').textContent = data.shapeScore;
      $('revealRhythm').textContent = data.rhythmScore;
      $('revealMelody').textContent = data.melodyScore;
      $('revealScoreWrap').classList.remove('hidden');
      // ไม่มีเสียงพูดจริงๆ ก็ไม่โชว์กราฟที่ normalize มาแล้ว (จะดูเหมือนมีคนพูดทั้งที่ไม่มี)
      pRevealWave.setLive(data.silent ? null : data.envelope);
    }, data.url ? 1200 : 400);
  });

  socket.on('round:result', () => {
    showView('roundresult');
    renderRoundResultList();
  });

  socket.on('game:over', () => {
    showView('gameover');
    renderGameOver();
  });

  socket.on('connect', () => {
    if (roomCode && me) {
      const storageKey = `mp_player_${roomCode}`;
      socket.emit('player:join', { code: roomCode, name: me.name, role: me.role, existingId: localStorage.getItem(storageKey) }, (res) => {
        if (res.ok) applyState(res.state);
      });
    }
  });

  // แจ้งเซิร์ฟเวอร์ทันทีตอนกำลังปิดหน้าเว็บ/แท็บ (แทนที่จะปล่อยให้ socket.io ต้องรอตรวจจับการหลุดการเชื่อมต่อเอง
  // ซึ่งอาจช้าถึงหลักสิบวินาที โดยเฉพาะตอนปิดแอป/สลับแอปบนมือถือ) ใช้ sendBeacon เพราะทำงานได้แม้หน้าเว็บกำลังจะปิดไปแล้ว
  function notifyLeaving() {
    if (!roomCode || !me || !navigator.sendBeacon) return;
    try {
      const blob = new Blob([JSON.stringify({ playerId: me.id })], { type: 'application/json' });
      navigator.sendBeacon(`/api/rooms/${roomCode}/leave`, blob);
    } catch {
      // เพิกเฉย ปล่อยให้ socket.io ตรวจจับการหลุดการเชื่อมต่อตามปกติแทน
    }
  }
  window.addEventListener('pagehide', notifyLeaving);
})();

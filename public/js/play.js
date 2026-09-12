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

  // เสียงที่กำลังเล่นอยู่ตอนนี้ (เสียงต้นฉบับ/เสียงตอนเฉลยผล) — เก็บ reference เดียวไว้กลาง เพื่อหยุดของเก่า
  // ก่อนเล่นของใหม่เสมอ กันเสียงซ้อนกัน (เช่น round:sound ยิงซ้ำ หรือ reveal_take รอบถัดไปมาเร็วกว่าเสียงก่อนหน้าจะเล่นจบ)
  let activeAudio = null;
  function stopActiveAudio() {
    if (activeAudio) {
      try { activeAudio.pause(); } catch { /* เพิกเฉย */ }
      try { activeAudio.src = ''; } catch { /* เพิกเฉย */ }
      activeAudio = null;
    }
  }

  // กราฟพลังเสียง 3 จุด: ตอนฟัง / ตอนอัด (มีเงาต้นฉบับให้ไล่ตาม) / ตอนเฉลยเทียบกัน
  // (เอากราฟตอนอัดกลับมาอีกครั้ง หลังแก้ 2 จุดที่เคยทำให้ไม่ตรงกับเงาต้นฉบับ: (1) กราฟเคยขับด้วย recordMs
  // ทั้งที่เงาอิงแค่ durationMs ของเสียงต้นฉบับ ทำให้เสียงสั้นๆ กราฟเติมได้แค่บางส่วนแล้วค้างว่างยาวๆ — ตอนนี้
  // ขับด้วย durationMs เหมือนเงาแล้ว (ดู graphMs ใน beginRecording), (2) ระดับไมค์สดเคยใช้สเกลตายตัวทำให้ดูเบา
  // กว่าความเป็นจริงเทียบกับกราฟ normalize หลังวิเคราะห์ — ตอนนี้ wavegraph.js normalize เทียบค่าดังสุดที่เจอเองแล้ว)
  const pListenWave = MimicWaveGraph.create($('pListenWaveGraph'));
  const pRecordWave = MimicWaveGraph.create($('pRecordWaveGraph'));
  const pSentWave = MimicWaveGraph.create($('pSentWaveGraph'));
  const pRevealWave = MimicWaveGraph.create($('revealWaveGraph'));

  // สำหรับวัดระดับเสียงไมค์แบบสดๆ ระหว่างอัด (Web Audio API) — ใช้เฉพาะขับกราฟสด ไม่เกี่ยวกับไฟล์เสียงที่อัปโหลดจริง
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
    // หมายเหตุ: ไม่ clamp ที่ 1 เพราะกราฟฝั่ง advanceTo() จะ normalize เทียบกับค่าสูงสุดที่เจอเองระหว่างอัด
    // (เหมือนวิธีที่ server normalize กราฟหลังวิเคราะห์) ถ้า clamp ไว้ที่นี่ก่อน จะทำให้เสียงที่ไม่ถึงเพดานดูเตี้ยกว่าความเป็นจริง
    return Math.sqrt(sum / analyserData.length) * 3.2;
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
  $('retryMicBtn').addEventListener('click', async () => {
    const gotMic = await requestMic();
    if (gotMic && me && me.role === 'player') $('calibrateCard').classList.remove('hidden');
  });

  // ---------- ปรับเทียบไมค์ (calibrate) ----------
  // อัดคลิปสั้นๆ 2 ช่วง (เงียบๆ / พูดดังๆ) ด้วย MediaRecorder ตัวเดียวกับที่ใช้อัดคำตอบจริงตอนเล่นเกม
  // แล้วส่งไฟล์จริงไปให้ server วิเคราะห์ด้วย pipeline เดียวกับตอนส่งคำตอบ (ffmpeg → RMS) เพื่อให้ค่าที่วัดได้
  // อยู่ในสเกลเดียวกับที่จะถูกใช้เทียบจริงตอนเล่น — ถ้าวัดด้วยวิธีอื่น (เช่น Web Audio analyser สดในเบราว์เซอร์)
  // ค่าจะไม่ตรงสเกลกับที่ ffmpeg ถอดรหัสไฟล์ที่บันทึกจริงได้ เพราะผ่านการเข้ารหัส/ประมวลผลคนละขั้นตอนกัน
  const CALIBRATE_PHASE_MS = 1500;
  let calibrating = false;

  function recordClip(ms) {
    return new Promise((resolve, reject) => {
      if (!mediaStream) { reject(new Error('ไม่มีไมค์')); return; }
      const chunks = [];
      let mimeType = 'audio/webm';
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
      let rec;
      try { rec = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream); }
      catch (err) { reject(err); return; }
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      rec.onerror = (e) => reject((e && e.error) || new Error('อัดเสียงไม่สำเร็จ'));
      rec.start();
      setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, ms);
    });
  }

  function animateCalibrateFill(ms) {
    const fill = $('calibrateFill');
    fill.style.transition = 'none';
    fill.style.width = '0%';
    // บังคับ reflow ก่อน ไม่งั้นเบราว์เซอร์อาจรวมสอง style เข้าด้วยกันจนไม่มี transition ให้เห็นตอนเริ่มแท่งใหม่
    void fill.offsetWidth;
    fill.style.transition = `width ${ms}ms linear`;
    fill.style.width = '100%';
  }

  function setCalibrateStage(stage) {
    $('calibrateIdle').classList.toggle('hidden', stage !== 'idle');
    $('calibrateRunning').classList.toggle('hidden', stage !== 'running');
    $('calibrateDone').classList.toggle('hidden', stage !== 'done');
  }

  async function runCalibration() {
    if (calibrating || !mediaStream) return;
    calibrating = true;
    $('calibrateError').classList.add('hidden');
    setCalibrateStage('running');
    try {
      $('calibrateStepText').textContent = 'อยู่เงียบๆ ก่อนนะ... 🤫';
      $('calibratePulse').textContent = '🤫';
      animateCalibrateFill(CALIBRATE_PHASE_MS);
      const silenceBlob = await recordClip(CALIBRATE_PHASE_MS);

      $('calibrateStepText').textContent = 'พูดออกมาดังๆ เลย! 🗣️';
      $('calibratePulse').textContent = '🗣️';
      animateCalibrateFill(CALIBRATE_PHASE_MS);
      const voiceBlob = await recordClip(CALIBRATE_PHASE_MS);

      $('calibrateStepText').textContent = 'กำลังประมวลผล...';
      const [silenceData, voiceData] = await Promise.all([silenceBlob.arrayBuffer(), voiceBlob.arrayBuffer()]);

      const res = await new Promise((resolve) => {
        socket.emit('player:calibrate', { silenceData, voiceData }, (r) => resolve(r || { ok: false, error: 'ไม่ได้รับคำตอบจากเซิร์ฟเวอร์' }));
      });

      if (res.ok) {
        setCalibrateStage('done');
      } else {
        setCalibrateStage('idle');
        $('calibrateError').textContent = 'ปรับเทียบไม่สำเร็จ: ' + (res.error || 'ไม่ทราบสาเหตุ');
        $('calibrateError').classList.remove('hidden');
      }
    } catch (err) {
      setCalibrateStage('idle');
      $('calibrateError').textContent = 'เกิดข้อผิดพลาด: ' + err.message;
      $('calibrateError').classList.remove('hidden');
    } finally {
      calibrating = false;
    }
  }

  $('startCalibrateBtn').addEventListener('click', runCalibration);
  $('recalibrateBtn').addEventListener('click', () => setCalibrateStage('idle'));

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
        const gotMic = await requestMic();
        // มีไมค์แล้วค่อยโชว์การ์ด calibrate — คนที่ไม่ได้อนุญาตไมค์ไว้ตั้งแต่แรกจะยังไม่เห็น จนกว่าจะกด "ขออนุญาตใช้ไมค์อีกครั้ง" สำเร็จ
        if (gotMic) $('calibrateCard').classList.remove('hidden');
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
      stopActiveAudio();
      const audio = new Audio(data.soundUrl);
      activeAudio = audio;
      audio.play().catch(() => {});
      return;
    }

    showPlayStage('listen');
    currentReferenceEnvelope = data.envelope || null;
    pListenWave.setGhost(currentReferenceEnvelope);
    stopActiveAudio();
    const audio = new Audio(data.soundUrl);
    activeAudio = audio;
    let started = false;
    const startRec = () => {
      if (started) return;
      started = true;
      beginRecording(data.recordMs, data.durationMs, data.roundIndex);
    };
    audio.addEventListener('ended', startRec);
    audio.addEventListener('error', () => setTimeout(startRec, 300));
    audio.play().catch(() => setTimeout(startRec, Math.max(500, data.durationMs)));
    // เผื่อไฟล์เสียงโหลดช้า/ค้าง ตั้ง timeout สำรอง
    setTimeout(startRec, data.durationMs + 4000);
  });

  function beginRecording(recordMs, durationMs, roundIndex) {
    // กันเผื่อเสียงต้นฉบับยังเล่นค้างอยู่ (เช่น timeout สำรองสั่งเริ่มอัดไปแล้ว แต่ play() ที่ล้มเหลวก่อนหน้าดันเล่นสำเร็จขึ้นมาทีหลัง)
    // ไม่ให้เสียงต้นฉบับไปปนกับที่ไมค์กำลังอัดอยู่
    stopActiveAudio();
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

    // จุดสำคัญ (แก้ปัญหา "สองเส้นไม่สอดคล้องกัน" ที่ผู้ใช้เจอ): เดิมกราฟคลื่นเสียง (บน) ขับด้วย durationMs
    // (ความยาวเสียงต้นฉบับ) แต่แถบนับถอยหลัง/เวลา (ล่าง) ขับด้วย recordMs (เวลาอัดทั้งหมด ซึ่งมีเวลาขั้นต่ำ 3 วิ
    // + เผื่อพูดจบท้ายเสียงบวกเพิ่มเข้าไปอีก จึงยาวกว่า durationMs มาก โดยเฉพาะเสียงสั้นๆ) ทำให้สองเส้นนี้วิ่งเร็วช้า
    // ไม่เท่ากันชัดเจน (กราฟคลื่นเติมเต็มไปนานแล้ว ทั้งที่แถบเวลาด้านล่างเพิ่งเดินไปได้ไม่ถึงครึ่ง) ดูเหมือนขัดแย้งกันเอง
    // ทั้งที่ตัวเลข durationMs เองแม่นอยู่แล้ว (ทดสอบเทียบกับเวลาเล่นจริงในเบราว์เซอร์แล้ว คลาดเคลื่อนแค่ระดับ ~0.03 วิ)
    //
    // แก้โดยให้ทั้งคู่ขับด้วยเวลาเดียวกันเป๊ะๆ คือ graphMs (อิง durationMs ไม่ใช่ recordMs เพราะถ้าใช้ recordMs
    // ขับกราฟ เสียงสั้นๆ จะทำให้กราฟเงาต้นฉบับดูยืด/บีบผิดสัดส่วนไปอีกแบบ) พอถึง graphMs ทั้งกราฟคลื่นและแถบเวลา
    // จะเต็ม/หมดเวลาพร้อมกันเป๊ะ ส่วนเวลาที่เหลือจนกว่าจะครบ recordMs จริง (buffer เผื่อพูดจบท้ายเสียง) ปล่อยให้ไมค์
    // อัดต่อเงียบๆ อยู่เบื้องหลังโดยไม่ต้องโชว์อะไรเพิ่ม (ทั้งสองแถบค้างเต็ม/0.0 วิ รอจนกว่าจะอัดจบจริง)
    //
    // เพิ่ม LEAD_IN_MS: หน่วงทั้งกราฟและแถบเวลาไม่ให้เริ่มขยับทันทีตอนเริ่มอัด เผื่อเวลาตั้งตัว/หายใจสั้นๆ ก่อนเริ่ม
    // พูดเลียนแบบจริง (ไม่งั้นต่อให้ตัวเลขแม่น ก็ยังรู้สึกว่ากราฟ "วิ่งเร็วกว่า" เพราะขยับไปก่อนที่จะเริ่มพูดจริง)
    const barCount = MimicWaveGraph.BAR_COUNT;
    const graphMs = Math.min(recordMs, Math.max(300, durationMs || recordMs));
    const LEAD_IN_MS = Math.min(300, Math.max(0, graphMs - 300));

    const startedAt = Date.now();
    $('pRecordFill').style.width = '0%';
    const timerInterval = setInterval(() => {
      const totalElapsed = Date.now() - startedAt;
      const graphElapsed = Math.max(0, totalElapsed - LEAD_IN_MS);
      const pct = Math.min(100, (graphElapsed / graphMs) * 100);
      $('pRecordFill').style.width = pct + '%';
      $('pRecordTimer').textContent = `${Math.max(0, ((graphMs - graphElapsed) / 1000)).toFixed(1)} วิ`;
      if (totalElapsed >= recordMs) clearInterval(timerInterval);
    }, 100);

    // อัปเดตกราฟพลังเสียงสดๆ ให้เห็นว่าตัวเองพูดดัง-เบายังไง เทียบกับเงาต้นฉบับด้านหลัง ใช้ "สัดส่วนเวลาจริงที่ผ่านไปแล้ว"
    // ขับกราฟ (แทนการนับจำนวนครั้งที่ setInterval ทำงาน) เพราะถ้านับจำนวนครั้งเฉยๆ พอ setInterval โดนเบราว์เซอร์หน่วง
    // (เช่นแท็บถูกลดความสำคัญ/เครื่องมีงานอื่นแทรก) กราฟจะเติมไม่ทันเวลาอัดจริงหมดไปแล้ว ค้างเติมได้แค่บางส่วน
    const waveInterval = setInterval(() => {
      const graphElapsed = (Date.now() - startedAt) - LEAD_IN_MS;
      if (graphElapsed < 0) return; // ยังอยู่ในช่วงหน่วงตั้งตัว กราฟยังไม่ต้องขยับ
      pRecordWave.advanceTo(graphElapsed / graphMs, readMicLevel());
    }, Math.max(30, graphMs / barCount));

    setTimeout(() => {
      clearInterval(timerInterval);
      clearInterval(waveInterval);
      $('pRecordFill').style.width = '100%';
      $('pRecordTimer').textContent = '0.0 วิ';
      pRecordWave.advanceTo(1, readMicLevel()); // กันเผื่อ tick สุดท้ายไม่ทัน ให้กราฟเติมเต็มเส้นเสมอตอนอัดจบจริง
      if (currentRecorder && currentRecorder.state !== 'inactive') currentRecorder.stop();
    }, recordMs);
  }

  function uploadTake(blob, roundIndex) {
    showPlayStage('sent');
    // เพิ่งอัปโหลด ยังไม่มีผลวิเคราะห์จริงกลับมา — โชว์แค่เงาต้นฉบับไปก่อน รอ 'take:analyzed' มาเติมเส้นจริง
    pSentWave.setGhost(currentReferenceEnvelope);
    pSentWave.reset();
    const form = new FormData();
    form.append('playerId', me.id);
    form.append('roundIndex', String(roundIndex));
    form.append('audio', blob, 'take.webm');
    fetch(`/api/rooms/${roomCode}/submit`, { method: 'POST', body: form })
      .then((r) => r.json())
      .then((res) => { if (!res.ok && res.error !== 'stale_round') toast('ส่งเสียงไม่สำเร็จ: ' + res.error); })
      .catch(() => toast('ส่งเสียงไม่สำเร็จ (เน็ตหลุด?)'));
  }

  // ผลวิเคราะห์เสียงจริงจาก server (envelope ชุดเดียวกับที่ตอนเฉลยผลจะโชว์ เป๊ะๆ ไม่ใช่ค่าประมาณ) — มาถึงเร็วกว่า
  // ตอนเฉลยผลของรอบมาก (ไม่ต้องรอคิวเฉลยทีละคน) เลยเอามาโชว์แทนกราฟประมาณสดตอนอัดได้เลยที่หน้า "ส่งเสียงแล้ว"
  // รับประกันว่ารูปคลื่นที่เห็นตรงนี้จะตรงกับตอนเฉลยผล 100% เพราะเป็นข้อมูลชุดเดียวกัน
  socket.on('take:analyzed', (data) => {
    pSentWave.setLive(data.silent || data.failed ? null : data.envelope);
  });

  socket.on('round:reveal_take', (data) => {
    showView('reveal');
    $('revealPos').textContent = data.index + 1;
    $('revealTotal').textContent = data.total;
    $('revealName').textContent = data.timedOut ? `${data.name} (หมดเวลา ⏱️)` : `🎙️ ${data.name}${data.silent ? ' 🔇 (ไม่มีเสียงพูด)' : ''}`;
    $('revealYouTag').classList.toggle('hidden', !(me && data.playerId === me.id));
    $('revealScoreWrap').classList.add('hidden');
    pRevealWave.setGhost(data.referenceEnvelope);
    pRevealWave.reset();
    stopActiveAudio(); // หยุดเสียงเฉลยของคนก่อนหน้าก่อนเสมอ กันเสียงซ้อนกันตอนเปลี่ยนไปเฉลยคนถัดไปเร็วกว่าเสียงเดิมเล่นจบ
    if (data.url) {
      const audio = new Audio(data.url);
      activeAudio = audio;
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

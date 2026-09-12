// public/js/host.js — ตรรกะฝั่งจอ Host
(() => {
  const socket = io();
  let roomCode = null;
  let hostToken = null;
  let latestState = null;
  let selectedIds = new Set();
  let libraryList = [];
  let currentTab = 'local';
  let roundResultTimer = null;
  let networkInfo = null;
  let lrWave = null;
  let revealWave = null;

  const $ = (id) => document.getElementById(id);
  const views = ['lobby', 'listen', 'reveal', 'roundresult', 'gameover'];

  function showView(name) {
    views.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== name));
  }

  function toast(msg, ms = 3500) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ---------- tap gate (ปลดล็อกการเล่นเสียงอัตโนมัติของเบราว์เซอร์) ----------
  $('tapGateBtn').addEventListener('click', () => {
    const a = new Audio();
    a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    a.play().catch(() => {});
    $('tapGate').classList.add('hidden');
    $('app').classList.remove('hidden');
    lrWave = MimicWaveGraph.create($('lrWaveGraph'));
    revealWave = MimicWaveGraph.create($('revealWaveGraph'));
    init();
  });

  function computeJoinUrl() {
    const override = localStorage.getItem('mp_public_url');
    if (override && override.trim()) {
      return `${override.trim().replace(/\/$/, '')}/join?room=${roomCode}`;
    }
    // เบราว์เซอร์จะไม่อนุญาตขอสิทธิ์ไมค์ถ้าเข้าผ่าน http:// ธรรมดาบน IP วง LAN (ไม่ใช่ secure context)
    // ถ้าหน้านี้เปิดผ่าน http:// อยู่ (ไม่ใช่ localhost) ให้เปลี่ยนลิงก์ผู้เล่นเป็น https พอร์ตของ LAN แทน
    if (window.location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname) && networkInfo && networkInfo.httpsReady) {
      return `https://${window.location.hostname}:${networkInfo.httpsPort}/join?room=${roomCode}`;
    }
    return `${window.location.origin}/join?room=${roomCode}`;
  }

  let currentJoinUrl = null;
  function refreshQr() {
    if (!roomCode) return;
    currentJoinUrl = computeJoinUrl();
    $('qrImg').src = `/api/qrcode?text=${encodeURIComponent(currentJoinUrl)}`;
    $('joinLinkText').textContent = currentJoinUrl;
    $('joinLinkText').href = currentJoinUrl;
    if (!$('qrModal').classList.contains('hidden')) openQrModal(); // อัปเดตรูปในโมดัลด้วยถ้าเปิดค้างอยู่
  }

  function openQrModal() {
    if (!currentJoinUrl) return;
    $('qrModalImg').src = `/api/qrcode?text=${encodeURIComponent(currentJoinUrl)}&size=640`;
    $('qrModalCode').textContent = roomCode || '----';
    $('qrModal').classList.remove('hidden');
  }
  function closeQrModal() {
    $('qrModal').classList.add('hidden');
  }
  $('qrWrap').addEventListener('click', openQrModal);
  $('qrWrap').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQrModal(); }
  });
  $('qrModal').addEventListener('click', closeQrModal);

  $('usePublicUrlBtn').addEventListener('click', () => {
    const v = $('publicUrlInput').value.trim();
    if (v) localStorage.setItem('mp_public_url', v);
    else localStorage.removeItem('mp_public_url');
    refreshQr();
  });

  function setPublicUrlSectionOpen(open) {
    $('publicUrlSection').classList.toggle('hidden', !open);
    $('togglePublicUrlBtn').textContent = open ? '🔼 ซ่อนส่วนนี้' : '🌐 ลิงก์เล่นนอกบ้าน (ถ้าต้องการ)';
    localStorage.setItem('mp_publicurl_open', open ? '1' : '0');
  }
  $('togglePublicUrlBtn').addEventListener('click', () => {
    setPublicUrlSectionOpen($('publicUrlSection').classList.contains('hidden'));
  });

  function checkLanHint() {
    fetch('/api/network-info').then((r) => r.json()).then((info) => {
      networkInfo = info;
      const ip = (info.lanIps && info.lanIps[0]) || null;
      const isLocalhost = /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
      let msg = '';
      if (isLocalhost && ip) {
        msg += `⚠️ ตอนนี้เปิดผ่าน localhost ผู้เล่นจากมือถือจะสแกน QR เข้าไม่ได้ ให้เปิดหน้านี้ผ่าน `;
        msg += info.httpsReady
          ? `<a href="https://${ip}:${info.httpsPort}/host">https://${ip}:${info.httpsPort}/host</a> `
          : `<a href="http://${ip}:${info.port}/host">http://${ip}:${info.port}/host</a> `;
        msg += `แทน (ต่อ WiFi วงเดียวกัน)<br>`;
      }
      msg += info.httpsReady
        ? `🔒 ลิงก์เข้าร่วมด้านบนใช้ HTTPS แล้ว (จำเป็นสำหรับเบราว์เซอร์ถึงจะขอสิทธิ์ไมค์ได้) — เบราว์เซอร์ของผู้เล่นอาจเตือนว่าใบรับรองไม่น่าเชื่อถือ ให้กด "Advanced" แล้ว "Proceed anyway" ได้เลย เพราะเราออกใบรับรองเองสำหรับเล่นในวง LAN`
        : `⚠️ เซิร์ฟเวอร์นี้เปิด HTTPS ไม่สำเร็จ ผู้เล่น (ที่ไม่ใช่ observer) อาจขอสิทธิ์ไมค์ผ่าน LAN ไม่ได้ — แนะนำใส่ลิงก์สาธารณะจาก ngrok/cloudflared ด้านบนแทน (ดู README)`;
      $('lanHint').innerHTML = msg;
      refreshQr();
    }).catch(() => {});
  }

  // ---------- ห้อง ----------
  function init() {
    const saved = JSON.parse(localStorage.getItem('mp_host') || 'null');
    const publicUrlSaved = localStorage.getItem('mp_public_url');
    if (publicUrlSaved) $('publicUrlInput').value = publicUrlSaved;
    const openSaved = localStorage.getItem('mp_publicurl_open');
    setPublicUrlSectionOpen(openSaved === '1' || (openSaved === null && !!publicUrlSaved));

    if (saved && saved.code && saved.hostToken) {
      socket.emit('host:rejoin_room', { code: saved.code, hostToken: saved.hostToken }, (res) => {
        if (res.ok) {
          roomCode = saved.code;
          hostToken = saved.hostToken;
          onRoomReady(res.state);
        } else {
          createRoom();
        }
      });
    } else {
      createRoom();
    }
  }

  function createRoom() {
    socket.emit('host:create_room', {}, (res) => {
      if (!res.ok) { toast('สร้างห้องไม่สำเร็จ'); return; }
      roomCode = res.code;
      hostToken = res.hostToken;
      localStorage.setItem('mp_host', JSON.stringify({ code: roomCode, hostToken }));
      onRoomReady(res.state);
    });
  }

  function onRoomReady(state) {
    $('roomCode').textContent = roomCode;
    $('roomBadgeCode').textContent = roomCode;
    $('roomBadge').classList.remove('hidden');
    refreshQr();
    checkLanHint();
    loadLibrary();
    applyState(state);
  }

  // ---------- คลังเสียง ----------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $('tab-local').classList.toggle('hidden', currentTab !== 'local');
      $('tab-myinstants').classList.toggle('hidden', currentTab !== 'myinstants');
    });
  });

  function loadLibrary() {
    socket.emit('host:list_library', {}, (res) => {
      if (res.ok) {
        libraryList = res.list;
        renderLibrary();
      } else {
        toast('โหลดคลังเสียงล้มเหลว: ' + res.error);
      }
    });
  }

  $('refreshLibraryBtn').addEventListener('click', loadLibrary);

  $('addMyinstantsBtn').addEventListener('click', () => {
    const url = $('myinstantsUrl').value.trim();
    if (!url) return;
    $('myinstantsStatus').textContent = 'กำลังดึงเสียง...';
    socket.emit('host:add_myinstants', { url }, (res) => {
      if (res.ok) {
        $('myinstantsStatus').textContent = `เพิ่ม "${res.entry.name}" แล้ว ✅`;
        $('myinstantsUrl').value = '';
        selectedIds.add(res.entry.id);
        loadLibrary();
      } else {
        $('myinstantsStatus').textContent = '❌ ' + res.error;
      }
    });
  });

  function fmtDuration(ms) {
    const s = (ms / 1000).toFixed(1);
    return `${s}s`;
  }

  function renderLibrary() {
    const list = $('soundList');
    list.innerHTML = '';
    if (libraryList.length === 0) {
      list.innerHTML = '<div class="muted small">ยังไม่มีเสียงในคลัง ลองวางไฟล์ลง assets/sounds หรือดึงจาก myinstants.com</div>';
      return;
    }
    libraryList.forEach((entry) => {
      const el = document.createElement('div');
      el.className = 'sound-item' + (selectedIds.has(entry.id) ? ' selected' : '');
      el.innerHTML = `
        <input type="checkbox" ${selectedIds.has(entry.id) ? 'checked' : ''} style="width:20px;height:20px;">
        <div class="meta">
          <div class="name">${escapeHtml(entry.name)}</div>
          <div class="src">${entry.source === 'local' ? '📁 ไฟล์ในเครื่อง' : '🔗 myinstants.com'} · ${fmtDuration(entry.durationMs)}</div>
        </div>
        <audio controls preload="none" src="${entry.source === 'local' ? '/media/sounds/' : '/media/cache/'}${encodeURIComponent(basename(entry.relPath))}" style="height:32px; max-width:140px;"></audio>
        ${entry.source === 'myinstants' ? '<button class="btn ghost small" data-remove="' + entry.id + '">ลบ</button>' : ''}
      `;
      const cb = el.querySelector('input[type=checkbox]');
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(entry.id); else selectedIds.delete(entry.id);
        el.classList.toggle('selected', cb.checked);
      });
      const rmBtn = el.querySelector('[data-remove]');
      if (rmBtn) {
        rmBtn.addEventListener('click', () => {
          socket.emit('host:remove_sound', { id: entry.id }, () => { selectedIds.delete(entry.id); loadLibrary(); });
        });
      }
      list.appendChild(el);
    });
  }

  function basename(p) { return p.split('/').pop(); }
  function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ---------- เริ่มเกม ----------
  $('startGameBtn').addEventListener('click', () => {
    $('setupError').textContent = '';
    const rounds = parseInt($('roundsInput').value, 10) || 1;
    const shuffle = $('shuffleInput').checked;
    if (selectedIds.size === 0) {
      $('setupError').textContent = 'กรุณาเลือกเสียงอย่างน้อย 1 เสียงจากคลัง';
      return;
    }
    socket.emit('host:set_pool', { soundIds: [...selectedIds], rounds, shuffle }, (res) => {
      if (!res.ok) { $('setupError').textContent = res.error; return; }
      socket.emit('host:start_game', {}, (res2) => {
        if (!res2.ok) $('setupError').textContent = res2.error;
      });
    });
  });

  // ---------- state ----------
  function renderPlayerList(container, opts = {}) {
    container.innerHTML = '';
    const players = (latestState?.players || []);
    if (players.length === 0) {
      container.innerHTML = '<div class="muted small">ยังไม่มีใครเข้าร่วม — ให้เพื่อนสแกน QR ด้านบน</div>';
      return;
    }
    players.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'player-row' + (p.connected ? '' : ' disconnected') + (idx === 0 && p.score > 0 ? ' rank-1' : '');
      const roleBadge = p.role === 'observer' ? '<span class="badge observer">👀 ดูอย่างเดียว</span>' : '<span class="badge player">🎤 ผู้เล่น</span>';
      let scoreHtml = `<span class="score">${p.score}</span>`;
      if (opts.showSubmitStatus) {
        const submitted = opts.submittedIds && opts.submittedIds.has(p.id);
        scoreHtml = p.role === 'observer' ? '<span class="muted small">ผู้ชม</span>' : (submitted ? '<span class="badge player">✅ ส่งแล้ว</span>' : '<span class="badge small">⏳ กำลังอัด</span>');
      }
      row.innerHTML = `<span class="name">${escapeHtml(p.name)} ${roleBadge}</span>${scoreHtml}` +
        (opts.kickable ? `<button class="btn ghost small" data-kick="${p.id}" style="margin-left:8px;">เตะออก</button>` : '');
      container.appendChild(row);
    });
    if (opts.kickable) {
      container.querySelectorAll('[data-kick]').forEach((btn) => {
        btn.addEventListener('click', () => socket.emit('host:kick', { playerId: btn.dataset.kick }, () => {}));
      });
    }
  }

  function applyState(state) {
    latestState = state;
    $('playerCount').textContent = state.players.length;

    if (state.phase === 'LOBBY') {
      showView('lobby');
      renderPlayerList($('lobbyPlayerList'), { kickable: true });
    } else if (state.phase === 'LISTEN_RECORD') {
      showView('listen');
      $('lrRoundIndex').textContent = state.roundIndex + 1;
      $('lrTotalRounds').textContent = state.totalRounds;
      $('lrSoundName').textContent = '🔊 กำลังฟัง & เลียนแบบ...';
      renderPlayerList($('listenPlayerList'), { showSubmitStatus: true, submittedIds: window.__submittedIds || new Set() });
    } else if (state.phase === 'REVEAL') {
      showView('reveal');
    } else if (state.phase === 'ROUND_RESULT') {
      showView('roundresult');
      $('rrRoundIndex').textContent = state.roundIndex + 1;
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
      row.className = 'player-row' + (idx === 0 ? ' rank-1' : idx === 1 ? ' rank-2' : idx === 2 ? ' rank-3' : '');
      const delta = p.lastRoundScore != null ? ` <span class="muted small">(+${p.lastRoundScore})</span>` : '';
      row.innerHTML = `<span class="name">${escapeHtml(p.name)}</span><span class="score">${p.score}${delta}</span>`;
      container.appendChild(row);
    });
  }

  function renderGameOver() {
    const players = [...(latestState?.players || [])].filter((p) => p.role === 'player').sort((a, b) => b.score - a.score);
    $('winnerText').textContent = players.length ? `🏆 ผู้ชนะ: ${players[0].name} (${players[0].score} แต้ม)` : 'ไม่มีผู้เล่น';
    const container = $('finalList');
    container.innerHTML = '';
    players.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'player-row' + (idx === 0 ? ' rank-1' : idx === 1 ? ' rank-2' : idx === 2 ? ' rank-3' : '');
      row.innerHTML = `<span class="name">#${idx + 1} ${escapeHtml(p.name)}</span><span class="score">${p.score}</span>`;
      container.appendChild(row);
    });
  }

  $('nextRoundBtn').addEventListener('click', () => {
    clearInterval(roundResultTimer);
    socket.emit('host:next_round', {}, () => {});
  });

  $('restartBtn').addEventListener('click', () => {
    socket.emit('host:restart', {}, (res) => {
      if (res.ok) { selectedIds = new Set(); }
    });
  });

  socket.on('state:update', applyState);

  socket.on('round:sound', (data) => {
    window.__submittedIds = new Set();
    if (latestState) applyState({ ...latestState, phase: 'LISTEN_RECORD', roundIndex: data.roundIndex, totalRounds: data.totalRounds });
    $('lrSoundName').textContent = `🔊 "${data.soundName}" — ผู้เล่นกำลังฟัง & เลียนแบบ`;
    if (lrWave) lrWave.setGhost(data.envelope);
    updateProgress(0, (latestState?.players || []).filter((p) => p.role === 'player' && p.connected).length);
  });

  socket.on('round:submitted', (data) => {
    window.__submittedIds = window.__submittedIds || new Set();
    window.__submittedIds.add(data.playerId);
    updateProgress(data.submittedCount, data.total);
    if (latestState) renderPlayerList($('listenPlayerList'), { showSubmitStatus: true, submittedIds: window.__submittedIds });
  });

  function updateProgress(count, total) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    $('lrProgressFill').style.width = pct + '%';
    $('lrProgressText').textContent = `ส่งเสียงแล้ว ${count} / ${total} คน`;
  }

  socket.on('round:reveal_take', (data) => {
    showView('reveal');
    $('revealPos').textContent = data.index + 1;
    $('revealTotal').textContent = data.total;
    $('revealName').textContent = data.timedOut ? `${data.name} (หมดเวลา ⏱️)` : `🎙️ ${data.name}`;
    $('revealScoreWrap').classList.add('hidden');
    if (revealWave) {
      revealWave.setGhost(data.referenceEnvelope);
      revealWave.reset();
    }
    const audioEl = $('revealAudio');
    if (data.url) {
      audioEl.src = data.url;
      audioEl.play().catch(() => {});
    } else {
      audioEl.removeAttribute('src');
    }
    const reveal = () => {
      $('revealScore').textContent = data.score;
      $('revealShape').textContent = data.shapeScore;
      $('revealRhythm').textContent = data.rhythmScore;
      $('revealMelody').textContent = data.melodyScore;
      $('revealScoreWrap').classList.remove('hidden');
      if (revealWave) revealWave.setLive(data.envelope);
    };
    if (data.url) {
      audioEl.onended = reveal;
      setTimeout(reveal, 6000); // เผื่อเล่นไม่ขึ้น
    } else {
      setTimeout(reveal, 500);
    }
  });

  socket.on('round:result', (data) => {
    showView('roundresult');
    renderRoundResultList();
    let remaining = Math.ceil(data.autoAdvanceMs / 1000);
    $('rrCountdown').textContent = `ไปต่อในอีก ${remaining} วินาที (หรือกดปุ่มด้านล่างเพื่อไปเลย)`;
    clearInterval(roundResultTimer);
    roundResultTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { clearInterval(roundResultTimer); return; }
      $('rrCountdown').textContent = `ไปต่อในอีก ${remaining} วินาที (หรือกดปุ่มด้านล่างเพื่อไปเลย)`;
    }, 1000);
  });

  socket.on('game:over', () => {
    showView('gameover');
    renderGameOver();
  });

  socket.on('connect', () => { if (roomCode && hostToken) socket.emit('host:rejoin_room', { code: roomCode, hostToken }, () => {}); });
})();

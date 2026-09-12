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

  // ผูก event ให้ปลอดภัย: ถ้า HTML กับ JS ไม่ตรงเวอร์ชันกัน (เช่นแคชเบราว์เซอร์เก่าค้างอยู่)
  // จะแค่เตือนใน console แล้วข้ามไป แทนที่จะโยน error กลางไฟล์จนโค้ดส่วนที่เหลือด้านล่าง
  // (เช่น socket.on ทั้งหมด) ไม่ถูกรันเลย ทำให้ทั้งแอปค้าง
  function on(id, event, handler) {
    const el = $(id);
    if (el) el.addEventListener(event, handler);
    else console.warn(`[mimic-party] ไม่พบ element id="${id}" — ลองรีเฟรชหน้าแบบ hard refresh (Ctrl+Shift+R) เผื่อไฟล์แคชเก่าค้างอยู่`);
    return el;
  }

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
  on('tapGateBtn', 'click', () => {
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
    const qrImg = $('qrImg');
    if (qrImg) qrImg.src = `/api/qrcode?text=${encodeURIComponent(currentJoinUrl)}`;
    const joinLinkText = $('joinLinkText');
    if (joinLinkText) { joinLinkText.textContent = currentJoinUrl; joinLinkText.href = currentJoinUrl; }
    const qrModalEl = $('qrModal');
    if (qrModalEl && !qrModalEl.classList.contains('hidden')) openQrModal(); // อัปเดตรูปในโมดัลด้วยถ้าเปิดค้างอยู่
  }

  function openQrModal() {
    if (!currentJoinUrl) return;
    const qrModalImg = $('qrModalImg');
    if (qrModalImg) qrModalImg.src = `/api/qrcode?text=${encodeURIComponent(currentJoinUrl)}&size=640`;
    const qrModalCode = $('qrModalCode');
    if (qrModalCode) qrModalCode.textContent = roomCode || '----';
    const qrModalEl = $('qrModal');
    if (qrModalEl) qrModalEl.classList.remove('hidden');
  }
  function closeQrModal() {
    const qrModalEl = $('qrModal');
    if (qrModalEl) qrModalEl.classList.add('hidden');
  }
  on('qrWrap', 'click', openQrModal);
  on('qrWrap', 'keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQrModal(); }
  });
  on('qrModal', 'click', closeQrModal);

  on('usePublicUrlBtn', 'click', () => {
    const input = $('publicUrlInput');
    const v = input ? input.value.trim() : '';
    if (v) localStorage.setItem('mp_public_url', v);
    else localStorage.removeItem('mp_public_url');
    refreshQr();
  });

  function setPublicUrlSectionOpen(open) {
    const section = $('publicUrlSection');
    if (section) section.classList.toggle('hidden', !open);
    const btn = $('togglePublicUrlBtn');
    if (btn) btn.textContent = open ? '🔼 ซ่อนส่วนนี้' : '🌐 ลิงก์เล่นนอกบ้าน (ถ้าต้องการ)';
    localStorage.setItem('mp_publicurl_open', open ? '1' : '0');
  }
  on('togglePublicUrlBtn', 'click', () => {
    const section = $('publicUrlSection');
    setPublicUrlSectionOpen(section ? section.classList.contains('hidden') : true);
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
      const lanHintEl = $('lanHint');
      if (lanHintEl) lanHintEl.innerHTML = msg;
      refreshQr();
    }).catch(() => {});
  }

  // ---------- ห้อง ----------
  function init() {
    const saved = JSON.parse(localStorage.getItem('mp_host') || 'null');
    const publicUrlSaved = localStorage.getItem('mp_public_url');
    const publicUrlInputEl = $('publicUrlInput');
    if (publicUrlSaved && publicUrlInputEl) publicUrlInputEl.value = publicUrlSaved;
    const openSaved = localStorage.getItem('mp_publicurl_open');
    // setPublicUrlSectionOpen(openSaved === '1' || (openSaved === null && !!publicUrlSaved));

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
  let soundSearchQuery = '';
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $('tab-local').classList.toggle('hidden', currentTab !== 'local');
      $('tab-myinstants').classList.toggle('hidden', currentTab !== 'myinstants');
      // สลับแท็บแล้วล้างคำค้นหาเดิม กันสับสนว่าทำไมแท็บใหม่ดูว่างเปล่า (คำค้นหาเก่าอาจไม่ match อะไรเลยในแท็บนี้)
      soundSearchQuery = '';
      const searchInput = $('soundSearchInput');
      if (searchInput) searchInput.value = '';
      renderLibrary();
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

  on('refreshLibraryBtn', 'click', loadLibrary);

  on('soundSearchInput', 'input', (e) => {
    soundSearchQuery = e.target.value.trim().toLowerCase();
    renderLibrary();
  });

  function visibleLibraryEntries() {
    const wantSource = currentTab === 'local' ? 'local' : 'myinstants';
    let list = libraryList.filter((e) => e.source === wantSource);
    if (wantSource === 'local') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'th'));
    }
    if (soundSearchQuery) {
      list = list.filter((e) => e.name.toLowerCase().includes(soundSearchQuery));
    }
    return list;
  }

  on('selectAllBtn', 'click', () => {
    visibleLibraryEntries().forEach((e) => selectedIds.add(e.id));
    renderLibrary();
  });
  on('clearSelectionBtn', 'click', () => {
    selectedIds.clear();
    renderLibrary();
  });

  function updateSelectedCount() {
    const el = $('selectedCountText');
    if (el) el.textContent = `เลือกไว้ ${selectedIds.size} เสียง`;
  }

  // ---------- ลาก-วางไฟล์เสียง / เลือกไฟล์จากเครื่อง ----------
  const AUDIO_EXT_CLIENT = ['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac'];
  function isAudioFile(file) {
    if (file.type && file.type.startsWith('audio/')) return true;
    const lower = file.name.toLowerCase();
    return AUDIO_EXT_CLIENT.some((ext) => lower.endsWith(ext));
  }

  function setUploadStatus(msg) {
    const el = $('uploadStatus');
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; }
    else { el.classList.remove('hidden'); el.textContent = msg; }
  }

  function uploadOneFile(file) {
    return file.arrayBuffer().then((buf) => new Promise((resolve) => {
      socket.emit('host:upload_sound', { filename: file.name, data: buf }, (res) => resolve({ file, res }));
    })).catch((err) => ({ file, res: { ok: false, error: err.message } }));
  }

  async function handleFilesDropped(fileList) {
    const files = Array.from(fileList || []).filter(isAudioFile);
    if (files.length === 0) {
      toast('ไม่พบไฟล์เสียงที่รองรับ (mp3/wav/ogg/m4a/webm/flac)');
      return;
    }
    let okCount = 0;
    const failed = [];
    for (let i = 0; i < files.length; i++) {
      setUploadStatus(`⬆️ กำลังอัปโหลด ${i + 1}/${files.length}: ${files[i].name}`);
      const { file, res } = await uploadOneFile(files[i]);
      if (res && res.ok) {
        okCount++;
        selectedIds.add(res.entry.id);
      } else {
        failed.push(`${file.name} (${(res && res.error) || 'ไม่ทราบสาเหตุ'})`);
      }
    }
    if (okCount > 0) {
      setUploadStatus(`✅ อัปโหลดสำเร็จ ${okCount}/${files.length} ไฟล์`);
      loadLibrary();
      setTimeout(() => setUploadStatus(null), 4000);
    } else {
      setUploadStatus(null);
    }
    if (failed.length) toast('อัปโหลดไม่สำเร็จ: ' + failed.join(', '));
  }

  const dropzoneEl = $('soundDropzone');
  const soundFileInputEl = $('soundFileInput');
  if (dropzoneEl && soundFileInputEl) {
    dropzoneEl.addEventListener('click', () => soundFileInputEl.click());
    dropzoneEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); soundFileInputEl.click(); }
    });
    ['dragenter', 'dragover'].forEach((evt) => {
      dropzoneEl.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropzoneEl.classList.add('dragover'); });
    });
    ['dragleave', 'dragend'].forEach((evt) => {
      dropzoneEl.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropzoneEl.classList.remove('dragover'); });
    });
    dropzoneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzoneEl.classList.remove('dragover');
      handleFilesDropped(e.dataTransfer && e.dataTransfer.files);
    });
    soundFileInputEl.addEventListener('change', () => {
      handleFilesDropped(soundFileInputEl.files);
      soundFileInputEl.value = '';
    });
  }

  on('addMyinstantsBtn', 'click', () => {
    const urlInput = $('myinstantsUrl');
    const url = urlInput ? urlInput.value.trim() : '';
    if (!url) return;
    const statusEl = $('myinstantsStatus');
    if (statusEl) statusEl.textContent = 'กำลังดึงเสียง...';
    socket.emit('host:add_myinstants', { url }, (res) => {
      if (res.ok) {
        if (statusEl) statusEl.textContent = `เพิ่ม "${res.entry.name}" แล้ว ✅`;
        if (urlInput) urlInput.value = '';
        selectedIds.add(res.entry.id);
        loadLibrary();
      } else {
        if (statusEl) statusEl.textContent = '❌ ' + res.error;
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

    const localCount = libraryList.filter((e) => e.source === 'local').length;
    const myinstantsCount = libraryList.filter((e) => e.source === 'myinstants').length;
    const tabCountLocalEl = $('tabCountLocal');
    if (tabCountLocalEl) tabCountLocalEl.textContent = `(${localCount})`;
    const tabCountMyinstantsEl = $('tabCountMyinstants');
    if (tabCountMyinstantsEl) tabCountMyinstantsEl.textContent = `(${myinstantsCount})`;
    updateSelectedCount();

    const entries = visibleLibraryEntries();

    if (entries.length === 0) {
      const totalInTab = currentTab === 'local' ? localCount : myinstantsCount;
      if (totalInTab === 0) {
        list.innerHTML = currentTab === 'local'
          ? '<div class="sound-empty"><div class="icon">📁</div><div>ยังไม่มีไฟล์เสียงในเครื่อง</div><div class="small">ลากไฟล์ .mp3 มาวางด้านบน หรือวางไฟล์ในโฟลเดอร์ assets/sounds แล้วกดรีเฟรช</div></div>'
          : '<div class="sound-empty"><div class="icon">🔗</div><div>ยังไม่มีเสียงจาก myinstants.com</div><div class="small">วางลิงก์เสียงด้านบนแล้วกด "ดึงเสียง"</div></div>';
      } else {
        list.innerHTML = '<div class="sound-empty"><div class="icon">🔍</div><div>ไม่พบเสียงที่ตรงกับคำค้นหา</div></div>';
      }
      return;
    }

    entries.forEach((entry) => {
      const el = document.createElement('div');
      el.className = 'sound-item' + (selectedIds.has(entry.id) ? ' selected' : '');
      el.innerHTML = `
        <input type="checkbox" class="sound-checkbox" ${selectedIds.has(entry.id) ? 'checked' : ''}>
        <div class="sound-icon">${entry.source === 'local' ? '📁' : '🔗'}</div>
        <div class="meta">
          <div class="name">${escapeHtml(entry.name)}</div>
          <div class="sound-badges">
            <span class="sound-badge">⏱ ${fmtDuration(entry.durationMs)}</span>
            <span class="sound-badge">${entry.source === 'local' ? 'ไฟล์ในเครื่อง' : 'myinstants.com'}</span>
          </div>
        </div>
        <audio class="sound-audio" controls preload="none" src="${entry.source === 'local' ? '/media/sounds/' : '/media/cache/'}${encodeURIComponent(basename(entry.relPath))}"></audio>
        ${entry.source === 'myinstants' ? '<button type="button" class="btn ghost small" data-remove="' + entry.id + '">ลบ</button>' : ''}
      `;
      const cb = el.querySelector('.sound-checkbox');
      function toggle() {
        cb.checked = !cb.checked;
        if (cb.checked) selectedIds.add(entry.id); else selectedIds.delete(entry.id);
        el.classList.toggle('selected', cb.checked);
        updateSelectedCount();
      }
      cb.addEventListener('click', (e) => e.stopPropagation()); // กัน double-toggle กับ click ที่ el ด้านล่าง
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(entry.id); else selectedIds.delete(entry.id);
        el.classList.toggle('selected', cb.checked);
        updateSelectedCount();
      });
      // แตะที่แถวตรงไหนก็ได้เพื่อเลือก/ไม่เลือก ยกเว้นตัวเล่นเสียงกับปุ่มลบ (ให้กดใช้งานได้ตามปกติ)
      el.addEventListener('click', (e) => {
        if (e.target.closest('audio, [data-remove]')) return;
        toggle();
      });
      const rmBtn = el.querySelector('[data-remove]');
      if (rmBtn) {
        rmBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          socket.emit('host:remove_sound', { id: entry.id }, () => { selectedIds.delete(entry.id); loadLibrary(); });
        });
      }
      list.appendChild(el);
    });
  }

  // หมายเหตุ: บน Windows path.relative() ฝั่ง server จะคืนค่ามาเป็น backslash (\) เช่น "assets\sounds\quack.mp3"
  // ถ้า split แค่ '/' อย่างเดียวจะไม่ตัดโฟลเดอร์ออก ทำให้ src ของ <audio> ผิด (404) กลายเป็นไม่มีเสียงตอนพรีวิว
  function basename(p) { return (p || '').split(/[\\/]/).pop(); }
  function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ---------- เริ่มเกม ----------
  on('startGameBtn', 'click', () => {
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

  on('nextRoundBtn', 'click', () => {
    clearInterval(roundResultTimer);
    socket.emit('host:next_round', {}, () => {});
  });

  on('restartBtn', 'click', () => {
    socket.emit('host:restart', {}, (res) => {
      // ไม่ล้างเสียงที่เลือกไว้แล้ว เผื่อกลุ่มเดิมอยากเล่นซ้ำด้วยชุดเสียงเดิม ไม่ต้องมาติ๊กเลือกใหม่ทุกรอบ
      // (เดิมโค้ดล้าง selectedIds ทิ้งตรงนี้ แต่ไม่ได้ re-render รายการ ทำให้ checkbox ในหน้าจอยังติ๊กค้างอยู่
      //  ทั้งที่จริงๆ ค่าที่เลือกไว้ในระบบถูกล้างไปแล้ว กดเริ่มเกมเลยฟ้อง "กรุณาเลือกเสียง" ทั้งที่ติ๊กไว้เต็มไปหมด)
      if (res.ok) renderLibrary();
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
    $('revealName').textContent = data.timedOut ? `${data.name} (หมดเวลา ⏱️)` : `🎙️ ${data.name}${data.silent ? ' 🔇 (ไม่มีเสียงพูด)' : ''}`;
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
      // ถ้าไม่มีเสียงพูดจริงๆ (silent) ไม่โชว์กราฟ envelope ที่ normalize มาแล้ว เพราะจะดูเหมือนมีคนพูดทั้งที่ไม่มี
      // (envelope normalize ต่อคลิปเสมอ ต่อให้เป็นแค่ noise เบาๆ กราฟก็จะยืดเต็มความสูงเหมือนมีคนพูดจริง)
      if (revealWave) revealWave.setLive(data.silent ? null : data.envelope);
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

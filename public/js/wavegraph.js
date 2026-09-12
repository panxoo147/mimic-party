// public/js/wavegraph.js — วาดกราฟ "พลังเสียงตามเวลา" แบบเดียวกับหน้าจอเปรียบเทียบในเกมต้นฉบับ
// ใช้ DOM ธรรมดา (div เรียงแท่ง) ไม่ต้องพึ่ง canvas/library ภายนอก
(function (global) {
  const BAR_COUNT = 60; // ต้องตรงกับ ENVELOPE_POINTS ฝั่ง server (server/audio.js)

  function clamp01(v) { return Math.max(0, Math.min(1, v || 0)); }

  /**
   * สร้างกราฟแท่งในตำแหน่ง container ที่ให้มา
   * คืนค่า object ที่มีเมธอดไว้ควบคุมกราฟ:
   *  - setGhost(envelopeArray|null)   วาดเงาแท่ง "ต้นฉบับ" ไว้ข้างหลัง (โปร่งแสง)
   *  - setLive(envelopeArray|null)    วาดแท่ง "ของจริง" ทับด้านหน้า (ใช้ตอนเฉลยผล)
   *  - reset()                        เคลียร์กราฟให้แบนราบ เตรียมอัดใหม่
   *  - pushLive(value 0..1)           กราฟสไตล์ VU-meter สด: ดันค่าล่าสุดเข้ามาทีละแท่ง (ใช้ตอนกำลังอัดเสียง)
   *  - highlightUpTo(ratio 0..1)      ไฮไลต์แท่งตามสัดส่วนเวลาที่เล่นไปแล้ว (ใช้ตอนฟังเสียงต้นฉบับ)
   */
  function createWaveGraph(container, opts = {}) {
    const barCount = opts.barCount || BAR_COUNT;
    container.classList.add('wavegraph');
    container.innerHTML = '';

    const ghostRow = document.createElement('div');
    ghostRow.className = 'wavegraph-row wavegraph-ghost';
    const liveRow = document.createElement('div');
    liveRow.className = 'wavegraph-row wavegraph-live';
    container.appendChild(ghostRow);
    container.appendChild(liveRow);

    const ghostBars = [];
    const liveBars = [];
    for (let i = 0; i < barCount; i++) {
      const g = document.createElement('div');
      g.className = 'wavebar wavebar-ghost';
      ghostRow.appendChild(g);
      ghostBars.push(g);

      const l = document.createElement('div');
      l.className = 'wavebar wavebar-live';
      liveRow.appendChild(l);
      liveBars.push(l);
    }

    function setGhost(envelope) {
      for (let i = 0; i < barCount; i++) {
        const v = envelope && envelope[i] != null ? clamp01(envelope[i]) : 0;
        ghostBars[i].style.height = (4 + v * 96) + '%';
      }
    }

    function setLive(envelope) {
      for (let i = 0; i < barCount; i++) {
        const v = envelope && envelope[i] != null ? clamp01(envelope[i]) : 0;
        liveBars[i].style.height = (4 + v * 96) + '%';
        liveBars[i].classList.remove('pending');
      }
    }

    function reset() {
      liveBars.forEach((b) => { b.style.height = '4%'; b.classList.add('pending'); });
    }

    // สำหรับกราฟสด (ตอนอัดเสียง): เลื่อนค่าทั้งหมดไปทางซ้าย แล้วเติมค่าล่าสุดที่ขวาสุด
    let liveValues = new Array(barCount).fill(0);
    function pushLive(value) {
      liveValues.shift();
      liveValues.push(clamp01(value));
      for (let i = 0; i < barCount; i++) {
        liveBars[i].style.height = (4 + liveValues[i] * 96) + '%';
        liveBars[i].classList.remove('pending');
      }
    }
    function resetLiveValues() {
      liveValues = new Array(barCount).fill(0);
      reset();
    }

    function highlightUpTo(ratio) {
      const cut = Math.round(clamp01(ratio) * barCount);
      for (let i = 0; i < barCount; i++) {
        ghostBars[i].classList.toggle('played', i < cut);
      }
    }

    reset();

    return { setGhost, setLive, reset: resetLiveValues, pushLive, highlightUpTo };
  }

  global.MimicWaveGraph = { create: createWaveGraph, BAR_COUNT };
})(window);

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
   *  - advanceTo(ratio 0..1, value 0..1)  กราฟสไตล์ VU-meter สด ระหว่างอัดเสียง: เติมแท่งจากซ้ายไปขวาโดยอิง "สัดส่วนเวลาจริง
   *                                    ที่ผ่านไปแล้ว" (ratio = เวลาที่ผ่านไป/เวลาอัดทั้งหมด) ไม่ใช่นับจำนวนครั้งที่ถูกเรียก
   *                                    เพราะถ้านับจากจำนวนครั้ง เวลา setInterval โดนดีเลย์/throttle (เช่นเบราว์เซอร์หน่วงงานพื้นหลัง)
   *                                    กราฟจะเติมไม่ทันเวลาอัดจริงจบไปแล้ว ทำให้ค้างไม่เต็มเส้นทั้งที่อัดเสร็จแล้ว
   *                                    ฟังก์ชันนี้จะ "ไล่เติม" แท่งที่ยังไม่ถึงให้ทันตามสัดส่วนเวลาที่ควรจะเป็นเสมอทุกครั้งที่เรียก
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

    // สำหรับกราฟสด (ตอนอัดเสียง): เติมแท่งถัดไปจากซ้ายไปขวาตามสัดส่วนเวลาจริงที่ผ่านไปแล้ว (ไม่ใช่นับจำนวนครั้งที่ถูกเรียก)
    // เพื่อให้ตำแหน่งแท่งซ้าย-ขวาตรงกับกราฟเงาต้นฉบับด้านหลังเป๊ะๆ เทียบกันได้ทันทีระหว่างอัด และไม่ค้างไม่เต็มเส้นถ้า
    // setInterval โดนดีเลย์/throttle ไปบ้าง (ดูรายละเอียดที่คอมเมนต์ด้านบน)
    let nextIndex = 0;
    function advanceTo(ratio, value) {
      const targetIndex = Math.min(barCount, Math.max(0, Math.round(clamp01(ratio) * barCount)));
      while (nextIndex < targetIndex) {
        liveBars[nextIndex].style.height = (4 + clamp01(value) * 96) + '%';
        liveBars[nextIndex].classList.remove('pending');
        nextIndex++;
      }
    }
    function resetLiveValues() {
      nextIndex = 0;
      reset();
    }

    function highlightUpTo(ratio) {
      const cut = Math.round(clamp01(ratio) * barCount);
      for (let i = 0; i < barCount; i++) {
        ghostBars[i].classList.toggle('played', i < cut);
      }
    }

    reset();

    return { setGhost, setLive, reset: resetLiveValues, advanceTo, highlightUpTo };
  }

  global.MimicWaveGraph = { create: createWaveGraph, BAR_COUNT };
})(window);

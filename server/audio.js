// server/audio.js
// ถอดรหัสไฟล์เสียง (mp3/webm/ogg/wav ฯลฯ) เป็น PCM ด้วย ffmpeg แล้ววิเคราะห์ "ลายเซ็นเสียง" 3 มิติ
// สำหรับใช้เทียบความเหมือนระหว่างเสียงต้นฉบับกับเสียงเลียนแบบของผู้เล่น:
//   1) shape  = รูปทรงพลังเสียงตามเวลา (RMS envelope)  — ดัง/เบา ช่วงไหน
//   2) rhythm = จำนวนจุดเน้นเสียง (onsets)              — พูดกี่ครั้ง/จังหวะไหน
//   3) melody = รูปทรงระดับเสียงสัมพัทธ์ (relative pitch contour) — เสียงสูง-ต่ำขึ้นลงตรงกันไหม
//               (ไม่สนใจโทนเสียงจริงของแต่ละคน แค่ดู "รูปร่าง" การขึ้นลง)
//
// มิติที่ 3 (melody) คือสิ่งที่กันไม่ให้แค่ "พูดมั่วๆ" ให้ระดับเสียงดัง-เบาตรงจังหวะเฉยๆ แล้วได้คะแนนเต็ม
// เพราะการเลียนเสียงแบบมั่วๆ มักจะมีทำนอง/โทนเสียงขึ้นลงไม่ตรงกับต้นฉบับ ต่อให้จังหวะความดังจะตรงก็ตาม

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const SAMPLE_RATE = 8000; // ลดอัตราสุ่มตัวอย่างให้เบา พอสำหรับวิเคราะห์จังหวะ/รูปทรงเสียง/ระดับเสียง
const ENVELOPE_POINTS = 60; // จำนวนจุดที่ resample เส้นต่างๆ ให้เท่ากันเสมอ
const FRAME_MS = 30; // ความยาวเฟรมสำหรับ RMS envelope
const PITCH_MIN_HZ = 70; // ช่วงความถี่เสียงพูดของมนุษย์ทั่วไป (รวมเสียงทุ้ม)
const PITCH_MAX_HZ = 500; // ถึงเสียงแหลม/เสียงเด็ก/เสียงแกล้งสูง
const PITCH_MIN_LAG = Math.round(SAMPLE_RATE / PITCH_MAX_HZ);
const PITCH_MAX_LAG = Math.round(SAMPLE_RATE / PITCH_MIN_HZ);
const PITCH_CONF_THRESHOLD = 0.5; // ต้องมั่นใจแค่ไหนถึงจะถือว่าเฟรมนั้น "มีระดับเสียงชัดเจน" (voiced)

// ค่า RMS แบบ "ดิบ" (ก่อน normalize ต่อคลิป) ต่ำกว่านี้ถือว่า "แทบไม่มีเสียงจริงเข้ามาเลย"
// (แค่ noise floor ของไมค์ เช่น ไม่ได้พูด/ไมค์โดนปิด/สิทธิ์ไมค์มีปัญหา) — ค่านี้ปรับได้ตามจริง
// เหตุผลที่ต้องเช็คแยกจาก envelope ที่ normalize แล้ว: การ normalize ต่อคลิป (หารด้วยค่าสูงสุดของตัวเอง)
// ทำให้ต่อให้เป็นแค่ noise เบาๆ กราฟก็จะถูกยืดเต็ม 0-100% เหมือนมีคนพูดจริงอยู่ดี ดูไม่ออกว่า "เงียบ"
const SILENCE_RAW_RMS_THRESHOLD = 0.0035;

/**
 * ถอดรหัสไฟล์เสียงใดๆ ให้เป็น PCM float32 mono ที่ SAMPLE_RATE
 * คืนค่า { samples: Float32Array, durationMs: number }
 */
function decodeToPCM(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      'pipe:1',
    ];
    const proc = spawn(ffmpegPath, args);
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        Math.floor(buf.byteLength / 4)
      );
      const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
      resolve({ samples: Float32Array.from(samples), durationMs });
    });
  });
}

/** คำนวณ RMS envelope แบบ frame-based จาก PCM samples (ไม่ overlap) */
function rmsEnvelope(samples, frameSize) {
  const frames = Math.ceil(samples.length / frameSize) || 1;
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const start = i * frameSize;
    const end = Math.min(samples.length, start + frameSize);
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j] * samples[j];
    const count = Math.max(1, end - start);
    env[i] = Math.sqrt(sum / count);
  }
  return env;
}

/**
 * ประมาณระดับเสียง (pitch) ต่อเฟรม ด้วยวิธี autocorrelation แบบ normalized ต่อกรอบเวลาเดียวกับ rmsEnvelope
 * คืนค่า { freq: Float32Array, confidence: Float32Array } ความยาวเท่ากับจำนวนเฟรมของ rmsEnvelope
 */
function pitchPerFrame(samples, frameSize, frameCount) {
  const freq = new Float32Array(frameCount);
  const confidence = new Float32Array(frameCount);
  // ใช้หน้าต่างวิเคราะห์ที่กว้างกว่าเฟรมเล็กน้อย (ครอบคลุมรอบคลื่นของเสียงทุ้มสุดที่รองรับได้)
  const halfWindow = Math.max(frameSize, Math.round(PITCH_MAX_LAG * 1.3));

  for (let i = 0; i < frameCount; i++) {
    const center = i * frameSize + Math.floor(frameSize / 2);
    const start = Math.max(0, center - halfWindow);
    const end = Math.min(samples.length, center + halfWindow);
    const n = end - start;
    if (n < PITCH_MAX_LAG * 2) continue; // สั้นเกินไป วิเคราะห์ไม่ได้ ปล่อยเป็น 0/unvoiced

    let mean = 0;
    for (let j = start; j < end; j++) mean += samples[j];
    mean /= n;

    let bestLag = -1;
    let bestCorr = 0;
    for (let lag = PITCH_MIN_LAG; lag <= PITCH_MAX_LAG && lag < n; lag++) {
      let num = 0, denA = 0, denB = 0;
      const usable = n - lag;
      for (let j = 0; j < usable; j++) {
        const a = samples[start + j] - mean;
        const b = samples[start + j + lag] - mean;
        num += a * b;
        denA += a * a;
        denB += b * b;
      }
      const denom = Math.sqrt(denA * denB);
      const corr = denom > 1e-9 ? num / denom : 0;
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    if (bestLag > 0 && bestCorr > 0) {
      freq[i] = SAMPLE_RATE / bestLag;
      confidence[i] = Math.max(0, Math.min(1, bestCorr));
    }
  }
  return { freq, confidence };
}

/** หาช่วง [start, end] (ดัชนีเฟรม) ที่ตัดความเงียบหัว-ท้ายออกแล้ว โดยอิงจากค่าสูงสุดของ envelope */
function findTrimRange(env, thresholdRatio = 0.06) {
  const max = Math.max(...env, 1e-9);
  const threshold = max * thresholdRatio;
  let start = 0;
  let end = env.length - 1;
  while (start < env.length && env[start] < threshold) start++;
  while (end > start && env[end] < threshold) end--;
  if (end <= start) return { start: 0, end: env.length - 1 }; // เสียงเงียบทั้งหมด กันพัง
  return { start, end };
}

/** resample เส้นตัวเลข (number[]) ให้มีความยาวคงที่ (linear interpolation) แล้ว normalize 0..1 ด้วยค่าสูงสุด */
function resampleNormalize(arr, points = ENVELOPE_POINTS) {
  const out = new Float32Array(points);
  const n = arr.length;
  if (n === 0) return out;
  for (let i = 0; i < points; i++) {
    const pos = (i / (points - 1)) * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(n - 1, lo + 1);
    const frac = pos - lo;
    out[i] = arr[lo] * (1 - frac) + arr[hi] * frac;
  }
  const max = Math.max(...out, 1e-9);
  for (let i = 0; i < points; i++) out[i] = out[i] / max;
  return out;
}

/**
 * resample เส้นระดับเสียงสัมพัทธ์ (มีบางจุดเป็น null เพราะไม่มีเสียงชัดเจน) ให้มีความยาวคงที่
 * ใช้ nearest-neighbor (ไม่ lerp ข้าม null เพราะจะเบลอความหมาย)
 */
function resamplePitchNearest(values, points = ENVELOPE_POINTS) {
  const out = new Array(points).fill(null);
  const n = values.length;
  if (n === 0) return out;
  for (let i = 0; i < points; i++) {
    const pos = Math.round((i / (points - 1)) * (n - 1));
    out[i] = values[Math.max(0, Math.min(n - 1, pos))];
  }
  return out;
}

/** นับจำนวน "attack" (จุดเริ่มเสียงดัง) แบบง่ายๆ จากการไล่ค่าขึ้นผ่าน threshold */
function countOnsets(env, threshold = 0.35) {
  let count = 0;
  let above = false;
  for (let i = 0; i < env.length; i++) {
    if (env[i] >= threshold && !above) {
      count++;
      above = true;
    } else if (env[i] < threshold * 0.7) {
      above = false;
    }
  }
  return count;
}

/** สกัด "ลายเซ็นเสียง" ที่ใช้เทียบคะแนน จากไฟล์เสียงหนึ่งไฟล์ (shape + rhythm + melody) */
async function analyzeFile(inputPath) {
  const { samples, durationMs } = await decodeToPCM(inputPath);
  const frameSize = Math.max(1, Math.round((SAMPLE_RATE * FRAME_MS) / 1000));
  const rawEnv = rmsEnvelope(samples, frameSize);
  const { freq: rawFreq, confidence: rawConf } = pitchPerFrame(samples, frameSize, rawEnv.length);
  // ค่าพลังเสียงดิบสูงสุด (ก่อน normalize) ไว้เช็คว่า "มีเสียงจริงเข้ามาไหม" แยกจากรูปทรงที่ normalize แล้ว
  const peakRaw = rawEnv.length ? Math.max(...rawEnv) : 0;
  const { start, end } = findTrimRange(rawEnv);

  const trimmedEnv = Array.from(rawEnv.slice(start, end + 1));
  const envelope = resampleNormalize(trimmedEnv);
  const envelopeForOnsets = trimmedEnv.length ? envelope : envelope; // already normalized
  const onsets = countOnsets(envelopeForOnsets);

  // สร้างเส้นระดับเสียงสัมพัทธ์: เฉพาะเฟรมที่ "มั่นใจว่ามีระดับเสียงชัดเจน" (confidence สูงพอ) เท่านั้น
  // แปลงเป็นหน่วย "เซมิโทนห่างจากค่ามัธยฐานของตัวเอง" เพื่อไม่สนใจว่าใครเสียงสูง/ต่ำกว่าใคร (ดูแค่ทรงทำนอง)
  const relPitchRaw = [];
  const logFreqs = [];
  for (let i = start; i <= end; i++) {
    if (rawConf[i] >= PITCH_CONF_THRESHOLD && rawFreq[i] > 0) {
      const lf = Math.log2(rawFreq[i]);
      relPitchRaw.push(lf);
      logFreqs.push(lf);
    } else {
      relPitchRaw.push(null);
    }
  }
  let medianLog = 0;
  if (logFreqs.length > 0) {
    const sorted = logFreqs.slice().sort((a, b) => a - b);
    medianLog = sorted[Math.floor(sorted.length / 2)];
  }
  const relPitchSemitones = relPitchRaw.map((lf) => (lf == null ? null : (lf - medianLog) * 12));
  const pitch = resamplePitchNearest(relPitchSemitones);
  const voicedCount = pitch.filter((v) => v != null).length;
  const voicedRatio = pitch.length ? voicedCount / pitch.length : 0;

  return {
    durationMs,
    envelope: Array.from(envelope),
    onsets,
    pitch,
    voicedRatio,
    peakRaw,
    silent: peakRaw < SILENCE_RAW_RMS_THRESHOLD,
  };
}

function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let meanA = 0, meanB = 0;
  for (let i = 0; i < n; i++) { meanA += a[i]; meanB += b[i]; }
  meanA /= n; meanB /= n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den < 1e-9) return 0;
  return num / den;
}

/** เลื่อน mimic envelope ไปมาเล็กน้อยเพื่อหา offset ที่เข้ากันดีที่สุดกับ reference (กันเผื่อเริ่มพูดช้า/เร็วนิดหน่อย) */
function bestAlignedCorrelation(refEnv, mimicEnv, maxShiftRatio = 0.2) {
  const n = refEnv.length;
  const maxShift = Math.max(1, Math.round(n * maxShiftRatio));
  let best = -1;
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const a = [];
    const b = [];
    for (let i = 0; i < n; i++) {
      const j = i + shift;
      if (j < 0 || j >= n) continue;
      a.push(refEnv[i]);
      b.push(mimicEnv[j]);
    }
    if (a.length < n * 0.5) continue;
    const r = pearsonCorrelation(a, b);
    if (r > best) best = r;
  }
  return best;
}

const MIN_PITCH_OVERLAP_POINTS = Math.round(ENVELOPE_POINTS * 0.12); // ต้องมีจุดที่ "ทั้งคู่มีระดับเสียงชัดเจน" อย่างน้อยเท่านี้

/**
 * เทียบเส้นทำนอง (relative pitch, มีบาง index เป็น null) ระหว่างต้นฉบับกับเสียงเลียนแบบ
 * โดยหา offset ที่เข้ากันดีที่สุดเช่นเดียวกับ envelope แต่คำนวณ correlation เฉพาะจุดที่ "ทั้งคู่" มีเสียงชัดเจน (ไม่ null)
 * ถ้าจุดที่ overlap กันน้อยเกินไป (เช่น ผู้เล่นพูดเสียงราบเรียบ/ไม่มีจังหวะขึ้นลงเลย ทั้งที่ต้นฉบับมีทำนองชัดเจน) จะให้คะแนน 0 ในมิตินี้
 */
function melodyCorrelation(refPitch, mimicPitch, maxShiftRatio = 0.2) {
  const n = refPitch.length;
  const maxShift = Math.max(1, Math.round(n * maxShiftRatio));
  let best = -1;
  let bestOverlap = 0;
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const a = [];
    const b = [];
    for (let i = 0; i < n; i++) {
      const j = i + shift;
      if (j < 0 || j >= n) continue;
      const rv = refPitch[i];
      const mv = mimicPitch[j];
      if (rv == null || mv == null) continue;
      a.push(rv);
      b.push(mv);
    }
    if (a.length < MIN_PITCH_OVERLAP_POINTS) continue;
    const r = pearsonCorrelation(a, b);
    if (r > best) { best = r; bestOverlap = a.length; }
  }
  if (bestOverlap < MIN_PITCH_OVERLAP_POINTS) return 0; // overlap ไม่พอ ถือว่าไม่ได้เลียนแบบทำนองเลย
  return Math.max(0, best);
}

/**
 * เปรียบเทียบ "ลายเซ็นเสียง" ของต้นฉบับกับของผู้เล่น แล้วให้คะแนน 0-100
 * รวม 3 มิติ: รูปทรงพลังเสียง (shape) + จังหวะ/จำนวนจุดเน้นเสียง (rhythm) + ทำนอง/ระดับเสียงสัมพัทธ์ (melody)
 * น้ำหนักของ melody จะถูกปรับตาม "ต้นฉบับมีทำนองชัดเจนแค่ไหน" (referenceSig.voicedRatio) —
 * ถ้าต้นฉบับเป็นเสียงเอฟเฟกต์ที่ไม่มีระดับเสียงชัดเจน ระบบจะไม่บังคับเทียบทำนอง (กลับไปดู shape+rhythm เป็นหลัก)
 * แต่ถ้าต้นฉบับมีทำนองชัดเจน การพูดมั่วๆ ให้แค่ระดับความดังตรงจังหวะจะไม่พอให้ได้คะแนนเต็มอีกต่อไป
 */
function scoreAgainstReference(referenceSig, mimicSig) {
  if (
    !mimicSig ||
    !mimicSig.envelope ||
    mimicSig.envelope.every((v) => v === 0) ||
    mimicSig.silent // แทบไม่มีเสียงจริงเข้ามาเลย (แค่ noise floor) ไม่ควรได้คะแนนจากการที่ shape สุ่มไปตรงกับต้นฉบับ
  ) {
    return { score: 0, shapeScore: 0, rhythmScore: 0, melodyScore: 0, effectivelySilent: true };
  }

  const shapeR = bestAlignedCorrelation(referenceSig.envelope, mimicSig.envelope);
  const shapeScore01 = Math.max(0, shapeR);

  const refOnsets = referenceSig.onsets || 1;
  const mimicOnsets = mimicSig.onsets || 0;
  const onsetDiff = Math.abs(refOnsets - mimicOnsets);
  const rhythmScore01 = Math.max(0, 1 - onsetDiff / Math.max(refOnsets, 1));

  const refVoicedRatio = referenceSig.voicedRatio || 0;
  const melodyApplicable = Math.max(0, Math.min(1, refVoicedRatio / 0.3)); // เต็มน้ำหนักเมื่อต้นฉบับ voiced >= 30%
  const melodyScore01 = melodyApplicable > 0 && referenceSig.pitch && mimicSig.pitch
    ? melodyCorrelation(referenceSig.pitch, mimicSig.pitch)
    : 0;

  const MELODY_WEIGHT_MAX = 0.35;
  const melodyWeight = MELODY_WEIGHT_MAX * melodyApplicable;
  const remaining = 1 - melodyWeight;
  const shapeWeight = remaining * 0.7;
  const rhythmWeight = remaining * 0.3;

  // กันเคส "ไม่ได้พูดเข้าไมค์เลย แต่ได้คะแนนเฉยๆ": ถ้าต้นฉบับคาดว่าต้องมีเสียงพูด/ทำนองชัดเจน (melodyApplicable > 0)
  // แต่การเลียนแบบแทบไม่มีช่วงที่จับโทนเสียง (pitch) ได้เลย (mimicVoicedRatio ต่ำกว่าเกณฑ์) แปลว่าไม่ได้อ้าปากพูดจริงๆ
  // (แค่เสียงรบกวน/noise รอบข้างที่บังเอิญมี envelope/จังหวะใกล้เคียงต้นฉบับ) ตัดคะแนนรวมทั้งหมดเป็น 0 ไปเลย
  // ไม่ใช่แค่มิติทำนองมิติเดียว เพราะ shape/rhythm ล้วนๆ ก็ยังถูกสุ่มเข้าให้ตรงโดยบังเอิญได้พอสมควร
  // ใช้เกณฑ์ตัดขาด (ไม่ใช่ลดสัดส่วน) เพราะ noise ธรรมดาก็มีโอกาสสุ่มผ่าน pitch-confidence ได้ประปรายอยู่แล้ว
  // การลดคะแนนแบบสัดส่วนจึงยังเหลือคะแนนติดไม้ติดมือ ต้องตัดขาดถึงจะกันได้จริง
  const VOICE_PRESENCE_MIN = 0.15; // ต่ำกว่านี้ถือว่า "ไม่ได้พูดจริงจัง" เลย (เสียงพูดจริงมักมีสัดส่วนนี้สูงกว่านี้มาก)
  const mimicVoicedRatio = mimicSig.voicedRatio || 0;
  const voicePresenceFactor = melodyApplicable > 0 && mimicVoicedRatio < VOICE_PRESENCE_MIN ? 0 : 1;

  const combined = (shapeScore01 * shapeWeight + rhythmScore01 * rhythmWeight + melodyScore01 * melodyWeight) * voicePresenceFactor;
  const score = Math.round(Math.max(0, Math.min(1, combined)) * 100);

  return {
    score,
    shapeScore: Math.round(shapeScore01 * 100),
    rhythmScore: Math.round(rhythmScore01 * 100),
    melodyScore: Math.round(melodyScore01 * 100),
    melodyApplicable: Math.round(melodyApplicable * 100),
    // ใช้บอกฝั่งแสดงผล (กราฟ/ป้ายกำกับ) ว่า "ไม่ได้พูดจริงจัง" แม้ไมค์จะรับเสียงอะไรเข้ามาบ้างก็ตาม
    // (ครอบคลุมทั้งเคสเงียบสนิท และเคสมี noise แต่ไม่มีเสียงพูด/ทำนองเลยทั้งที่ต้นฉบับคาดว่าต้องมี)
    effectivelySilent: voicePresenceFactor === 0,
  };
}

module.exports = {
  analyzeFile,
  scoreAgainstReference,
  ENVELOPE_POINTS,
  SILENCE_RAW_RMS_THRESHOLD,
};

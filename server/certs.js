// server/certs.js
// สร้าง (หรือโหลด) self-signed TLS certificate สำหรับรัน HTTPS ในวง LAN
// จำเป็นเพราะเบราว์เซอร์สมัยใหม่ (Chrome/Firefox/Safari) จะไม่ยอมให้เว็บไซต์ขอสิทธิ์ใช้ไมโครโฟน (getUserMedia)
// ถ้าเปิดผ่าน http:// ธรรมดาบน IP วง LAN (ถือว่าไม่ใช่ "secure context") — ยกเว้น localhost เท่านั้น

const fs = require('fs');
const path = require('path');

const CERT_DIR = path.join(__dirname, '..', 'data', 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');

function getOrCreateCert() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    return { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) };
  }
  const selfsigned = require('selfsigned');
  const attrs = [{ name: 'commonName', value: 'mimic-party.local' }];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }],
  });
  fs.writeFileSync(KEY_PATH, pems.private);
  fs.writeFileSync(CERT_PATH, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

module.exports = { getOrCreateCert };

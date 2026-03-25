const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || 'guandan-default-key-2026-silicon-valley';
  // Derive a stable 32-byte key via SHA-256, works with any input length
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(text) {
  if (!text) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    const key = getKey();
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return '[解密失败 | Decrypt Error]';
  }
}

module.exports = { encrypt, decrypt };

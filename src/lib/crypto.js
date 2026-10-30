const crypto = require('crypto');

// AES-256-GCM para secretos guardados en BD (tokens de Meta, API keys)
function key() {
  return crypto.createHash('sha256').update(String(process.env.APP_KEY || '')).digest();
}

function encrypt(texto) {
  if (!texto) return '';
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc    = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  return 'enc:' + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(valor) {
  if (!valor) return '';
  if (!String(valor).startsWith('enc:')) return valor;
  try {
    const buf      = Buffer.from(valor.slice(4), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('⚠️ No se pudo descifrar un secreto (¿cambió APP_KEY?)');
    return '';
  }
}

function tokenAleatorio(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { encrypt, decrypt, tokenAleatorio };

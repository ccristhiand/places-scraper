const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '../../.env');

// Genera JWT_SECRET y APP_KEY si faltan y los persiste en .env
// (APP_KEY cifra los secretos guardados en BD: si se pierde, hay que volver a cargarlos)
function ensureSecrets() {
  const faltan = [];
  if (!process.env.JWT_SECRET) faltan.push(['JWT_SECRET', crypto.randomBytes(48).toString('hex')]);
  if (!process.env.APP_KEY)    faltan.push(['APP_KEY',    crypto.randomBytes(32).toString('hex')]);
  if (!faltan.length) return;

  const lineas = faltan.map(([k, v]) => { process.env[k] = v; return `${k}=${v}`; }).join('\n');
  try {
    fs.appendFileSync(ENV_PATH, `\n# Generado automáticamente — NO compartir ni subir a git\n${lineas}\n`);
    console.log('🔐 Secretos generados en .env:', faltan.map(f => f[0]).join(', '));
  } catch (e) {
    console.warn('⚠️ No se pudo escribir .env; los secretos generados solo duran este proceso');
  }
}

module.exports = { ensureSecrets };

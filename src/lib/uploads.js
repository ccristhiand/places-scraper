const multer = require('multer');
const path   = require('path');
const crypto = require('crypto');
const fs     = require('fs');

const DIR = path.join(__dirname, '../../uploads');
fs.mkdirSync(DIR, { recursive: true });

const PERMITIDOS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// Nombre aleatorio + extensión según el MIME: nunca se usa el nombre que manda el cliente
const upload = multer({
  storage: multer.diskStorage({
    destination: DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${PERMITIDOS[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (PERMITIDOS[file.mimetype]) return cb(null, true);
    const err = new Error('Solo se permiten imágenes JPG, PNG o WEBP (máx. 5 MB).');
    err.status = 400;
    cb(err);
  },
});

module.exports = { upload, DIR };

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

// Documentos de proyectos (contratos, propuestas, actas…) en uploads/docs
const DIR_DOCS = path.join(DIR, 'docs');
fs.mkdirSync(DIR_DOCS, { recursive: true });
const DOCS = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
  'text/plain': '.txt', 'text/csv': '.csv',
  ...PERMITIDOS,
};
const uploadDoc = multer({
  storage: multer.diskStorage({
    destination: DIR_DOCS,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${DOCS[file.mimetype]}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (DOCS[file.mimetype]) return cb(null, true);
    const err = new Error('Formato no permitido. Sube PDF, Word, Excel, PowerPoint, imagen, ZIP o texto (máx. 15 MB).');
    err.status = 400;
    cb(err);
  },
});

module.exports = { upload, uploadDoc, DIR };

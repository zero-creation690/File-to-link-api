const express = require('express');
const cors = require('cors');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// ------------------------
// Telegram Bot Configuration
// ------------------------
const BOT_TOKEN = '8462261408:AAH75k38CJV4ZmrG8ZAnAI6HR7MHtT-SxB8';
const CHANNEL_ID = -1002897456594; // bot must be admin
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ------------------------
// Temporary Upload Directory
// ------------------------
const UPLOAD_DIR = '/tmp/uploads';
fs.ensureDirSync(UPLOAD_DIR);

// ------------------------
// Multer Config (Large Files)
// ------------------------
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // max 2 GB per file for Telegram bot
});

// ------------------------
// Helper: Safe but original filename
// ------------------------
function safeFileName(name) {
  // Remove only problematic characters for HTTP headers
  let ext = path.extname(name) || '';
  let base = path.basename(name, ext)
                  .replace(/[\n\r"]/g, '_')
                  .slice(0, 100); // limit base name to 100 chars
  return base + ext;
}

// ------------------------
// Upload Endpoint
// ------------------------
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const originalName = req.file.originalname;

    // Upload file to Telegram
    const message = await bot.sendDocument(CHANNEL_ID, fs.createReadStream(filePath));

    // Remove temp file
    fs.unlinkSync(filePath);

    // Permanent download link
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const downloadLink = `${protocol}://${host}/download/${message.document.file_id}?filename=${encodeURIComponent(originalName)}`;

    res.json({
      file_name: originalName,
      hotlink: downloadLink
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------
// Download Endpoint
// ------------------------
app.get('/download/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    let fileName = req.query.filename || 'file';
    fileName = safeFileName(fileName);

    // Get Telegram file info
    const file = await bot.getFile(fileId);
    if (!file || !file.file_path) throw new Error('File not found');

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Stream file safely
    const response = await axios.get(fileUrl, {
      responseType: 'stream',
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    response.data.pipe(res);

  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'File not found or cannot download' });
  }
});

module.exports = app;

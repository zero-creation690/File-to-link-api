// api/index.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream');
const util = require('util');
const streamPipeline = util.promisify(pipeline);

const app = express();
app.use(express.json());
app.use(cors());

// ------------------------
// CONFIG - update if needed
// ------------------------
const BOT_TOKEN = '8462261408:AAH75k38CJV4ZmrG8ZAnAI6HR7MHtT-SxB8';
const CHANNEL_ID = -1002897456594; // must be correct and bot must be admin
const TELEGRAM_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const UPLOAD_DIR = '/tmp/uploads';

// ------------------------
// Telegram bot init
// ------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ------------------------
// Ensure tmp directory
// ------------------------
fs.ensureDirSync(UPLOAD_DIR);

// ------------------------
// Multer config (single file)
// ------------------------
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: TELEGRAM_MAX_FILE_BYTES }
});

// ------------------------
// Helpers
// ------------------------
function safeFileName(name) {
  // Preserve extension but remove problematic header characters
  const ext = path.extname(name) || '';
  const base = path.basename(name, ext)
    .replace(/[\r\n"]/g, '_')       // remove newlines and quotes
    .replace(/[^a-zA-Z0-9\-\._ ]/g, '_') // replace other weird chars with underscore
    .slice(0, 120);                 // limit length
  return (base || 'file') + ext;
}

function makeDownloadUrl(req, fileId, originalName) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers.host || req.get('host');
  const safeName = encodeURIComponent(originalName || 'file');
  return `${protocol}://${host}/download/${fileId}?filename=${safeName}`;
}

// ------------------------
// Upload endpoint
// Accepts multipart/form-data 'file' or body.file_url
// ------------------------
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    let filePath;
    let originalName;

    // If file uploaded via form
    if (req.file) {
      filePath = req.file.path;
      originalName = req.file.originalname || req.file.filename;
    }
    // Or file_url provided in body (JSON or form)
    else if (req.body && req.body.file_url) {
      const fileUrl = req.body.file_url;
      originalName = path.basename((fileUrl.split('?')[0] || '').trim()) || 'file';
      filePath = path.join(UPLOAD_DIR, originalName);

      // Stream remote file to disk
      const r = await axios.get(fileUrl, { responseType: 'stream', timeout: 0, maxContentLength: Infinity, maxBodyLength: Infinity });
      const writer = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        r.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } else {
      return res.status(400).json({ error: 'No file (field "file") or file_url provided' });
    }

    // Basic file size check (multer also enforces this)
    const stats = await fs.stat(filePath);
    if (stats.size > TELEGRAM_MAX_FILE_BYTES) {
      // remove temp file
      try { await fs.unlink(filePath); } catch(_) {}
      return res.status(413).json({ error: `File too large. Max allowed: ${TELEGRAM_MAX_FILE_BYTES} bytes (Telegram limit).` });
    }

    // Send document to Telegram channel
    let message;
    try {
      message = await bot.sendDocument(CHANNEL_ID, fs.createReadStream(filePath));
    } catch (tgErr) {
      // cleanup
      try { await fs.unlink(filePath); } catch(_) {}
      console.error('Telegram upload error:', tgErr);
      // Provide helpful error if chat not found
      if (tgErr && tgErr.response && tgErr.response.body && /chat not found/i.test(JSON.stringify(tgErr.response.body))) {
        return res.status(400).json({ error: 'Telegram error: chat not found. Make sure the bot is added to the channel and is an admin.' });
      }
      return res.status(502).json({ error: 'Telegram upload failed', details: tgErr.message || tgErr.toString() });
    }

    // cleanup local file
    try { await fs.unlink(filePath); } catch(_) {}

    // Build download URL using file_id from Telegram
    const fileId = message && message.document && message.document.file_id;
    if (!fileId) {
      return res.status(500).json({ error: 'Telegram returned no file_id' });
    }

    const downloadLink = makeDownloadUrl(req, fileId, originalName);

    return res.json({
      file_name: originalName,
      file_size: stats.size,
      hotlink: downloadLink
    });

  } catch (err) {
    console.error('Upload handler error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ------------------------
// Download endpoint
// Streams file from Telegram to client using pipeline
// ------------------------
app.get('/download/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const requestedName = req.query.filename || 'file';
    const fileName = safeFileName(decodeURIComponent(requestedName));

    // Get Telegram file object (contains file_path)
    const file = await bot.getFile(fileId).catch(err => {
      console.error('bot.getFile error:', err && err.response ? err.response.body : err);
      throw new Error('Telegram file not found or bot lacks permission to access it.');
    });

    if (!file || !file.file_path) throw new Error('File metadata not found');

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // HEAD request to get content-length if possible
    let contentLength = null;
    try {
      const head = await axios.head(fileUrl, { timeout: 5000 });
      if (head && head.headers && head.headers['content-length']) {
        contentLength = head.headers['content-length'];
        res.setHeader('Content-Length', contentLength);
      }
    } catch (e) {
      // ignore HEAD failure (some Telegram file URLs may not respond to HEAD)
    }

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const response = await axios.get(fileUrl, {
      responseType: 'stream',
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    // pipe and await completion
    await streamPipeline(response.data, res);
  } catch (err) {
    console.error('Download handler error:', err);
    // Show clearer error messages to client
    const msg = (err && err.message) ? err.message : 'File not found or cannot download';
    return res.status(404).json({ error: msg });
  }
});

module.exports = app;

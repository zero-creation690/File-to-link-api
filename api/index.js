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
// Multer Config
// ------------------------
const upload = multer({ dest: UPLOAD_DIR });

// ------------------------
// Helper: sanitize filename
// ------------------------
function sanitizeFileName(name) {
  let sanitized = name
    .replace(/[^a-zA-Z0-9.\-_ ]/g, '') // remove emojis and special chars
    .replace(/\s+/g, '_') // replace spaces with underscores
    .slice(0, 60);        // limit length
  if (!sanitized.includes('.')) sanitized += '.dat'; // fallback extension
  return sanitized;
}

// ------------------------
// Upload Endpoint
// ------------------------
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    let filePath, fileName;

    // Handle file upload
    if (req.file) {
      filePath = req.file.path;
      fileName = req.file.originalname;
    } 
    // Handle file URL
    else if (req.body.file_url) {
      const url = req.body.file_url;
      fileName = path.basename(url);
      const response = await axios.get(url, { responseType: 'stream' });
      filePath = path.join(UPLOAD_DIR, fileName);
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } 
    else {
      return res.status(400).json({ error: 'No file or file_url provided' });
    }

    // Upload file to Telegram channel
    const message = await bot.sendDocument(CHANNEL_ID, fs.createReadStream(filePath));

    // Clean up temp file
    fs.unlinkSync(filePath);

    // Generate permanent download link
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const sanitizedFileName = sanitizeFileName(fileName);
    const downloadLink = `${protocol}://${host}/download/${message.document.file_id}?filename=${encodeURIComponent(sanitizedFileName)}`;

    res.json({
      file_name: fileName,
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
    fileName = sanitizeFileName(fileName);

    // Get Telegram file info
    const file = await bot.getFile(fileId);
    if (!file || !file.file_path) throw new Error('File not found');

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Stream file with proper download headers
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    response.data.pipe(res);

  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'File not found or cannot download' });
  }
});

module.exports = app;

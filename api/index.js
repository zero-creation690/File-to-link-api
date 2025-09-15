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

// Telegram config
const BOT_TOKEN = '8462261408:AAH75k38CJV4ZmrG8ZAnAI6HR7MHtT-SxB8';
const CHANNEL_ID = -1002897456594;
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Temp uploads folder
const UPLOAD_DIR = '/tmp/uploads';
fs.ensureDirSync(UPLOAD_DIR);

// Multer config
const upload = multer({ dest: UPLOAD_DIR });

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    let filePath, fileName;

    if (req.file) {
      filePath = req.file.path;
      fileName = req.file.originalname;
    } else if (req.body.file_url) {
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
    } else {
      return res.status(400).json({ error: 'No file or file_url provided' });
    }

    // Upload to Telegram channel
    const message = await bot.sendDocument(CHANNEL_ID, fs.createReadStream(filePath));

    // Clean temp file
    fs.unlinkSync(filePath);

    // Generate API permanent download URL dynamically
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const downloadLink = `${protocol}://${host}/download/${message.document.file_id}?filename=${encodeURIComponent(fileName)}`;

    res.json({
      file_name: fileName,
      hotlink: downloadLink
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Download endpoint
app.get('/download/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const fileName = req.query.filename || 'file';

    // Get Telegram file path
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Fetch and stream with proper headers
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    response.data.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'File not found or cannot download' });
  }
});

module.exports = app;

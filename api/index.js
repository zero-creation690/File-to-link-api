// server.js
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

// =========================
// Telegram Bot Config
// =========================
const BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const CHANNEL_ID = -1000000000000; // Replace with your channel ID
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// =========================
// Temp folder for uploads
// =========================
const UPLOAD_DIR = '/tmp/uploads';
fs.ensureDirSync(UPLOAD_DIR);

// =========================
// Multer Config (allow up to 3 files)
// =========================
const upload = multer({ dest: UPLOAD_DIR });

// =========================
// Upload Endpoint (multiple files)
// =========================
app.post('/upload', upload.array('files', 3), async (req, res) => {
  try {
    if ((!req.files || req.files.length === 0) && !req.body.file_urls) {
      return res.status(400).json({ error: 'No file(s) or file_url(s) provided' });
    }

    let uploadResults = [];

    // Handle uploaded files
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const filePath = file.path;
        const fileName = file.originalname;

        const message = await bot.sendDocument(CHANNEL_ID, fs.createReadStream(filePath));
        fs.unlinkSync(filePath);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers.host;
        const downloadLink = `${protocol}://${host}/download/${message.document.file_id}?filename=${encodeURIComponent(fileName)}`;

        uploadResults.push({ file_name: fileName, hotlink: downloadLink });
      }
    }

    // Handle file URLs if provided
    if (req.body.file_urls) {
      const urls = Array.isArray(req.body.file_urls) ? req.body.file_urls : [req.body.file_urls];
      for (const url of urls.slice(0, 3)) { // limit 3
        const fileName = path.basename(url.split('?')[0]);
        const filePath = path.join(UPLOAD_DIR, fileName);

        const response = await axios.get(url, { responseType: 'stream' });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        const message = await bot.sendDocument(CHANNEL_ID, fs.createReadStream(filePath));
        fs.unlinkSync(filePath);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers.host;
        const downloadLink = `${protocol}://${host}/download/${message.document.file_id}?filename=${encodeURIComponent(fileName)}`;

        uploadResults.push({ file_name: fileName, hotlink: downloadLink });
      }
    }

    res.json({ uploaded: uploadResults });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Download Endpoint
// =========================
app.get('/download/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const fileName = req.query.filename || 'file';

    const file = await bot.getFile(fileId);
    if (!file || !file.file_path) throw new Error('File not found');

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await axios.get(fileUrl, {
      responseType: 'stream',
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    await streamPipeline(response.data, res);

  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'File not found or cannot download' });
  }
});

module.exports = app;

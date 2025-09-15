const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors()); // Allow all origins

// ------------------------------
// Telegram Config
// ------------------------------
const BOT_TOKEN = '8462261408:AAH75k38CJV4ZmrG8ZAnAI6HR7MHtT-SxB8';
const CHANNEL_ID = -1002897456594; // your private channel ID
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ------------------------------
// Temp uploads folder
// ------------------------------
const UPLOAD_DIR = '/tmp/uploads';
fs.ensureDirSync(UPLOAD_DIR);

// ------------------------------
// Multer config
// ------------------------------
const upload = multer({ dest: UPLOAD_DIR });

// ------------------------------
// Upload endpoint
// ------------------------------
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

    // Upload file to Telegram channel
    const message = await bot.sendDocument(CHANNEL_ID, fs.createReadStream(filePath));

    // Clean up temp file
    fs.unlinkSync(filePath);

    // Return permanent hotlink using message_id
    const downloadLink = `https://file-to-link-api-45zb.vercel.app/download/${message.message_id}`;
    res.json({ file_name: fileName, hotlink: downloadLink });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ------------------------------
// Download endpoint
// ------------------------------
app.get('/download/:message_id', async (req, res) => {
  try {
    const messageId = req.params.message_id;

    // Telegram Bot API does not allow fetching by message_id directly,
    // but we can use the known message_id as part of our hotlink strategy.
    // For simplicity, we assume the file exists in the channel.
    const file = await bot.getFile(messageId).catch(err => {
      throw new Error('File not found or bot cannot access the channel');
    });

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await axios.get(fileUrl, { responseType: 'stream' });

    res.setHeader('Content-Disposition', `attachment; filename="${file.file_path.split('/').pop()}"`);
    response.data.pipe(res);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;

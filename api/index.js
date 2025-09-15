const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

// ------------------------------
// Telegram Config
// ------------------------------
const BOT_TOKEN = '8462261408:AAH75k38CJV4ZmrG8ZAnAI6HR7MHtT-SxB8';
const CHANNEL_ID = -1002897456594;
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ------------------------------
// Temp uploads folder
// ------------------------------
const UPLOAD_DIR = '/tmp/uploads';
fs.ensureDirSync(UPLOAD_DIR);

// ------------------------------
// Mapping file to store permanent links
// ------------------------------
const DATA_FILE = path.join(__dirname, '../data/files.json');
fs.ensureFileSync(DATA_FILE);

let fileMapping = {};
try {
  fileMapping = fs.readJsonSync(DATA_FILE);
} catch {
  fileMapping = {};
}

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

    // Save permanent mapping
    fileMapping[message.message_id] = message.document.file_id;
    fs.writeJsonSync(DATA_FILE, fileMapping, { spaces: 2 });

    // Clean up temp file
    fs.unlinkSync(filePath);

    // Permanent download link
    const downloadLink = `https://zerocreation.vercel.app/download/${message.message_id}`;
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

    if (!fileMapping[messageId]) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fileId = fileMapping[messageId];
    const fileObj = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileObj.file_path}`;

    const response = await axios.get(fileUrl, { responseType: 'stream' });
    res.setHeader('Content-Disposition', `attachment; filename="${fileObj.file_path.split('/').pop()}"`);
    response.data.pipe(res);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;

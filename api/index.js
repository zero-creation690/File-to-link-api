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
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input'); // For user input when needed

const app = express();

// ------------------------
// Security & Performance Middleware
// ------------------------
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/upload', limiter);

// ------------------------
// CONFIG - Enhanced for 6GB support
// ------------------------
const BOT_TOKEN = '8303908376:AAEL1dL0BjpmpbdYjZ5yQmgb1UJLa_OMbGk';
const CHANNEL_ID = -1002995694885;
const TELEGRAM_MAX_FILE_BYTES = 6 * 1024 * 1024 * 1024; // 6 GB (increased from 4GB)
const UPLOAD_DIR = '/tmp/uploads';
const CHUNK_SIZE = 2000 * 1024 * 1024; // 2GB chunks for large files

// Telegram User API credentials (for larger files)
const API_ID = 20288994;
const API_HASH = "d702614912f1ad370a0d18786002adbf";
const stringSession = new StringSession(""); // You can save and reuse sessions

// Video file extensions for streaming
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.ts', '.m2ts'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'];

// ------------------------
// Telegram bot init with webhook support
// ------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ------------------------
// Telegram User Client (for larger files)
// ------------------------
const client = new TelegramClient(stringSession, API_ID, API_HASH, {
  connectionRetries: 5,
});

// Initialize Telegram client
(async () => {
  await client.start({
    phoneNumber: async () => await input.text("Please enter your number: "),
    password: async () => await input.text("Please enter your password: "),
    phoneCode: async () => await input.text("Please enter the code you received: "),
    onError: (err) => console.log(err),
  });
  console.log("You should now be connected.");
  console.log("Session string:", client.session.save()); // Save this string to avoid logging in again
})();

// ------------------------
// Ensure directories
// ------------------------
fs.ensureDirSync(UPLOAD_DIR);

// ------------------------
// Enhanced Multer config with better error handling
// ------------------------
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { 
    fileSize: TELEGRAM_MAX_FILE_BYTES,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Accept all file types
    cb(null, true);
  }
});

// ------------------------
// Enhanced Helpers
// ------------------------
function safeFileName(name) {
  if (!name) return 'file';
  const ext = path.extname(name) || '';
  const base = path.basename(name, ext)
    .replace(/[\r\n"'`]/g, '_')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[^\w\s\-\.]/g, '_')
    .trim()
    .slice(0, 100);
  return (base || 'file') + ext;
}

function isVideoFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

function isAudioFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext);
}

function makeDownloadUrl(req, fileId, originalName) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers.host || req.get('host');
  const safeName = encodeURIComponent(safeFileName(originalName || 'file'));
  return `${protocol}://${host}/download/${fileId}?filename=${safeName}`;
}

function makeStreamUrl(req, fileId, originalName) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers.host || req.get('host');
  const safeName = encodeURIComponent(safeFileName(originalName || 'file'));
  return `${protocol}://${host}/stream/${fileId}?filename=${safeName}`;
}

function makePlayerUrl(req, fileId, originalName) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers.host || req.get('host');
  const safeName = encodeURIComponent(safeFileName(originalName || 'file'));
  return `${protocol}://${host}/player/${fileId}?filename=${safeName}`;
}

// ------------------------
// File upload with chunking for large files
// ------------------------
async function uploadLargeFile(filePath, originalName, chatId) {
  const stats = await fs.stat(filePath);
  
  if (stats.size <= 2000 * 1024 * 1024) { // 2GB or less, single upload
    return await bot.sendDocument(chatId, fs.createReadStream(filePath), {
      caption: `📁 ${originalName}\n💾 Size: ${formatFileSize(stats.size)}`
    });
  }

  // For files larger than 2GB, use Telegram user client which supports larger files
  try {
    console.log(`📤 Uploading large file (${formatFileSize(stats.size)}) using Telegram client...`);
    
    const result = await client.sendFile(chatId, {
      file: filePath,
      caption: `📁 ${originalName}\n💾 Size: ${formatFileSize(stats.size)}`
    });
    
    console.log("✅ Large file uploaded successfully via Telegram client");
    return result;
  } catch (error) {
    console.error("❌ Error uploading via Telegram client:", error);
    
    // Fallback to chunking if user client fails
    console.log("🔄 Falling back to chunking method...");
    const chunks = Math.ceil(stats.size / CHUNK_SIZE);
    const messages = [];

    for (let i = 0; i < chunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, stats.size);
      const chunkPath = `${filePath}.chunk${i}`;
      
      // Create chunk file
      const readStream = fs.createReadStream(filePath, { start, end: end - 1 });
      const writeStream = fs.createWriteStream(chunkPath);
      await streamPipeline(readStream, writeStream);
      
      try {
        const message = await bot.sendDocument(chatId, fs.createReadStream(chunkPath), {
          caption: `📁 ${originalName} (Part ${i + 1}/${chunks})\n💾 Chunk Size: ${formatFileSize(end - start)}`
        });
        messages.push(message);
      } finally {
        await fs.unlink(chunkPath).catch(() => {});
      }
    }

    return messages[0]; // Return first chunk message
  }
}

function formatFileSize(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// ------------------------
// Hostio Upload Page
// ------------------------
app.get('/', (req, res) => {
  const uploadPage = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hostio - File Uploader</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }
        
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            max-width: 800px;
            width: 100%;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 15px 35px rgba(0, 0, 0, 0.2);
            backdrop-filter: blur(10px);
            text-align: center;
        }
        
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 2.5rem;
        }
        
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 1.1rem;
        }
        
        .upload-container {
            border: 3px dashed #667eea;
            border-radius: 15px;
            padding: 40px 20px;
            margin: 20px 0;
            transition: all 0.3s ease;
            background: rgba(102, 126, 234, 0.05);
        }
        
        .upload-container.drag-over {
            background: rgba(102, 126, 234, 0.2);
            border-color: #764ba2;
        }
        
        .upload-icon {
            font-size: 4rem;
            color: #667eea;
            margin-bottom: 20px;
        }
        
        .upload-text {
            margin-bottom: 20px;
            color: #555;
        }
        
        .file-input {
            display: none;
        }
        
        .browse-btn {
            background: #667eea;
            color: white;
            padding: 12px 30px;
            border: none;
            border-radius: 50px;
            cursor: pointer;
            font-size: 1rem;
            font-weight: 600;
            transition: all 0.3s ease;
            margin: 10px;
        }
        
        .browse-btn:hover {
            background: #5a6fd8;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }
        
        .url-upload {
            margin-top: 30px;
            padding-top: 30px;
            border-top: 1px solid #eee;
        }
        
        .url-input {
            width: 100%;
            padding: 15px;
            border: 2px solid #ddd;
            border-radius: 10px;
            font-size: 1rem;
            margin-bottom: 15px;
            transition: border-color 0.3s ease;
        }
        
        .url-input:focus {
            border-color: #667eea;
            outline: none;
        }
        
        .features {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 20px;
            margin: 30px 0;
        }
        
        .feature {
            flex: 1;
            min-width: 200px;
            background: rgba(102, 126, 234, 0.1);
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        
        .feature-icon {
            font-size: 2rem;
            color: #667eea;
            margin-bottom: 10px;
        }
        
        .progress-container {
            display: none;
            margin: 20px 0;
        }
        
        .progress-bar {
            height: 10px;
            background: #eee;
            border-radius: 5px;
            overflow: hidden;
        }
        
        .progress {
            height: 100%;
            background: linear-gradient(90deg, #667eea, #764ba2);
            width: 0%;
            transition: width 0.3s ease;
        }
        
        .result {
            display: none;
            margin-top: 30px;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
            text-align: left;
        }
        
        .result-success {
            border-left: 5px solid #28a745;
        }
        
        .result-error {
            border-left: 5px solid #dc3545;
        }
        
        .link-box {
            background: white;
            padding: 15px;
            border-radius: 8px;
            margin: 10px 0;
            word-break: break-all;
            font-family: monospace;
        }
        
        .copy-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 8px 15px;
            border-radius: 5px;
            cursor: pointer;
            margin-left: 10px;
        }
        
        @media (max-width: 768px) {
            .container {
                padding: 20px;
            }
            
            h1 {
                font-size: 2rem;
            }
            
            .features {
                flex-direction: column;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Hostio</h1>
        <p class="subtitle">Upload and share files up to 6GB</p>
        
        <div class="upload-container" id="dropZone">
            <div class="upload-icon">📤</div>
            <p class="upload-text">Drag & drop your files here</p>
            <p class="upload-text">or</p>
            <input type="file" id="fileInput" class="file-input" multiple>
            <button class="browse-btn" onclick="document.getElementById('fileInput').click()">Browse Files</button>
            <p class="upload-text">Max file size: 6GB</p>
        </div>
        
        <div class="url-upload">
            <h3>Or upload from URL</h3>
            <input type="text" class="url-input" id="urlInput" placeholder="https://example.com/file.zip">
            <button class="browse-btn" onclick="uploadFromUrl()">Upload from URL</button>
        </div>
        
        <div class="progress-container" id="progressContainer">
            <p>Uploading... <span id="progressPercent">0%</span></p>
            <div class="progress-bar">
                <div class="progress" id="progressBar"></div>
            </div>
        </div>
        
        <div class="result" id="resultContainer"></div>
        
        <div class="features">
            <div class="feature">
                <div class="feature-icon">⚡</div>
                <h3>Fast Uploads</h3>
                <p>Powered by Telegram's infrastructure</p>
            </div>
            <div class="feature">
                <div class="feature-icon">🔒</div>
                <h3>Secure</h3>
                <p>Your files are stored securely</p>
            </div>
            <div class="feature">
                <div class="feature-icon">📱</div>
                <h3>Streaming</h3>
                <p>Direct video & audio streaming</p>
            </div>
        </div>
    </div>

    <script>
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        const urlInput = document.getElementById('urlInput');
        const progressContainer = document.getElementById('progressContainer');
        const progressBar = document.getElementById('progressBar');
        const progressPercent = document.getElementById('progressPercent');
        const resultContainer = document.getElementById('resultContainer');
        
        // Drag and drop handling
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
        });
        
        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }
        
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, highlight, false);
        });
        
        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, unhighlight, false);
        });
        
        function highlight() {
            dropZone.classList.add('drag-over');
        }
        
        function unhighlight() {
            dropZone.classList.remove('drag-over');
        }
        
        dropZone.addEventListener('drop', handleDrop, false);
        
        function handleDrop(e) {
            const dt = e.dataTransfer;
            const files = dt.files;
            handleFiles(files);
        }
        
        fileInput.addEventListener('change', function() {
            handleFiles(this.files);
        });
        
        function handleFiles(files) {
            if (files.length === 0) return;
            
            // For now, just process the first file
            uploadFile(files[0]);
        }
        
        function uploadFromUrl() {
            const url = urlInput.value.trim();
            if (!url) {
                alert('Please enter a valid URL');
                return;
            }
            
            // Validate URL format
            try {
                new URL(url);
            } catch (e) {
                alert('Please enter a valid URL');
                return;
            }
            
            uploadUrl(url);
        }
        
        function uploadFile(file) {
            // Show progress
            progressContainer.style.display = 'block';
            resultContainer.style.display = 'none';
            
            const formData = new FormData();
            formData.append('file', file);
            
            const xhr = new XMLHttpRequest();
            
            // Progress tracking
            xhr.upload.addEventListener('progress', function(e) {
                if (e.lengthComputable) {
                    const percentComplete = (e.loaded / e.total) * 100;
                    progressBar.style.width = percentComplete + '%';
                    progressPercent.textContent = Math.round(percentComplete) + '%';
                }
            });
            
            xhr.addEventListener('load', function() {
                try {
                    const response = JSON.parse(xhr.responseText);
                    showResult(response);
                } catch (e) {
                    showError('Upload failed: Invalid response from server');
                }
            });
            
            xhr.addEventListener('error', function() {
                showError('Upload failed: Network error');
            });
            
            xhr.open('POST', '/upload');
            xhr.send(formData);
        }
        
        function uploadUrl(url) {
            progressContainer.style.display = 'block';
            resultContainer.style.display = 'none';
            progressBar.style.width = '0%';
            progressPercent.textContent = '0%';
            
            // For URL uploads, we can't track progress the same way
            progressPercent.textContent = 'Processing...';
            
            fetch('/upload', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ file_url: url })
            })
            .then(response => response.json())
            .then(data => {
                showResult(data);
            })
            .catch(error => {
                showError('Upload failed: ' + error.message);
            });
        }
        
        function showResult(data) {
            progressContainer.style.display = 'none';
            resultContainer.style.display = 'block';
            
            if (data.success) {
                resultContainer.className = 'result result-success';
                resultContainer.innerHTML = `
                    <h3>✅ Upload Successful!</h3>
                    <p>File: <strong>${data.file_name}</strong></p>
                    <p>Size: <strong>${data.file_size_formatted}</strong></p>
                    
                    <p>Download URL:</p>
                    <div class="link-box">
                        ${data.download_url}
                        <button class="copy-btn" onclick="copyToClipboard('${data.download_url}')">Copy</button>
                    </div>
                `;
                
                if (data.stream_url) {
                    resultContainer.innerHTML += `
                        <p>Stream URL:</p>
                        <div class="link-box">
                            ${data.stream_url}
                            <button class="copy-btn" onclick="copyToClipboard('${data.stream_url}')">Copy</button>
                        </div>
                        
                        <p>Player URL:</p>
                        <div class="link-box">
                            ${data.player_url}
                            <button class="copy-btn" onclick="copyToClipboard('${data.player_url}')">Copy</button>
                        </div>
                    `;
                }
            } else {
                showError(data.error || 'Upload failed');
            }
        }
        
        function showError(message) {
            progressContainer.style.display = 'none';
            resultContainer.style.display = 'block';
            resultContainer.className = 'result result-error';
            resultContainer.innerHTML = `
                <h3>❌ Upload Failed</h3>
                <p>${message}</p>
            `;
        }
        
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert('Copied to clipboard!');
            }).catch(err => {
                console.error('Could not copy text: ', err);
            });
        }
    </script>
</body>
</html>
  `;
  
  res.send(uploadPage);
});

// ------------------------
// Enhanced Upload endpoint
// ------------------------
app.post('/upload', upload.single('file'), async (req, res) => {
  let filePath = null;
  
  try {
    let originalName;
    let fileSize;

    // Handle file upload
    if (req.file) {
      filePath = req.file.path;
      originalName = req.file.originalname || req.file.filename;
      fileSize = req.file.size;
    }
    // Handle URL upload
    else if (req.body?.file_url) {
      const fileUrl = req.body.file_url;
      originalName = path.basename((fileUrl.split('?')[0] || '').trim()) || 'file';
      filePath = path.join(UPLOAD_DIR, `${Date.now()}_${safeFileName(originalName)}`);

      console.log(`📥 Downloading from URL: ${fileUrl}`);
      
      const response = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'stream',
        timeout: 30000,
        maxContentLength: TELEGRAM_MAX_FILE_BYTES,
        maxBodyLength: TELEGRAM_MAX_FILE_BYTES
      });

      const writer = fs.createWriteStream(filePath);
      await streamPipeline(response.data, writer);
      
      const stats = await fs.stat(filePath);
      fileSize = stats.size;
    } 
    // Handle Telegram bot integration
    else if (req.body?.telegram_file_id) {
      return res.json({ 
        error: 'Direct Telegram file processing not implemented yet',
        message: 'Please use file upload or URL method' 
      });
    }
    else {
      return res.status(400).json({ 
        error: 'No file provided',
        message: 'Please provide a file via form upload or file_url parameter',
        supported_methods: ['multipart/form-data with file field', 'JSON with file_url field']
      });
    }

    // Validate file size
    if (fileSize > TELEGRAM_MAX_FILE_BYTES) {
      throw new Error(`File too large. Maximum size: ${formatFileSize(TELEGRAM_MAX_FILE_BYTES)}`);
    }

    console.log(`📤 Uploading to Telegram: ${originalName} (${formatFileSize(fileSize)})`);

    // Upload to Telegram
    const message = await uploadLargeFile(filePath, originalName, CHANNEL_ID);
    
    if (!message?.document?.file_id) {
      throw new Error('Telegram upload failed - no file_id returned');
    }

    // Generate URLs
    const fileId = message.document.file_id;
    const downloadLink = makeDownloadUrl(req, fileId, originalName);
    const streamLink = makeStreamUrl(req, fileId, originalName);
    const playerLink = makePlayerUrl(req, fileId, originalName);

    // Determine file type
    const isVideo = isVideoFile(originalName);
    const isAudio = isAudioFile(originalName);

    const response = {
      success: true,
      file_name: originalName,
      file_size: fileSize,
      file_size_formatted: formatFileSize(fileSize),
      file_id: fileId,
      download_url: downloadLink,
      hotlink: downloadLink, // Legacy compatibility
      telegram_message_id: message.message_id,
      file_type: isVideo ? 'video' : isAudio ? 'audio' : 'document',
      upload_time: new Date().toISOString()
    };

    // Add streaming URLs for media files
    if (isVideo || isAudio) {
      response.stream_url = streamLink;
      response.player_url = playerLink;
      response.supports_streaming = true;
    }

    console.log(`✅ Upload successful: ${originalName}`);
    return res.json(response);

  } catch (err) {
    console.error('❌ Upload error:', err);
    
    // Enhanced error messages
    let errorMessage = err.message || 'Upload failed';
    let statusCode = 500;

    if (err.message?.includes('chat not found')) {
      errorMessage = 'Telegram channel not accessible. Please check bot permissions.';
      statusCode = 400;
    } else if (err.message?.includes('too large') || err.code === 'LIMIT_FILE_SIZE') {
      errorMessage = `File too large. Maximum size: ${formatFileSize(TELEGRAM_MAX_FILE_BYTES)}`;
      statusCode = 413;
    } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      errorMessage = 'Network error. Please check the file URL or try again later.';
      statusCode = 502;
    }

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  } finally {
    // Cleanup
    if (filePath) {
      await fs.unlink(filePath).catch(() => {});
    }
  }
});

// [Keep the rest of the code unchanged - download, stream, player, api/info, health endpoints]

// ------------------------
// Enhanced Download endpoint with range support
// ------------------------
app.get('/download/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const requestedName = req.query.filename || 'file';
    const fileName = safeFileName(decodeURIComponent(requestedName));

    console.log(`📥 Download request: ${fileName}`);

    // Get file info from Telegram
    const file = await bot.getFile(fileId);
    if (!file?.file_path) {
      throw new Error('File not found on Telegram servers');
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Set headers
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');

    // Handle range requests for better download experience
    const range = req.headers.range;
    if (range) {
      try {
        const response = await axios.get(fileUrl, {
          responseType: 'stream',
          headers: { Range: range },
          timeout: 0,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });
        
        res.status(206);
        res.setHeader('Content-Range', response.headers['content-range']);
        res.setHeader('Content-Length', response.headers['content-length']);
        
        await streamPipeline(response.data, res);
        return;
      } catch (rangeErr) {
        console.log('Range request failed, falling back to full download');
      }
    }

    // Full file download
    const response = await axios.get(fileUrl, {
      responseType: 'stream',
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    await streamPipeline(response.data, res);
    console.log(`✅ Download completed: ${fileName}`);

  } catch (err) {
    console.error('❌ Download error:', err);
    const message = err.message?.includes('not found') ? 'File not found' : 'Download failed';
    return res.status(404).json({ error: message });
  }
});

// ------------------------
// Stream endpoint for direct media streaming
// ------------------------
app.get('/stream/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const requestedName = req.query.filename || 'file';
    const fileName = safeFileName(decodeURIComponent(requestedName));

    console.log(`🎬 Stream request: ${fileName}`);

    const file = await bot.getFile(fileId);
    if (!file?.file_path) {
      throw new Error('File not found');
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Determine content type based on extension
    const ext = path.extname(fileName).toLowerCase();
    let contentType = 'application/octet-stream';
    
    if (VIDEO_EXTENSIONS.includes(ext)) {
      contentType = `video/${ext.substring(1)}`;
    } else if (AUDIO_EXTENSIONS.includes(ext)) {
      contentType = `audio/${ext.substring(1)}`;
    }

    // Set streaming headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    // Handle range requests (essential for video streaming)
    const range = req.headers.range;
    
    if (range) {
      const response = await axios.get(fileUrl, {
        responseType: 'stream',
        headers: { Range: range },
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      res.status(206);
      res.setHeader('Content-Range', response.headers['content-range']);
      res.setHeader('Content-Length', response.headers['content-length']);
      
      await streamPipeline(response.data, res);
    } else {
      const response = await axios.get(fileUrl, {
        responseType: 'stream',
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }

      await streamPipeline(response.data, res);
    }

    console.log(`✅ Stream completed: ${fileName}`);

  } catch (err) {
    console.error('❌ Stream error:', err);
    return res.status(404).json({ error: 'Stream not available' });
  }
});

// ------------------------
// Player page with Plyr
// ------------------------
app.get('/player/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const requestedName = req.query.filename || 'file';
    const fileName = safeFileName(decodeURIComponent(requestedName));
    
    // Check if file exists
    const file = await bot.getFile(fileId);
    if (!file?.file_path) {
      return res.status(404).send('File not found');
    }

    const streamUrl = makeStreamUrl(req, fileId, fileName);
    const isVideo = isVideoFile(fileName);
    const isAudio = isAudioFile(fileName);

    if (!isVideo && !isAudio) {
      return res.status(400).send('File type not supported for streaming');
    }

    const playerHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${fileName} - Media Player</title>
    <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            max-width: 90vw;
            max-height: 90vh;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
            border: 1px solid rgba(255, 255, 255, 0.18);
        }
        .player-wrapper {
            width: 100%;
            max-width: ${isVideo ? '1200px' : '600px'};
            margin: 0 auto;
        }
        .file-info {
            text-align: center;
            color: white;
            margin-bottom: 20px;
        }
        .file-info h1 {
            font-size: 1.5rem;
            margin-bottom: 10px;
            word-break: break-word;
        }
        .download-btn {
            display: inline-block;
            margin-top: 15px;
            padding: 12px 24px;
            background: rgba(255, 255, 255, 0.2);
            color: white;
            text-decoration: none;
            border-radius: 25px;
            transition: all 0.3s ease;
            border: 1px solid rgba(255, 255, 255, 0.3);
        }
        .download-btn:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }
        .plyr {
            border-radius: 15px;
            overflow: hidden;
        }
        ${isAudio ? `
        .plyr--audio {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 15px;
        }
        ` : ''}
        @media (max-width: 768px) {
            .container { padding: 15px; }
            .file-info h1 { font-size: 1.2rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="file-info">
            <h1>🎬 ${fileName}</h1>
            <p>High-quality streaming powered by Telegram</p>
            <a href="${makeDownloadUrl(req, fileId, fileName)}" class="download-btn">
                📥 Download File
            </a>
        </div>
        <div class="player-wrapper">
            ${isVideo ? 
                `<video id="player" playsinline controls data-poster="" crossorigin="anonymous">
                    <source src="${streamUrl}" type="video/mp4" />
                    Your browser doesn't support video playback.
                </video>` :
                `<audio id="player" controls crossorigin="anonymous">
                    <source src="${streamUrl}" type="audio/mpeg" />
                    Your browser doesn't support audio playback.
                </audio>`
            }
        </div>
    </div>

    <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const player = new Plyr('#player', {
                controls: [
                    'play-large', 'restart', 'rewind', 'play', 'fast-forward', 
                    'progress', 'current-time', 'duration', 'mute', 'volume', 
                    ${isVideo ? "'captions', 'settings', 'pip', 'airplay', 'fullscreen'" : "'settings'"}
                ],
                settings: ['captions', 'quality', 'speed'],
                quality: { default: 720, options: [4320, 2880, 2160, 1440, 1080, 720, 576, 480, 360, 240] },
                speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
                ratio: ${isVideo ? "'16:9'" : 'null'},
                loadSprite: false,
                iconUrl: 'https://cdn.plyr.io/3.7.8/plyr.svg'
            });

            player.on('ready', () => {
                console.log('Player ready');
            });

            player.on('error', (event) => {
                console.error('Player error:', event);
                alert('Error loading media. Please try downloading the file instead.');
            });
        });
    </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(playerHTML);

  } catch (err) {
    console.error('❌ Player error:', err);
    res.status(404).send('<h1>File not found</h1><p>The requested media file could not be found.</p>');
  }
});

// ------------------------
// API Info endpoint
// ------------------------
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Enhanced File Upload & Streaming API',
    version: '2.0.0',
    features: [
      'File uploads up to 6GB',
      'Support for all file types',
      'Video/Audio streaming with Plyr player',
      'Range request support',
      'Rate limiting & security',
      'Multiple upload methods (form, URL)',
      'Telegram bot integration'
    ],
    endpoints: {
      'POST /upload': 'Upload files via form data or URL',
      'GET /download/:file_id': 'Download files',
      'GET /stream/:file_id': 'Stream media files',
      'GET /player/:file_id': 'Media player page',
      'GET /api/info': 'API information'
    },
    limits: {
      max_file_size: TELEGRAM_MAX_FILE_BYTES,
      max_file_size_formatted: formatFileSize(TELEGRAM_MAX_FILE_BYTES),
      supported_video_formats: VIDEO_EXTENSIONS,
      supported_audio_formats: AUDIO_EXTENSIONS
    }
  });
});

// ------------------------
// Health check
// ------------------------
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ------------------------
// 404 handler
// ------------------------
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    available_endpoints: ['/upload', '/download/:file_id', '/stream/:file_id', '/player/:file_id', '/api/info']
  });
});

// ------------------------
// Global error handler
// ------------------------
app.use((err, req, res, next) => {
  console.error('❌ Global error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// ------------------------
// Graceful shutdown
// ------------------------
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully');
  process.exit(0);
});

console.log('🚀 Enhanced File Upload & Streaming API ready!');
console.log('📊 Features: 6GB uploads, streaming, security, rate limiting');

module.exports = app;

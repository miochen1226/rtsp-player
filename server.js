// server.js (優化後)

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// 設定 ffmpeg 和 ffprobe 的路徑
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ port: 9999 });
const port = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let ffmpegProcess = null;
const rtspUrl = 'rtsp://192.168.0.110:8554/ID001';

function startFFmpegStream() {
  if (ffmpegProcess) {
    console.log('FFmpeg 進程已在運行中。');
    return;
  }

  console.log('啟動 FFmpeg 持續轉碼進程...');

  try {
    const ffmpegCommand = ffmpeg(rtspUrl)
      .addInputOption('-rtsp_transport', 'tcp')
      .outputOptions([
        '-an',           // 禁用音頻
        '-c:v', 'mjpeg',    // 輸出 MJPEG 視頻格式
        '-q:v', '5',      // 視頻質量（數值越小質量越高）
        '-r', '15'        // 設定輸出幀率為 15 FPS
      ])
      .format('image2pipe');

    ffmpegProcess = ffmpegCommand.pipe();
    let frameBuffer = Buffer.alloc(0);
    const frameStartMarker = Buffer.from([0xff, 0xd8]); // MJPEG 幀的開頭
    const frameEndMarker = Buffer.from([0xff, 0xd9]);   // MJPEG 幀的結尾

    ffmpegProcess.on('data', (data) => {
      frameBuffer = Buffer.concat([frameBuffer, data]);

      let startIndex = 0;
      let endIndex = 0;
      
      while ((startIndex = frameBuffer.indexOf(frameStartMarker, endIndex)) !== -1 &&
             (endIndex = frameBuffer.indexOf(frameEndMarker, startIndex)) !== -1) {
        
        // 找到一個完整的幀
        const frame = frameBuffer.slice(startIndex, endIndex + frameEndMarker.length);
        
        // 發送幀數據到所有客戶端
        clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            try {
              client.send(frame);
            } catch (error) {
              console.error('發送數據到客戶端時出錯:', error.message);
            }
          }
        });

        // 移除已處理的幀數據
        frameBuffer = frameBuffer.slice(endIndex + frameEndMarker.length);
        endIndex = 0; // 重置 endIndex
      }
    });

    ffmpegProcess.on('error', (err) => {
      console.error('FFmpeg 串流錯誤:', err.message);
      cleanupAndRestart();
    });

    ffmpegProcess.on('close', () => {
      console.log('FFmpeg 串流結束');
      cleanupAndRestart();
    });

  } catch (err) {
    console.error('FFmpeg 啟動失敗:', err.message);
    cleanupAndRestart();
  }
}

function cleanupAndRestart() {
  if (ffmpegProcess) {
    ffmpegProcess.removeAllListeners();
    ffmpegProcess.kill('SIGKILL');
    ffmpegProcess = null;
  }
  if (clients.size > 0) {
    console.log('FFmpeg 意外結束，將在 5 秒後重啟...');
    setTimeout(startFFmpegStream, 5000);
  }
}

function stopFFmpegStream() {
  if (ffmpegProcess) {
    console.log('停止 FFmpeg 轉碼進程...');
    ffmpegProcess.kill('SIGKILL');
    ffmpegProcess = null;
  }
}

// WebSocket 連接處理
wss.on('connection', (ws) => {
  console.log('新的 WebSocket 連接建立, 當前客戶端數量:', clients.size + 1);
  clients.add(ws);

  if (clients.size === 1) {
    startFFmpegStream();
  }

  ws.on('close', () => {
    console.log('WebSocket 連接關閉, 剩餘客戶端數量:', clients.size - 1);
    clients.delete(ws);
    if (clients.size === 0) {
      stopFFmpegStream();
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket 錯誤:', err.message);
    clients.delete(ws);
  });
});

app.get('/stream-status', (req, res) => {
  res.json({
    status: ffmpegProcess ? 'active' : 'inactive',
    clients: clients.size,
    message: `流服務${ffmpegProcess ? '運行中' : '未運行'}，當前 ${clients.size} 個客戶端連接`
  });
});

app.post('/restart-stream', (req, res) => {
  stopFFmpegStream();
  setTimeout(() => {
    startFFmpegStream();
    res.json({ success: true, message: '流服務已重啟' });
  }, 1000);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(port, () => {
  console.log(`服務器運行在 http://localhost:${port}`);
  console.log('WebSocket 服務器運行在端口 9999');
});

process.on('SIGINT', () => {
  console.log('正在關閉服務器...');
  stopFFmpegStream();
  clients.forEach(client => client.close());
  server.close(() => {
    console.log('服務器已關閉');
    process.exit(0);
  });
});
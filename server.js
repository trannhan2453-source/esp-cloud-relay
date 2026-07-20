const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Upload tối đa 2MB
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });

// Lưu ESP
const espClients = new Map();

// ===== WEBSOCKET =====
wss.on('connection', (ws, req) => {
    console.log('[WS] ESP connected');

    ws.deviceId = "unknown";
    ws.firmware = null;
    ws.offset = 0;

    ws.on('message', (message) => {
        if (typeof message === 'string') {
            console.log('[WS TEXT]', message);

            if (message.startsWith("identity:")) {
                ws.deviceId = message.split(":")[1];
                espClients.set(ws, {
                    id: ws.deviceId,
                    ip: req.socket.remoteAddress,
                    lastHeartbeat: Date.now()
                });
                console.log(`[ESP] Registered: ${ws.deviceId}`);
            }

            else if (message === "pong") {
                if (espClients.has(ws)) {
                    espClients.get(ws).lastHeartbeat = Date.now();
                }
            }

            else if (message === "NEXT_CHUNK") {
                sendNextChunk(ws);
            }
        }
    });

    ws.on('close', () => {
        espClients.delete(ws);
        console.log('[WS] Disconnected');
    });
});

// ===== GỬI CHUNK =====
function sendNextChunk(ws) {
    if (!ws.firmware) return;

    const CHUNK_SIZE = 1024;

    if (ws.offset >= ws.firmware.length) {
        ws.send("UPDATE_COMPLETE");
        console.log('[SERVER] Update complete');
        ws.firmware = null;
        return;
    }

    let end = ws.offset + CHUNK_SIZE;
    let chunk = ws.firmware.slice(ws.offset, end);

    ws.send(chunk);
    ws.offset = end;

    console.log(`[SERVER] Sent ${ws.offset}/${ws.firmware.length}`);
}

// ===== API UPLOAD =====
app.post('/upload', upload.single('firmware'), (req, res) => {
    if (!req.file) return res.send("No file");

    const firmware = req.file.buffer;

    console.log('[UPLOAD] Firmware size:', firmware.length);

    const devices = Array.from(espClients.keys());

    devices.forEach(ws => {
        ws.firmware = firmware;
        ws.offset = 0;

        ws.send(`START_UPDATE:${firmware.length}`);
    });

    res.send("OK");
});

// ===== WEB =====
app.get('/', (req, res) => {
    res.send(`
    <h2>Upload Firmware</h2>
    <form method="POST" action="/upload" enctype="multipart/form-data">
        <input type="file" name="firmware"/>
        <button type="submit">Upload</button>
    </form>
    `);
});

server.listen(3000, () => {
    console.log("Server running on port 3000");
});

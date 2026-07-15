const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const upload = multer();

let espSocket = null; // Lưu kết nối của ESP-12E

// Giao diện web nạp code cố định
app.get('/', (req, res) => {
    // Kiểm tra kỹ xem socket còn thực sự hoạt động hay không
    const isOnline = espSocket && espSocket.readyState === WebSocket.OPEN;

    res.send(`
        <html>
        <head>
            <title>Cloud Arduino Programmer</title>
            <meta charset="utf-8">
        </head>
        <body>
            <h2>Wireless Programmer (Cloud to ESP-12E)</h2>
            <p>Trạng thái thiết bị: ${isOnline ? '<strong style="color:green">ONLINE</strong>' : '<strong style="color:red">OFFLINE</strong>'}</p>
            <form action="/upload" method="post" enctype="multipart/form-data">
                <input type="file" name="hexFile" accept=".hex">
                <button type="submit" ${!isOnline ? 'disabled' : ''}>Nạp Code</button>
            </form>
        </body>
        </html>
    `);
});

// Nhận file .hex từ trình duyệt và đẩy thẳng xuống ESP-12E
app.post('/upload', upload.single('hexFile'), (req, res) => {
    const isOnline = espSocket && espSocket.readyState === WebSocket.OPEN;
    if (!isOnline) {
        return res.status(400).send("ESP-12E đang ngoại tuyến!");
    }
    if (!req.file) {
        return res.status(400).send("Vui lòng chọn file .hex");
    }

    espSocket.send(req.file.buffer);
    res.send("Đang gửi file xuống ESP-12E để nạp vào ATmega2560... Vui lòng kiểm tra board mạch.");
});

// Lắng nghe kết nối Websocket từ ESP-12E
wss.on('connection', (ws) => {
    console.log('Có thiết bị kết nối vào Cloud!');
    
    // Đánh dấu thiết bị này còn sống
    ws.isAlive = true;
    espSocket = ws;

    // Khi ESP phản hồi tin nhắn Ping (nhận được Pong)
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('close', () => {
        console.log('ESP-12E đã chủ động ngắt kết nối!');
        if (espSocket === ws) espSocket = null;
    });

    ws.on('error', (err) => {
        console.error('Lỗi Socket:', err);
        if (espSocket === ws) espSocket = null;
    });
});

// CƠ CHẾ HEARTBEAT: Cứ 15 giây kiểm tra thiết bị 1 lần
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('ESP-12E mất tích không lý do, đang ngắt kết nối ảo...');
            if (espSocket === ws) espSocket = null;
            return ws.terminate(); // Ép buộc đóng kết nối chết này lại
        }

        // Đặt tạm thời về false và gửi yêu cầu Ping đi
        ws.isAlive = false;
        ws.ping(); // Gửi gói tin ping ngầm xuống ESP
    });
}, 15000); // 15 giây một lần

wss.on('close', () => {
    clearInterval(interval);
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Cloud Server đang chạy...');
});

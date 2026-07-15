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
    res.send(`
        <html>
        <head><title>Cloud Arduino Programmer</title></head>
        <body>
            <h2>Wireless Programmer (Cloud to ESP-12E)</h2>
            <p>Trạng thái thiết bị: ${espSocket ? '<strong style="color:green">ONLINE</strong>' : '<strong style="color:red">OFFLINE</strong>'}</p>
            <form action="/upload" method="post" enctype="multipart/form-data">
                <input type="file" name="hexFile" accept=".hex">
                <button type="submit" ${!espSocket ? 'disabled' : ''}>Nạp Code</button>
            </form>
        </body>
        </html>
    `);
});

// Nhận file .hex từ trình duyệt và đẩy thẳng xuống ESP-12E qua Websocket
app.post('/upload', upload.single('hexFile'), (req, res) => {
    if (!espSocket) {
        return res.status(400).send("ESP-12E đang ngoại tuyến!");
    }
    if (!req.file) {
        return res.status(400).send("Vui lòng chọn file .hex");
    }

    // Gửi file nhị phân qua Websocket xuống ESP-12E
    espSocket.send(req.file.buffer);
    res.send("Đang gửi file xuống ESP-12E để nạp vào ATmega2560... Vui lòng kiểm tra board mạch.");
});

// Lắng nghe kết nối Websocket từ ESP-12E
wss.on('connection', (ws) => {
    console.log('ESP-12E đã kết nối vào Cloud!');
    espSocket = ws;

    ws.on('close', () => {
        console.log('ESP-12E đã ngắt kết nối!');
        if (espSocket === ws) espSocket = null;
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Cloud Server đang chạy...');
});

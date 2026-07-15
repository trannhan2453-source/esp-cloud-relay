const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const upload = multer();

// HÀM KIỂM TRA TRẠNG THÁI THỰC TẾ:
// Quét trực tiếp trong bộ nhớ của WebSocket Server xem có client nào đang thực sự KẾT NỐI MỞ không
function getActiveESP() {
    let activeWs = null;
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            activeWs = client;
        }
    });
    return activeWs;
}

// Giao diện web nạp code cố định
app.get('/', (req, res) => {
    const espSocket = getActiveESP();
    const isOnline = espSocket !== null;

    res.send(`
        <html>
        <head>
            <title>Cloud Arduino Programmer</title>
            <meta charset="utf-8">
            <meta http-equiv="refresh" content="10"> <!-- Tự động làm mới trang mỗi 10 giây để bạn dễ theo dõi -->
        </head>
        <body>
            <h2>Wireless Programmer (Cloud to ESP-12E)</h2>
            <p>Trạng thái thiết bị: ${isOnline ? '<strong style="color:green">ONLINE</strong>' : '<strong style="color:red">OFFLINE</strong>'}</p>
            <form action="/upload" method="post" enctype="multipart/form-data">
                <input type="file" name="hexFile" accept=".hex">
                <button type="submit" ${!isOnline ? 'disabled' : ''}>Nạp Code</button>
            </form>
            <p style="font-size: 12px; color: gray;">Trang web tự động cập nhật sau mỗi 10 giây.</p>
        </body>
        </html>
    `);
});

// Nhận file .hex từ trình duyệt và đẩy thẳng xuống ESP-12E
app.post('/upload', upload.single('hexFile'), (req, res) => {
    const espSocket = getActiveESP();
    if (!espSocket) {
        return res.status(400).send("ESP-12E đang ngoại tuyến! Không thể nạp.");
    }
    if (!req.file) {
        return res.status(400).send("Vui lòng chọn file .hex");
    }

    espSocket.send(req.file.buffer);
    res.send("Đang gửi file xuống ESP-12E để nạp vào ATmega2560... Vui lòng kiểm tra board mạch.");
});

// Lắng nghe kết nối Websocket từ ESP-12E
wss.on('connection', (ws) => {
    console.log('Mạch ESP-12E vừa kết nối vào Server!');
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('close', () => {
        console.log('ESP-12E báo ngắt kết nối chủ động.');
    });

    ws.on('error', (err) => {
        console.error('Lỗi kết nối socket:', err.message);
    });
});

// CƠ CHẾ DỌN DẸP KẾT NỐI RÁC (Định kỳ 10 giây)
// Bắt buộc quét và triệt tiêu các kết nối "ma" do Render Proxy giữ lại
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('Phát hiện kết nối ma, đang ép hủy...');
            return ws.terminate(); // Hủy kết nối ngay lập tức
        }
        ws.isAlive = false;
        ws.ping(); 
    });
}, 10000); // Rút ngắn xuống 10 giây một lần kiểm tra

wss.on('close', () => {
    clearInterval(interval);
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Cloud Server đang chạy...');
});

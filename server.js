const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });

let espConnection = null;
let lastHeartbeat = 0; // Lưu thời gian (ms) cuối cùng nhận được phản hồi từ ESP

function getActiveESP() {
    const now = Date.now();
    // ESP được coi là ONLINE nếu socket OPEN và phản hồi "pong" thực tế cách đây không quá 7 giây
    if (espConnection && espConnection.readyState === WebSocket.OPEN && (now - lastHeartbeat) < 7000) {
        return espConnection;
    }
    return null;
}

// API endpoint để giao diện Web check trạng thái (2 giây một lần)
app.get('/api/status', (req, res) => {
    const esp = getActiveESP();
    res.json({ online: esp !== null });
});

// Giao diện điều khiển Web
app.get('/', (req, res) => {
    const esp = getActiveESP();
    const isOnline = esp !== null;

    res.send(`
        <html>
        <head>
            <title>Cloud Arduino Programmer</title>
            <meta charset="utf-8">
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; background-color: #f4f4f9; color: #333; }
                .container { max-width: 500px; margin: auto; padding: 20px; background: white; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
                .status-box { padding: 15px; border-radius: 5px; text-align: center; font-size: 18px; margin-bottom: 20px; font-weight: bold; }
                .online { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
                .offline { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
                .btn { width: 100%; padding: 12px; font-size: 16px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; }
                .btn-primary { background-color: #007bff; color: white; }
                .btn-primary:disabled { background-color: #c8c8c8; cursor: not-allowed; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>Cloud to ESP-12E Programmer</h2>
                <div id="statusBox" class="status-box ${isOnline ? 'online' : 'offline'}">
                    ĐANG KIỂM TRA TRẠNG THÁI...
                </div>
                <form action="/upload" method="post" enctype="multipart/form-data">
                    <p>Chọn file chương trình:</p>
                    <input type="file" name="hexFile" accept=".hex" required style="margin-bottom: 20px; width: 100%;">
                    <button type="submit" id="submitBtn" class="btn btn-primary" ${!isOnline ? 'disabled' : ''}>Nạp Code</button>
                </form>
            </div>
            <script>
                const statusBox = document.getElementById('statusBox');
                const submitBtn = document.getElementById('submitBtn');

                function checkStatus() {
                    fetch('/api/status')
                        .then(res => res.json())
                        .then(data => {
                            if (data.online) {
                                statusBox.innerText = "ONLINE (Sẵn sàng nạp)";
                                statusBox.className = "status-box online";
                                submitBtn.disabled = false;
                            } else {
                                statusBox.innerText = "OFFLINE (Không tìm thấy mạch)";
                                statusBox.className = "status-box offline";
                                submitBtn.disabled = true;
                            }
                        })
                        .catch(err => console.error("Lỗi cập nhật trạng thái:", err));
                }
                setInterval(checkStatus, 2000);
                checkStatus();
            </script>
        </body>
        </html>
    `);
});

// Nhận file .hex và gửi đi
app.post('/upload', upload.single('hexFile'), (req, res) => {
    const espSocket = getActiveESP();
    if (!espSocket) {
        return res.status(400).send("<h3>Mạch đã ngoại tuyến! Không thể nạp.</h3><a href='/'>Quay lại</a>");
    }
    if (!req.file) {
        return res.status(400).send("<h3>Vui lòng chọn file .hex</h3><a href='/'>Quay lại</a>");
    }

    espSocket.send(req.file.buffer, { binary: true }, (err) => {
        if (err) {
            return res.status(500).send("Lỗi đường truyền dữ liệu.");
        }
        res.send("<h3>Đang nạp code...</h3><p>Dữ liệu đã truyền xuống ESP-12E.</p><br><a href='/'>Quay lại</a>");
    });
});

// Quản lý kết nối WebSocket
wss.on('connection', (ws) => {
    console.log('Phát hiện kết nối mới từ ESP-12E!');
    
    if (espConnection) {
        espConnection.terminate();
    }

    espConnection = ws;
    lastHeartbeat = Date.now(); // Reset bộ đếm thời gian khi có kết nối mới

    // Lắng nghe tin nhắn TEXT thông thường từ ESP
    ws.on('message', (message) => {
        const msgStr = message.toString();
        
        if (msgStr === "pong") {
            lastHeartbeat = Date.now(); // Ghi nhận ESP vừa trả lời "pong" thật
        }
    });

    ws.on('close', () => {
        console.log('ESP-12E báo đóng kết nối.');
        if (espConnection === ws) espConnection = null;
    });

    ws.on('error', (err) => {
        console.error('Lỗi socket:', err.message);
        if (espConnection === ws) espConnection = null;
    });
});

// CHU KỲ KIỂM TRA THỰC TẾ (Cứ mỗi 4 giây gửi chữ "ping" dạng text xuống ESP)
const interval = setInterval(() => {
    if (espConnection && espConnection.readyState === WebSocket.OPEN) {
        const now = Date.now();
        
        // Nếu đã quá 7 giây rồi mà ESP không gửi "pong" về -> Xóa kết nối ma
        if (now - lastHeartbeat > 7000) {
            console.log('Quá thời gian phản hồi thực tế! Ép hủy kết nối ma...');
            espConnection.terminate();
            espConnection = null;
        } else {
            // Gửi bản tin ping ứng dụng
            espConnection.send("ping");
        }
    }
}, 4000);

wss.on('close', () => {
    clearInterval(interval);
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Server đang hoạt động...');
});

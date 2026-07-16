const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });

// BIẾN LƯU TRỮ THÔNG TIN KẾT NỐI ESP THỰC TẾ
let espConnection = null;

function getActiveESP() {
    // Chỉ trả về kết nối nếu socket thực sự mở VÀ đã vượt qua bài test ping/pong gần nhất
    if (espConnection && espConnection.readyState === WebSocket.OPEN && espConnection.isAlive) {
        return espConnection;
    }
    return null;
}

// API endpoint để giao diện Web tự động check trạng thái (gọi mỗi 2 giây)
app.get('/api/status', (req, res) => {
    const esp = getActiveESP();
    res.json({ online: esp !== null });
});

// Giao diện Web động (Không bị giật màn hình khi tải lại)
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
                // Tự động kiểm tra trạng thái thực tế của ESP qua API mỗi 2 giây
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

                setInterval(checkStatus, 2000); // Check liên tục mỗi 2 giây
                checkStatus(); // Chạy ngay lần đầu tải trang
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
    
    // Đóng kết nối cũ nếu có thiết bị mới trùng lặp kết nối đè lên
    if (espConnection) {
        espConnection.terminate();
    }

    espConnection = ws;
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true; // Xác nhận mạch thực sự còn sống khi phản hồi ping
    });

    ws.on('close', () => {
        console.log('ESP-12E đóng kết nối chủ động.');
        if (espConnection === ws) espConnection = null;
    });

    ws.on('error', (err) => {
        console.error('Lỗi kết nối socket:', err.message);
        if (espConnection === ws) espConnection = null;
    });
});

// HỆ THỐNG TIMEOUT CHẶT CHẼ (Ping mỗi 5 giây để phát hiện đứt mạng cực nhanh)
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('Phát hiện ESP mất liên lạc đột ngột (kết nối ma). Đang giải phóng...');
            if (espConnection === ws) espConnection = null;
            return ws.terminate(); 
        }
        
        ws.isAlive = false; // Đặt tạm thời về false, nếu ESP phản hồi pong nó sẽ chuyển lại thành true
        ws.ping(); 
    });
}, 5000); // 5 giây quét một lần giúp phát hiện ngắt mạng chỉ trong vài giây

wss.on('close', () => {
    clearInterval(interval);
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Cloud Server hoạt động...');
});

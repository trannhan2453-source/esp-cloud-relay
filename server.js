const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });

// QUẢN LÝ DANH SÁCH MẠCH BẰNG MAP
// Key: socket (đối tượng ws), Value: { id, ip, lastHeartbeat }
const espClients = new Map();

// Lấy danh sách các ESP thực sự đang hoạt động
function getActiveESPs() {
    const now = Date.now();
    const activeList = [];
    
    for (const [ws, info] of espClients.entries()) {
        if (ws.readyState === WebSocket.OPEN && (now - info.lastHeartbeat) < 7000) {
            activeList.push({ ws, ...info });
        }
    }
    return activeList;
}

// API lấy danh sách mạch đang online (cho giao diện AJAX gọi 2s một lần)
app.get('/api/devices', (req, res) => {
    const activeESPs = getActiveESPs().map(device => ({
        id: device.id,
        ip: device.ip
    }));
    res.json({ devices: activeESPs });
});

// Giao diện web đa thiết bị
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Multi-Device Wireless Programmer</title>
            <meta charset="utf-8">
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; background-color: #f4f4f9; color: #333; }
                .container { max-width: 650px; margin: auto; padding: 25px; background: white; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
                .device-list { border: 1px solid #ccc; border-radius: 5px; padding: 10px; background: #fafafa; margin-bottom: 20px; max-height: 200px; overflow-y: auto; }
                .device-item { display: flex; align-items: center; padding: 8px; border-bottom: 1px solid #eee; }
                .device-item:last-child { border-bottom: none; }
                .device-item input { margin-right: 12px; transform: scale(1.2); }
                .btn { width: 100%; padding: 12px; font-size: 16px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; margin-bottom: 10px; }
                .btn-primary { background-color: #007bff; color: white; }
                .btn-primary:disabled { background-color: #c8c8c8; cursor: not-allowed; }
                .btn-secondary { background-color: #28a745; color: white; }
                .btn-secondary:disabled { background-color: #c8c8c8; cursor: not-allowed; }
                .header-flex { display: flex; justify-content: space-between; align-items: center; }
                .badge { background: #17a2b8; color: white; padding: 3px 8px; border-radius: 12px; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header-flex">
                    <h2>Multi-Device Programmer</h2>
                    <span class="badge" id="deviceCount">0 thiết bị online</span>
                </div>
                
                <form action="/upload" method="post" enctype="multipart/form-data">
                    <p style="font-weight: bold;">1. Chọn danh sách mạch cần nạp:</p>
                    <div class="device-list" id="deviceList">
                        <div style="color: gray; text-align: center; padding: 15px;">Đang dò tìm thiết bị...</div>
                    </div>

                    <p style="font-weight: bold;">2. Chọn file chương trình (.hex):</p>
                    <input type="file" name="hexFile" accept=".hex" required style="margin-bottom: 20px; width: 100%;">
                    
                    <input type="hidden" name="targetDevices" id="targetDevicesInput">
                    
                    <button type="submit" id="btnNapChon" class="btn btn-primary" disabled onclick="prepareSubmit('selected')">Nạp các mạch đã chọn</button>
                    <button type="submit" id="btnNapAll" class="btn btn-secondary" disabled onclick="prepareSubmit('all')">Nạp ĐỒNG LOẠT tất cả</button>
                </form>
            </div>

            <script>
                const deviceListDiv = document.getElementById('deviceList');
                const deviceCountBadge = document.getElementById('deviceCount');
                const btnNapChon = document.getElementById('btnNapChon');
                const btnNapAll = document.getElementById('btnNapAll');
                const targetDevicesInput = document.getElementById('targetDevicesInput');

                let currentDevices = [];

                function updateDeviceList() {
                    fetch('/api/devices')
                        .then(res => res.json())
                        .then(data => {
                            currentDevices = data.devices;
                            deviceCountBadge.innerText = currentDevices.length + " thiết bị online";
                            
                            if (currentDevices.length === 0) {
                                deviceListDiv.innerHTML = '<div style="color: red; text-align: center; padding: 15px; font-weight: bold;">Không tìm thấy mạch nào trực tuyến!</div>';
                                btnNapChon.disabled = true;
                                btnNapAll.disabled = true;
                                return;
                            }

                            // Lưu lại danh sách các checkbox đã được tích trước đó để tránh bị reset khi reload danh sách
                            const checkedIds = Array.from(document.querySelectorAll('.device-checkbox:checked')).map(cb => cb.value);

                            let html = '';
                            currentDevices.forEach((device) => {
                                const isChecked = checkedIds.includes(device.id) ? 'checked' : '';
                                html += \`
                                    <div class="device-item">
                                        <input type="checkbox" class="device-checkbox" value="\${device.id}" \${isChecked} onchange="validateSelection()">
                                        <label>Mạch [ID: \${device.id.substring(0, 20)}...] - IP: \${device.ip}</label>
                                    </div>
                                \`;
                            });
                            deviceListDiv.innerHTML = html;
                            btnNapAll.disabled = false;
                            validateSelection();
                        })
                        .catch(err => console.error("Lỗi cập nhật thiết bị:", err));
                }

                function validateSelection() {
                    const checkedCount = document.querySelectorAll('.device-checkbox:checked').length;
                    btnNapChon.disabled = (checkedCount === 0);
                }

                // Gộp danh sách ID thiết bị cần nạp vào input ẩn trước khi gửi form lên server
                function prepareSubmit(mode) {
                    if (mode === 'all') {
                        // Tích chọn hết tất cả các checkbox trước khi gửi
                        document.querySelectorAll('.device-checkbox').forEach(cb => cb.checked = true);
                    }
                    const checkedIds = Array.from(document.querySelectorAll('.device-checkbox:checked')).map(cb => cb.value);
                    targetDevicesInput.value = JSON.stringify(checkedIds);
                }

                setInterval(updateDeviceList, 2000); // Tự cập nhật sau 2 giây
                updateDeviceList();
            </script>
        </body>
        </html>
    `);
});

// Xử lý nạp code (hỗ trợ cả chọn lọc và đồng loạt)
app.post('/upload', upload.single('hexFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).send("<h3>Lỗi: Vui lòng chọn file .hex</h3><a href='/'>Quay lại</a>");
    }

    let targetIds = [];
    try {
        targetIds = JSON.parse(req.body.targetDevices || "[]");
    } catch (e) {
        return res.status(400).send("Dữ liệu thiết bị đích không hợp lệ.");
    }

    if (targetIds.length === 0) {
        return res.status(400).send("<h3>Lỗi: Hãy chọn ít nhất một thiết bị cần nạp!</h3><a href='/'>Quay lại</a>");
    }

    const activeList = getActiveESPs();
    let sentCount = 0;

    // Duyệt qua danh sách mạch đang online và gửi file song song
    activeList.forEach(device => {
        if (targetIds.includes(device.id)) {
            device.ws.send(req.file.buffer, { binary: true }, (err) => {
                if (err) {
                    console.error(`Lỗi truyền tới ESP ${device.id}:`, err.message);
                }
            } );
            sentCount++;
        }
    });

    res.send(`
        <h3>Đang nạp code...</h3>
        <p>Đã đẩy file xuống <b>${sentCount}/${targetIds.length}</b> mạch được yêu cầu.</p>
        <p>Hãy kiểm tra tiến trình nạp trực tiếp trên các board mạch ATmega2560.</p>
        <br><a href='/'>Quay lại</a>
    `);
});

// Quản lý kết nối WebSocket
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    
    // THAY ĐỔI: Không dùng ID ngẫu nhiên nữa, dùng ID tạm thời chờ mạch gửi định danh lên
    console.log(`Có mạch kết nối mới từ IP: ${clientIp}. Đang chờ định danh...`);

    // Lưu vào Map quản lý kết nối với ID tạm
    espClients.set(ws, {
        id: "Chờ kết nối...", 
        ip: clientIp,
        lastHeartbeat: Date.now()
    });

    ws.on('message', (message) => {
        const msgStr = message.toString();
        
        // 1. Nếu ESP gửi tin nhắn định danh kèm MAC Address
        if (msgStr.startsWith("identity:")) {
            const macId = msgStr.split(":")[1];
            const info = espClients.get(ws);
            if (info) {
                info.id = "ESP_" + macId; // Ghi đè bằng ID MAC cố định vĩnh viễn
                console.log(`[Server] Đã nhận diện thành công mạch: ${info.id} (IP: ${info.ip})`);
            }
        }
        
        // 2. Kiểm tra nhịp tim
        if (msgStr === "pong") {
            const info = espClients.get(ws);
            if (info) {
                info.lastHeartbeat = Date.now(); 
            }
        }
    });

    // TỐI ƯU LOG: Lấy ID thực tế từ Map để khi ngắt kết nối hiển thị đúng tên ESP_MAC
    ws.on('close', () => {
        const info = espClients.get(ws);
        const displayId = info ? info.id : "Không xác định";
        console.log(`Mạch [ID: ${displayId}] đã ngắt kết nối.`);
        espClients.delete(ws);
    });

    ws.on('error', (err) => {
        const info = espClients.get(ws);
        const displayId = info ? info.id : "Không xác định";
        console.error(`Lỗi socket tại mạch [ID: ${displayId}]:`, err.message);
        espClients.delete(ws);
    });
});

// CHU KỲ KIỂM TRA THỰC TẾ RIÊNG BIỆT (Gửi ping tới từng mạch mỗi 4 giây)
const interval = setInterval(() => {
    const now = Date.now();
    
    for (const [ws, info] of espClients.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
            // Quá 7 giây không nhận được pong thực tế từ mạch này
            if (now - info.lastHeartbeat > 7000) {
                console.log(`Mạch [ID: ${info.id}] mất liên lạc. Tiến hành hủy kết nối ma...`);
                ws.terminate();
                espClients.delete(ws);
            } else {
                ws.send("ping");
            }
        } else {
            espClients.delete(ws);
        }
    }
}, 4000);

wss.on('close', () => {
    clearInterval(interval);
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Server đang hoạt động ở chế độ Multi-Device...');
});

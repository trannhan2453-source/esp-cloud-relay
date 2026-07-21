const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Cấu hình multer chỉ nhận file tối đa 2MB
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });

// QUẢN LÝ DANH SÁCH MẠCH BẰNG MAP
// Key: socket (đối tượng ws), Value: { id, ip, type, lastHeartbeat, firmwareBuffer, currentOffset, chunkSize }
// type: 'ESP' hoặc 'WEB'
const clients = new Map();

// Lấy danh sách các ESP thực sự đang hoạt động
function getActiveESPs() {
    const now = Date.now();
    const activeList = [];
    
    for (const [ws, info] of clients.entries()) {
        if (info.type !== 'ESP') continue;

        const isUpdating = !!info.firmwareBuffer;
        const isAlive = isUpdating || (now - info.lastHeartbeat) < 7000;

        if (ws.readyState === WebSocket.OPEN && isAlive) {
            activeList.push({ ws, ...info });
        }
    }
    return activeList;
}

// Hàm gửi tin nhắn tiến độ tới tất cả Client Web đang xem giao diện
function broadcastToWebClients(data) {
    const jsonStr = JSON.stringify(data);
    for (const [ws, info] of clients.entries()) {
        if (info.type === 'WEB' && ws.readyState === WebSocket.OPEN) {
            ws.send(jsonStr);
        }
    }
}

// API lấy danh sách mạch đang online
app.get('/api/devices', (req, res) => {
    const activeESPs = getActiveESPs().map(device => ({
        id: device.id,
        ip: device.ip
    }));
    res.json({ devices: activeESPs });
});

// Giao diện web đa thiết bị có Progress Bar
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Multi-Device Wireless Programmer</title>
            <meta charset="utf-8">
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; background-color: #f4f4f9; color: #333; }
                .container { max-width: 700px; margin: auto; padding: 25px; background: white; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
                .device-list { border: 1px solid #ccc; border-radius: 5px; padding: 10px; background: #fafafa; margin-bottom: 20px; max-height: 300px; overflow-y: auto; }
                .device-item { padding: 10px; border-bottom: 1px solid #eee; display: flex; flex-direction: column; gap: 6px; }
                .device-item:last-child { border-bottom: none; }
                .device-row { display: flex; align-items: center; }
                .device-row input { margin-right: 12px; transform: scale(1.2); }
                .btn { width: 100%; padding: 12px; font-size: 16px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; margin-bottom: 10px; }
                .btn-primary { background-color: #007bff; color: white; }
                .btn-primary:disabled { background-color: #c8c8c8; cursor: not-allowed; }
                .btn-secondary { background-color: #28a745; color: white; }
                .btn-secondary:disabled { background-color: #c8c8c8; cursor: not-allowed; }
                .header-flex { display: flex; justify-content: space-between; align-items: center; }
                .badge { background: #17a2b8; color: white; padding: 3px 8px; border-radius: 12px; font-size: 12px; }
                
                /* Style cho Progress Bar */
                .progress-wrapper { width: 100%; background-color: #e0e0e0; border-radius: 10px; overflow: hidden; height: 18px; margin-top: 4px; display: none; }
                .progress-bar { width: 0%; height: 100%; background-color: #28a745; transition: width 0.2s ease; text-align: center; color: white; font-size: 11px; line-height: 18px; font-weight: bold; }
                .status-text { font-size: 12px; color: #666; margin-left: auto; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header-flex">
                    <h2>Nạp OTA AT2560 MLN RB</h2>
                    <span class="badge" id="deviceCount">0 thiết bị online</span>
                </div>
                
                <form id="uploadForm">
                    <p style="font-weight: bold;">1. Chọn danh sách mạch cần nạp:</p>
                    <div class="device-list" id="deviceList">
                        <div style="color: gray; text-align: center; padding: 15px;">Đang dò tìm thiết bị...</div>
                    </div>

                    <p style="font-weight: bold;">2. Chọn file chương trình (.bin):</p>
                    <input type="file" id="binFileInput" name="binFile" accept=".bin" required style="margin-bottom: 20px; width: 100%;">
                    
                    <button type="button" id="btnNapChon" class="btn btn-primary" disabled onclick="submitOTA('selected')">Nạp các mạch đã chọn</button>
                    <button type="button" id="btnNapAll" class="btn btn-secondary" disabled onclick="submitOTA('all')">Nạp ĐỒNG LOẠT tất cả</button>
                </form>
            </div>

            <script>
                const deviceListDiv = document.getElementById('deviceList');
                const deviceCountBadge = document.getElementById('deviceCount');
                const btnNapChon = document.getElementById('btnNapChon');
                const btnNapAll = document.getElementById('btnNapAll');
                
                let currentDevices = [];
                let isUploading = false;

                // Kết nối WebSocket dành riêng cho giao diện Web nhận Tiến trình (Realtime Progress)
                const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const ws = new WebSocket(\`\${protocol}//\${location.host}\`);

                ws.onopen = () => {
                    ws.send('identity:WEB_CLIENT');
                };

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === 'PROGRESS_UPDATE') {
                            updateDeviceProgress(data.id, data.percent, data.status);
                        }
                    } catch(e) {}
                };

                function updateDeviceList() {
                    // Nếu đang nạp dở thì không làm mới lại DOM để tránh làm đứt đoạn hiển thị
                    if (isUploading) return;

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

                            const checkedIds = Array.from(document.querySelectorAll('.device-checkbox:checked')).map(cb => cb.value);

                            let html = '';
                            currentDevices.forEach((device) => {
                                const isChecked = checkedIds.includes(device.id) ? 'checked' : '';
                                html += \`
                                    <div class="device-item" id="item-\${device.id}">
                                        <div class="device-row">
                                            <input type="checkbox" class="device-checkbox" value="\${device.id}" \${isChecked} onchange="validateSelection()">
                                            <label style="font-family: monospace; font-size: 14px;">Mạch [\${device.id}] - IP: \${device.ip}</label>
                                            <span class="status-text" id="status-\${device.id}">Sẵn sàng</span>
                                        </div>
                                        <div class="progress-wrapper" id="wrapper-\${device.id}">
                                            <div class="progress-bar" id="bar-\${device.id}">0%</div>
                                        </div>
                                    </div>\`;
                            });
                            deviceListDiv.innerHTML = html;
                            btnNapAll.disabled = false;
                            validateSelection();
                        })
                        .catch(err => console.error("Lỗi cập nhật thiết bị:", err));
                }

                function validateSelection() {
                    const checkedCount = document.querySelectorAll('.device-checkbox:checked').length;
                    btnNapChon.disabled = (checkedCount === 0) || isUploading;
                }

                function updateDeviceProgress(deviceId, percent, status) {
                    const wrapper = document.getElementById(\`wrapper-\${deviceId}\`);
                    const bar = document.getElementById(\`bar-\${deviceId}\`);
                    const statusTxt = document.getElementById(\`status-\${deviceId}\`);

                    if (wrapper && bar && statusTxt) {
                        wrapper.style.display = 'block';
                        bar.style.width = percent + '%';
                        bar.innerText = percent + '%';
                        statusTxt.innerText = status;

                        if (percent === 100) {
                            bar.style.backgroundColor = '#28a745';
                        }
                    }
                }

                function submitOTA(mode) {
                    const fileInput = document.getElementById('binFileInput');
                    if (!fileInput.files[0]) {
                        alert('Vui lòng chọn file .bin trước!');
                        return;
                    }

                    if (mode === 'all') {
                        document.querySelectorAll('.device-checkbox').forEach(cb => cb.checked = true);
                    }

                    const checkedIds = Array.from(document.querySelectorAll('.device-checkbox:checked')).map(cb => cb.value);
                    if (checkedIds.length === 0) {
                        alert('Hãy chọn ít nhất 1 thiết bị!');
                        return;
                    }

                    const formData = new FormData();
                    formData.append('binFile', fileInput.files[0]);
                    formData.append('targetDevices', JSON.stringify(checkedIds));

                    // Khóa giao diện lại tránh bấm trùng
                    isUploading = true;
                    btnNapChon.disabled = true;
                    btnNapAll.disabled = true;

                    // Hiện Progress bar cho các thiết bị được chọn
                    checkedIds.forEach(id => {
                        updateDeviceProgress(id, 0, 'Đang chuẩn bị...');
                    });

                    fetch('/upload', {
                        method: 'POST',
                        body: formData
                    })
                    .then(res => res.text())
                    .then(msg => {
                        console.log('Khởi chạy nạp thành công');
                    })
                    .catch(err => {
                        alert('Lỗi khởi động tiến trình nạp!');
                        isUploading = false;
                        validateSelection();
                    });
                }

                setInterval(updateDeviceList, 2000);
                updateDeviceList();
            </script>
        </body>
        </html>
    `);
});

// Xử lý tải file BIN và phân phối lệnh bắt đầu
app.post('/upload', upload.single('binFile'), (req, res) => {
    if (!req.file) return res.status(400).send("Chưa chọn file");

    let targetIds = [];
    try {
        targetIds = JSON.parse(req.body.targetDevices || "[]");
    } catch (e) {
        return res.status(400).send("Dữ liệu không hợp lệ");
    }

    const CHUNK_SIZE = 1024; 
    let sentCount = 0;

    for (const [ws, info] of clients.entries()) {
        if (info.type === 'ESP' && targetIds.includes(info.id) && ws.readyState === WebSocket.OPEN) {
            info.firmwareBuffer = req.file.buffer;
            info.currentOffset = 0;
            info.chunkSize = CHUNK_SIZE;
            info.lastHeartbeat = Date.now(); 

            console.log(`[Server] Kích hoạt nạp cho ${info.id}. Kích thước: ${req.file.buffer.length} bytes`);
            
            ws.send(`START_UPDATE:${req.file.buffer.length}`);
            sentCount++;

            // Báo cho Web UI biết là bắt đầu nạp
            broadcastToWebClients({
                type: 'PROGRESS_UPDATE',
                id: info.id,
                percent: 0,
                status: 'Đang nạp...'
            });
        }
    }

    res.json({ success: true, count: sentCount });
});

// Quản lý kết nối WebSocket
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;

    clients.set(ws, {
        id: "Chưa xác định", 
        ip: clientIp,
        type: 'UNKNOWN', // 'ESP' hoặc 'WEB'
        lastHeartbeat: Date.now()
    });

    ws.on('message', (message) => {
        const msgStr = message.toString();
        const info = clients.get(ws);
        if (!info) return;
        
        // 1. Phân loại thiết bị kết nối
        if (msgStr.startsWith("identity:")) {
            const identityStr = msgStr.split(":")[1];
            if (identityStr === "WEB_CLIENT") {
                info.type = 'WEB';
                info.id = "WEB_CLIENT";
            } else {
                info.type = 'ESP';
                info.id = "ESP_" + identityStr;
                console.log(`[Server] Đã nhận diện ESP: ${info.id} (IP: ${info.ip})`);
            }
            return;
        }
        
        // 2. Nhận heartbeat
        if (msgStr === "pong") {
            info.lastHeartbeat = Date.now(); 
            return;
        }

        // 3. ESP yêu cầu gửi gói dữ liệu tiếp theo (NEXT_CHUNK)
        if (msgStr === "NEXT_CHUNK" && info.type === 'ESP') {
            if (info.firmwareBuffer) {
                const buffer = info.firmwareBuffer;
                const offset = info.currentOffset;
                const size = info.chunkSize;

                info.lastHeartbeat = Date.now();

                if (offset < buffer.length) {
                    const end = Math.min(offset + size, buffer.length);
                    const chunk = buffer.subarray(offset, end);
                    info.currentOffset = end;

                    // Gửi dữ liệu binary cho ESP
                    ws.send(chunk, { binary: true });

                    // Tính % tiến độ và phát realtime cho Web Client
                    const percent = Math.floor((end / buffer.length) * 100);
                    broadcastToWebClients({
                        type: 'PROGRESS_UPDATE',
                        id: info.id,
                        percent: percent,
                        status: percent === 100 ? 'Hoàn tất!' : 'Đang nạp...'
                    });
                } else {
                    console.log(`[Server] Truyền hoàn tất file .bin tới ${info.id}!`);
                    ws.send("UPDATE_COMPLETE");
                    
                    broadcastToWebClients({
                        type: 'PROGRESS_UPDATE',
                        id: info.id,
                        percent: 100,
                        status: 'Thành công!'
                    });

                    // Giải phóng bộ nhớ
                    info.firmwareBuffer = null;
                    info.currentOffset = 0;
                }
            }
        }
    });

    ws.on('close', () => {
        const info = clients.get(ws);
        if (info && info.type === 'ESP') {
            console.log(`Mạch [ID: ${info.id}] đã ngắt kết nối.`);
        }
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        clients.delete(ws);
    });
});

// Chu kỳ Ping tự động
const interval = setInterval(() => {
    const now = Date.now();
    
    for (const [ws, info] of clients.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
            if (info.type === 'WEB') continue; // Bỏ qua web client

            if (info.firmwareBuffer) continue; // Miễn timeout khi đang nạp

            if (now - info.lastHeartbeat > 7000) {
                ws.terminate();
                clients.delete(ws);
            } else {
                ws.send("ping");
            }
        } else {
            clients.delete(ws);
        }
    }
}, 4000);

wss.on('close', () => clearInterval(interval));

server.listen(process.env.PORT || 3000, () => {
    console.log('Server đang hoạt động ở chế độ Multi-Device có Tiến Trình Nạp...');
});

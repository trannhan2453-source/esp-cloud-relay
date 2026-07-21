const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });

// Map lưu client ESP
// Value: { id, ip, lastHeartbeat, firmwareBuffer, currentOffset, chunkSize, status, flashProgress, avrProgress }
const espClients = new Map();

function getActiveESPs() {
    const now = Date.now();
    const activeList = [];
    
    for (const [ws, info] of espClients.entries()) {
        const isUpdating = !!info.firmwareBuffer || info.status?.includes('Đang');
        const isAlive = isUpdating || (now - info.lastHeartbeat) < 7000;

        if (ws.readyState === WebSocket.OPEN && isAlive) {
            activeList.push({ ws, ...info });
        }
    }
    return activeList;
}

// API lấy danh sách mạch kèm Tiến trình nạp
app.get('/api/devices', (req, res) => {
    const activeESPs = getActiveESPs().map(device => ({
        id: device.id,
        ip: device.ip,
        status: device.status || "Sẵn sàng",
        flashProgress: device.flashProgress || 0,
        avrProgress: device.avrProgress || 0
    }));
    res.json({ devices: activeESPs });
});

// Giao diện web đã tích hợp AJAX và Progress Bar 2 giai đoạn
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Multi-Device Wireless Programmer</title>
            <meta charset="utf-8">
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; background-color: #f4f4f9; color: #333; }
                .container { max-width: 800px; margin: auto; padding: 25px; background: white; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
                .device-list { border: 1px solid #ccc; border-radius: 5px; padding: 10px; background: #fafafa; margin-bottom: 20px; max-height: 350px; overflow-y: auto; }
                .device-item { display: flex; flex-direction: column; padding: 10px; border-bottom: 1px solid #eee; }
                .device-item:last-child { border-bottom: none; }
                .device-row { display: flex; align-items: center; justify-content: space-between; }
                .btn { width: 100%; padding: 12px; font-size: 16px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; margin-bottom: 10px; }
                .btn-primary { background-color: #007bff; color: white; }
                .btn-primary:disabled { background-color: #c8c8c8; cursor: not-allowed; }
                .btn-secondary { background-color: #28a745; color: white; }
                .btn-secondary:disabled { background-color: #c8c8c8; cursor: not-allowed; }
                .header-flex { display: flex; justify-content: space-between; align-items: center; }
                .badge { background: #17a2b8; color: white; padding: 3px 8px; border-radius: 12px; font-size: 12px; }
                
                /* Thanh tiến trình CSS */
                .progress-container { margin-top: 8px; background-color: #e9ecef; border-radius: 4px; overflow: hidden; display: flex; height: 16px; font-size: 10px; line-height: 16px; color: white; text-align: center; }
                .bar-flash { background-color: #17a2b8; transition: width 0.2s; }
                .bar-avr { background-color: #28a745; transition: width 0.2s; }
                .status-text { font-size: 12px; color: #666; margin-top: 4px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header-flex">
                    <h2>Nạp OTA AT2560 MLN RB</h2>
                    <span class="badge" id="deviceCount">0 thiết bị online</span>
                </div>
                
                <form id="uploadForm" onsubmit="handleUpload(event)">
                    <p style="font-weight: bold;">1. Chọn danh sách mạch cần nạp:</p>
                    <div class="device-list" id="deviceList">
                        <div style="color: gray; text-align: center; padding: 15px;">Đang dò tìm thiết bị...</div>
                    </div>

                    <p style="font-weight: bold;">2. Chọn file chương trình (.bin):</p>
                    <input type="file" id="binFileInput" name="binFile" accept=".bin" required style="margin-bottom: 20px; width: 100%;">
                    
                    <button type="submit" id="btnNapChon" class="btn btn-primary" disabled onclick="window.submitMode='selected'">Nạp các mạch đã chọn</button>
                    <button type="submit" id="btnNapAll" class="btn btn-secondary" disabled onclick="window.submitMode='all'">Nạp ĐỒNG LOẠT tất cả</button>
                </form>
            </div>

            <script>
                const deviceListDiv = document.getElementById('deviceList');
                const deviceCountBadge = document.getElementById('deviceCount');
                const btnNapChon = document.getElementById('btnNapChon');
                const btnNapAll = document.getElementById('btnNapAll');

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

                            const checkedIds = Array.from(document.querySelectorAll('.device-checkbox:checked')).map(cb => cb.value);

                            let html = '';
                            currentDevices.forEach((device) => {
                                const isChecked = checkedIds.includes(device.id) ? 'checked' : '';
                                html += \`
                                    <div class="device-item">
                                        <div class="device-row">
                                            <label style="font-family: monospace; font-size: 14px; font-weight: bold;">
                                                <input type="checkbox" class="device-checkbox" value="\${device.id}" \${isChecked} onchange="validateSelection()">
                                                Mạch [\${device.id}] - IP: \${device.ip}
                                            </label>
                                            <span class="status-text">\${device.status}</span>
                                        </div>
                                        <div class="progress-container">
                                            <div class="bar-flash" style="width: \${device.flashProgress}%" title="Giai đoạn 1 (ESP Flash)">\${device.flashProgress > 10 ? 'ESP: ' + device.flashProgress + '%' : ''}</div>
                                            <div class="bar-avr" style="width: \${device.avrProgress}%" title="Giai đoạn 2 (AT2560)">\${device.avrProgress > 10 ? 'AVR: ' + device.avrProgress + '%' : ''}</div>
                                        </div>
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

                function handleUpload(event) {
                    event.preventDefault();
                    
                    if (window.submitMode === 'all') {
                        document.querySelectorAll('.device-checkbox').forEach(cb => cb.checked = true);
                    }
                    
                    const checkedIds = Array.from(document.querySelectorAll('.device-checkbox:checked')).map(cb => cb.value);
                    const fileInput = document.getElementById('binFileInput');

                    if (checkedIds.length === 0 || !fileInput.files[0]) {
                        alert("Vui lòng chọn thiết bị và file .bin!");
                        return;
                    }

                    const formData = new FormData();
                    formData.append('binFile', fileInput.files[0]);
                    formData.append('targetDevices', JSON.stringify(checkedIds));

                    fetch('/upload', { method: 'POST', body: formData })
                        .then(res => res.text())
                        .then(msg => alert(msg))
                        .catch(err => alert("Lỗi khi tải file: " + err));
                }

                setInterval(updateDeviceList, 1000); // Cập nhật giao diện mỗi 1 giây
                updateDeviceList();
            </script>
        </body>
        </html>
    `);
});

// API nhận file BIN và kích hoạt quá trình nạp
app.post('/upload', upload.single('binFile'), (req, res) => {
    if (!req.file) return res.status(400).send("Lỗi: Vui lòng chọn file .bin");

    let targetIds = [];
    try {
        targetIds = JSON.parse(req.body.targetDevices || "[]");
    } catch (e) {
        return res.status(400).send("Dữ liệu thiết bị không hợp lệ.");
    }

    let sentCount = 0;
    const CHUNK_SIZE = 1024; 

    for (const [ws, info] of espClients.entries()) {
        if (targetIds.includes(info.id) && ws.readyState === WebSocket.OPEN) {
            info.firmwareBuffer = req.file.buffer;
            info.currentOffset = 0;
            info.chunkSize = CHUNK_SIZE;
            info.flashProgress = 0;
            info.avrProgress = 0;
            info.status = "Giai đoạn 1: Đang ghi vào Flash ESP...";

            info.lastHeartbeat = Date.now(); 
            ws.send(`START_UPDATE:${req.file.buffer.length}`);
            sentCount++;
        }
    }

    res.send(`Đã kích hoạt tiến trình nạp thành công cho ${sentCount} mạch!`);
});

// Xử lý các sự kiện WebSocket
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;

    espClients.set(ws, {
        id: "Chờ kết nối...", 
        ip: clientIp,
        lastHeartbeat: Date.now(),
        status: "Sẵn sàng",
        flashProgress: 0,
        avrProgress: 0
    });

    ws.on('message', (message) => {
        const msgStr = message.toString();
        const info = espClients.get(ws);
        if (!info) return;

        // 1. Nhận tin nhắn định danh
        if (msgStr.startsWith("identity:")) {
            info.id = "ESP_" + msgStr.split(":")[1];
        }
        
        // 2. Nhận phản hồi Heartbeat
        if (msgStr === "pong") {
            info.lastHeartbeat = Date.now(); 
        }

        // 3. ESP yêu cầu nhận gói dữ liệu tiếp theo (Giai đoạn 1: Server -> ESP Flash)
        if (msgStr === "NEXT_CHUNK") {
            if (info.firmwareBuffer) {
                const buffer = info.firmwareBuffer;
                const offset = info.currentOffset;
                const size = info.chunkSize;

                info.lastHeartbeat = Date.now();

                if (offset < buffer.length) {
                    const end = Math.min(offset + size, buffer.length);
                    const chunk = buffer.subarray(offset, end);
                    info.currentOffset = end;

                    // Tính toán % tiến trình lưu Flash ESP
                    info.flashProgress = Math.round((end / buffer.length) * 100);

                    ws.send(chunk, { binary: true });
                } else {
                    info.flashProgress = 100;
                    info.status = "Giai đoạn 1: Hoàn tất! Chờ nạp sang AT2560...";
                    ws.send("UPDATE_COMPLETE");
                    
                    // Giải phóng buffer
                    info.firmwareBuffer = null;
                    info.currentOffset = 0;
                }
            }
        }

        // 4. Bổ sung: Lắng nghe Tiến trình nạp từ Flash ESP sang AT2560 (Giai đoạn 2)
        if (msgStr.startsWith("PROGRESS_AVR:")) {
            const percent = parseInt(msgStr.split(":")[1]);
            info.avrProgress = percent;
            info.status = `Giai đoạn 2: Đang nạp AT2560 (${percent}%)`;
            info.lastHeartbeat = Date.now();

            if (percent >= 100) {
                info.status = "Thành công: Đã nạp xong AT2560!";
            }
        }
        
        // Bổ sung: Báo lỗi từ ESP nếu quá trình ghi AVR thất bại
        if (msgStr.startsWith("ERROR_AVR:")) {
            const errDetail = msgStr.split(":")[1];
            info.status = `Lỗi nạp AT2560: ${errDetail}`;
        }
    });

    ws.on('close', () => espClients.delete(ws));
    ws.on('error', () => espClients.delete(ws));
});

// Chu kỳ kiểm tra Heartbeat
const interval = setInterval(() => {
    const now = Date.now();
    for (const [ws, info] of espClients.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
            if (info.firmwareBuffer || info.avrProgress > 0 && info.avrProgress < 100) {
                continue; // Bỏ qua timeout khi đang bận nạp ở 1 trong 2 giai đoạn
            }

            if (now - info.lastHeartbeat > 7000) {
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

wss.on('close', () => clearInterval(interval));

server.listen(process.env.PORT || 3000, () => {
    console.log('Server đang hoạt động tại port 3000...');
});

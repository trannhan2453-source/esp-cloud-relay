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

// Giao diện web đa thiết bị (Đã sửa đổi để chấp nhận file .bin)
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
                    <h2>Multi-Device Programmer (Binary Mode)</h2>
                    <span class="badge" id="deviceCount">0 thiết bị online</span>
                </div>
                
                <form action="/upload" method="post" enctype="multipart/form-data">
                    <p style="font-weight: bold;">1. Chọn danh sách mạch cần nạp:</p>
                    <div class="device-list" id="deviceList">
                        <div style="color: gray; text-align: center; padding: 15px;">Đang dò tìm thiết bị...</div>
                    </div>

                    <p style="font-weight: bold;">2. Chọn file chương trình (.bin):</p>
                    <!-- THAY ĐỔI: Chấp nhận file .bin thay vì .hex -->
                    <input type="file" name="binFile" accept=".bin" required style="margin-bottom: 20px; width: 100%;">
                    
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

                            const checkedIds = Array.from(document.querySelectorAll('.device-checkbox:checked')).map(cb => cb.value);

                            let html = '';
                            currentDevices.forEach((device) => {
                                const isChecked = checkedIds.includes(device.id) ? 'checked' : '';
                                html += '<div class="device-item">' +
                                        '<input type="checkbox" class="device-checkbox" value="' + device.id + '" ' + isChecked + ' onchange="validateSelection()">' +
                                        '<label style="font-family: monospace; font-size: 14px;">Mạch [' + device.id + '] - IP: ' + device.ip + '</label>' +
                                        '</div>';
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

                function prepareSubmit(mode) {
                    if (mode === 'all') {
                        document.querySelectorAll('.device-checkbox').forEach(cb => cb.checked = true);
                    }
                    const checkedIds = Array.from(document.querySelectorAll('.device-checkbox:checked')).map(cb => cb.value);
                    targetDevicesInput.value = JSON.stringify(checkedIds);
                }

                setInterval(updateDeviceList, 2000);
                updateDeviceList();
            </script>
        </body>
        </html>
    `);
});

// THAY ĐỔI: Xử lý nạp file BIN nhận từ input "binFile"
app.post('/upload', upload.single('binFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).send("<h3>Lỗi: Vui lòng chọn file .bin</h3>");
    }

    let targetIds = [];
    try {
        targetIds = JSON.parse(req.body.targetDevices || "[]");
    } catch (e) {
        return res.status(400).send("Dữ liệu không hợp lệ.");
    }

    const activeList = getActiveESPs();
    let sentCount = 0;

    activeList.forEach(device => {
        if (targetIds.includes(device.id)) {
            // Lưu trữ buffer file và trạng thái nạp vào chính object quản lý thiết bị
            device.firmwareBuffer = req.file.buffer;
            device.currentPointer = 0;
            
            // Gửi lệnh TEXT báo hiệu: "Bắt đầu nạp, tổng kích thước file là X bytes"
            device.ws.send(`START_UPDATE:${req.file.buffer.length}`);
            sentCount++;
        }
    });

    res.send(`<h3>Đã kích hoạt tiến trình nạp cho ${sentCount} mạch!</h3><a href='/'>Quay lại</a>`);
});

// Quản lý kết nối WebSocket
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    
    console.log(`Có mạch kết nối mới từ IP: ${clientIp}. Đang chờ định danh...`);

    // Lưu vào Map quản lý kết nối với ID tạm
    espClients.set(ws, {
        id: "Chờ kết nối...", 
        ip: clientIp,
        lastHeartbeat: Date.now()
    });

    ws.on('message', (message) => {
        const msgStr = message.toString();
        const info = espClients.get(ws);
        if (!info) return;
    
        if (msgStr.startsWith("identity:")) { /* ... giữ nguyên ... */ }
        if (msgStr === "pong") { /* ... giữ nguyên ... */ }
    
        // KHI ESP NẠP XONG 1 TRANG VÀ XIN TRANG TIẾP THEO
        if (msgStr === "NEXT_PAGE" && info.firmwareBuffer) {
            const PAGE_SIZE = 256;
            const remainder = info.firmwareBuffer.length - info.currentPointer;
            
            if (remainder > 0) {
                const chunkSize = Math.min(PAGE_SIZE, remainder);
                // Cắt đúng 256 bytes (hoặc ít hơn ở trang cuối)
                const chunk = info.firmwareBuffer.slice(info.currentPointer, info.currentPointer + chunkSize);
                
                // Gửi dạng Binary miếng nhỏ này xuống
                ws.send(chunk, { binary: true });
                info.currentPointer += chunkSize;
            } else {
                // Đã gửi hết file
                ws.send("END_UPDATE");
                delete info.firmwareBuffer;
            }
        }
    });

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

// Chu kỳ gửi Ping tự động mỗi 4 giây duy trì kết nối
const interval = setInterval(() => {
    const now = Date.now();
    
    for (const [ws, info] of espClients.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
            // Quá 7 giây không nhận được pong thực tế từ mạch này
            if (now - info.lastHeartbeat > 7000) {
                console.log(`Mạch [ID: ${info.id}] mất liên lạc. Tiến hành hủy kết nối...`);
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
    console.log('Server đang hoạt động ở chế độ Multi-Device (.BIN firmware)...');
});

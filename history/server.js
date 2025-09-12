const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); // 將 WebSocket 綁定到同一個 server
const port = 8080;

// 确保目录存在
const alertsDir = path.join(__dirname, 'alerts');
const imagesDir = path.join(__dirname, 'images');
fs.ensureDirSync(alertsDir);
fs.ensureDirSync(imagesDir);

// 存储警报数据的文件
const alertsFile = path.join(alertsDir, 'alerts.json');

// 初始化警报数据文件
if (!fs.existsSync(alertsFile)) {
    fs.writeJsonSync(alertsFile, []);
}

// 存储所有连接的 WebSocket 客户端
const clients = new Set();

// WebSocket 连接处理
wss.on('connection', (ws) => {
    console.log('新的 WebSocket 连接建立, 当前客户端数量:', clients.size + 1);
    clients.add(ws);

    // 发送当前所有警报给新连接的客户端
    try {
        const alerts = fs.readJsonSync(alertsFile);
        ws.send(JSON.stringify({
            type: 'initial_alerts',
            data: alerts
        }));
    } catch (error) {
        console.error('发送初始警报错误:', error);
    }

    ws.on('close', () => {
        console.log('WebSocket 连接关闭, 剩余客户端数量:', clients.size - 1);
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error('WebSocket 错误:', err.message);
        clients.delete(ws);
    });
});

// 向所有客户端发送警报通知
function sendAlertToAllClients(alert) {
    const notification = {
        type: 'new_alert',
        data: alert
    };

    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(notification));
                console.log(`警报通知已发送到客户端: ${alert.id}`);
            } catch (error) {
                console.error('发送警报通知错误:', error.message);
            }
        }
    });
}

// 中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Base64 解码并保存图片
function saveBase64Image(base64Data, filename) {
    try {
        const base64String = base64Data.replace(/^data:image\/jpeg;base64,/, '');
        const imageBuffer = Buffer.from(base64String, 'base64');
        const imagePath = path.join(imagesDir, filename);
        fs.writeFileSync(imagePath, imageBuffer);
        console.log(`图片已保存: ${filename}`);
        return filename;
    } catch (error) {
        console.error('保存图片错误:', error);
        return null;
    }
}

// 存储警报数据
function saveAlert(alertData) {
    try {
        const alerts = fs.readJsonSync(alertsFile);
        const newAlert = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            ...alertData,
            imagePath: alertData.imagePath || null,
            acknowledged: false // 添加确认状态字段
        };
        
        alerts.push(newAlert);
        fs.writeJsonSync(alertsFile, alerts, { spaces: 2 });
        return newAlert;
    } catch (error) {
        console.error('保存警报错误:', error);
        throw error;
    }
}

// 处理 POST 请求
app.post('/', (req, res) => {
    console.log('=== 收到 POST 请求 ===');
    console.log('请求时间:', new Date().toISOString());
    console.log('请求头:', req.headers);
    console.log('请求体:', JSON.stringify(req.body, null, 2).substring(0, 500) + '...');
    console.log('========================');

    let imagePath = null;

    if (req.body.Frame && req.body.Frame.startsWith('/9j/')) {
        const timestamp = Date.now();
        const filename = `alert_${timestamp}.jpg`;
        imagePath = saveBase64Image(req.body.Frame, filename);
    }

    const alertData = {
        ...req.body,
        imagePath,
        headers: req.headers
    };

    delete alertData.Frame;

    try {
        const savedAlert = saveAlert(alertData);

        // 发送实时通知到所有客户端
        sendAlertToAllClients(savedAlert);

        res.json({
            status: 'success',
            message: '警报已保存',
            alert: savedAlert
        });
    } catch (error) {
        console.error('处理请求错误:', error);
        res.status(500).json({
            status: 'error',
            message: '保存警报失败'
        });
    }
});

// API: 确认警报
app.post('/api/alerts/:id/acknowledge', (req, res) => {
    try {
        const alerts = fs.readJsonSync(alertsFile);
        const alertIndex = alerts.findIndex(a => a.id === parseInt(req.params.id));
        
        if (alertIndex === -1) {
            return res.status(404).json({
                status: 'error',
                message: '警报未找到'
            });
        }

        alerts[alertIndex].acknowledged = true;
        fs.writeJsonSync(alertsFile, alerts, { spaces: 2 });

        // 发送确认通知到所有客户端
        const ackNotification = {
            type: 'alert_acknowledged',
            data: {
                id: parseInt(req.params.id),
                acknowledged: true
            }
        };
        
        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(ackNotification));
            }
        });

        res.json({
            status: 'success',
            message: '警报已确认'
        });
    } catch (error) {
        console.error('确认警报错误:', error);
        res.status(500).json({
            status: 'error',
            message: '确认警报失败'
        });
    }
});

// 其他 API 端点保持不变...
// API: 获取所有警报列表
app.get('/api/alerts', (req, res) => {
    try {
        const alerts = fs.readJsonSync(alertsFile);
        const alertList = alerts.map(alert => {
            const { Frame, ...alertWithoutFrame } = alert;
            return alertWithoutFrame;
        });

        res.json({
            status: 'success',
            count: alertList.length,
            alerts: alertList
        });
    } catch (error) {
        console.error('获取警报列表错误:', error);
        res.status(500).json({
            status: 'error',
            message: '获取警报列表失败'
        });
    }
});

// API: 获取特定警报详情
app.get('/api/alerts/:id', (req, res) => {
    try {
        const alerts = fs.readJsonSync(alertsFile);
        const alert = alerts.find(a => a.id === parseInt(req.params.id));
        
        if (!alert) {
            return res.status(404).json({
                status: 'error',
                message: '警报未找到'
            });
        }

        const { Frame, ...alertWithoutFrame } = alert;

        res.json({
            status: 'success',
            alert: alertWithoutFrame
        });
    } catch (error) {
        console.error('获取警报详情错误:', error);
        res.status(500).json({
            status: 'error',
            message: '获取警报详情失败'
        });
    }
});

// API: 获取警报图片
app.get('/api/images/:filename', (req, res) => {
    const imagePath = path.join(imagesDir, req.params.filename);
    
    if (fs.existsSync(imagePath)) {
        res.sendFile(imagePath);
    } else {
        res.status(404).json({
            status: 'error',
            message: '图片未找到'
        });
    }
});

// API: 删除警报
app.delete('/api/alerts/:id', (req, res) => {
    try {
        const alerts = fs.readJsonSync(alertsFile);
        const alertIndex = alerts.findIndex(a => a.id === parseInt(req.params.id));
        
        if (alertIndex === -1) {
            return res.status(404).json({
                status: 'error',
                message: '警报未找到'
            });
        }

        const deletedAlert = alerts.splice(alertIndex, 1)[0];
        
        if (deletedAlert.imagePath) {
            const imagePath = path.join(imagesDir, deletedAlert.imagePath);
            if (fs.existsSync(imagePath)) {
                fs.removeSync(imagePath);
            }
        }

        fs.writeJsonSync(alertsFile, alerts, { spaces: 2 });

        res.json({
            status: 'success',
            message: '警报已删除',
            deletedAlert: deletedAlert
        });
    } catch (error) {
        console.error('删除警报错误:', error);
        res.status(500).json({
            status: 'error',
            message: '删除警报失败'
        });
    }
});

// 静态文件服务
app.use('/images', express.static(imagesDir));
app.use(express.static(path.join(__dirname, 'public')));

// 根路径返回基本信息
app.get('/', (req, res) => {
    res.json({
        message: '警报服务器运行中',
        endpoints: {
            'POST /': '接收警报数据',
            'GET /api/alerts': '获取所有警报列表',
            'GET /api/alerts/:id': '获取特定警报详情',
            'GET /api/images/:filename': '获取警报图片',
            'DELETE /api/alerts/:id': '删除警报',
            'POST /api/alerts/:id/acknowledge': '确认警报'
        }
    });
});

// 启动服务器
server.listen(port, () => {
    console.log(`警报服务器运行在 http://localhost:${port}`);
    console.log('WebSocket 服务器已启动');
});

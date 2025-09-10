const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const app = express();
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

// 中间件
app.use(express.json({ limit: '10mb' })); // 增加限制以处理大图片
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Base64 解码并保存图片
function saveBase64Image(base64Data, filename) {
    try {
        // 移除 data:image/jpeg;base64, 前缀（如果存在）
        const base64String = base64Data.replace(/^data:image\/jpeg;base64,/, '');
        
        // 创建缓冲区
        const imageBuffer = Buffer.from(base64String, 'base64');
        
        // 保存图片文件
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
            imagePath: alertData.imagePath || null
        };
        
        alerts.push(newAlert);
        fs.writeJsonSync(alertsFile, alerts, { spaces: 2 });
        return newAlert;
    } catch (error) {
        console.error('保存警报错误:', error);
        throw error;
    }
}

// 修改这一行：将 app.post('/*') 修改为 app.post('/alert') 或其他特定路径
// 或者为了兼容旧版行为，可以使用 app.use 来捕获所有 POST 请求
app.post('/', (req, res) => { // This is a simple and common way to handle POST requests to the root path
    console.log('=== 收到 POST 请求 ===');
    console.log('请求时间:', new Date().toISOString());
    console.log('请求头:', req.headers);
    console.log('请求体:', JSON.stringify(req.body, null, 2).substring(0, 500) + '...'); // 只打印部分内容
    console.log('========================');

    let imagePath = null;

    // 如果有 Frame 字段且包含图片数据
    if (req.body.Frame && req.body.Frame.startsWith('/9j/')) {
        const timestamp = Date.now();
        const filename = `alert_${timestamp}.jpg`;
        imagePath = saveBase64Image(req.body.Frame, filename);
    }

    // 保存警报信息
    const alertData = {
        ...req.body,
        imagePath,
        headers: req.headers
    };

    // 移除图片数据以减少存储空间
    delete alertData.Frame;

    try {
        const savedAlert = saveAlert(alertData);

        // 返回响应
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

// API: 获取所有警报列表
app.get('/api/alerts', (req, res) => {
    try {
        const alerts = fs.readJsonSync(alertsFile);
        
        // 移除图片数据以减少响应大小
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

        // 移除图片数据
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
        
        // 删除关联的图片
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

// 静态文件服务（用于直接查看图片）
app.use('/images', express.static(imagesDir));

// 根路径返回基本信息
app.get('/', (req, res) => {
    res.json({
        message: '警报服务器运行中',
        endpoints: {
            'POST /': '接收警报数据',
            'GET /api/alerts': '获取所有警报列表',
            'GET /api/alerts/:id': '获取特定警报详情',
            'GET /api/images/:filename': '获取警报图片',
            'DELETE /api/alerts/:id': '删除警报'
        }
    });
});

app.use(express.static(path.join(__dirname, 'public')));
// 启动服务器
app.listen(port, () => {
    console.log(`警报服务器运行在 http://localhost:${port}`);
});
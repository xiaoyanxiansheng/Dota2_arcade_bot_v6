const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;
const PROJECT_ROOT = path.join(__dirname, '..');

// 进程管理
const processes = {
    showcase: { process: null, startTime: null },
    farming: { process: null, startTime: null },
    tool: { process: null, name: null } // 当前运行的工具脚本
};

// 帮助函数：广播日志
function broadcastLog(source, message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const logEntry = {
        timestamp,
        source,
        message: message.trim(),
        type
    };
    io.emit('log', logEntry);
    
    // 只有 System 级别的消息才打印到 Web 服务器的控制台
    // 工具、showcase、farming 的输出只发送到 Web 前端
    if (source === 'System') {
        console.log(`[${timestamp}] [${source}] ${message.trim()}`);
    }
}

// 帮助函数：启动进程
function startProcess(key, command, args, cwd = PROJECT_ROOT) {
    if (processes[key].process) {
        broadcastLog('System', `${key} 进程已在运行中`, 'warning');
        return false;
    }

    broadcastLog('System', `正在启动 ${key} ...`, 'info');
    
    // 移除 shell: true，直接启动 node 进程，这样可以获得准确的 PID
    const child = spawn(command, args, { 
        cwd, 
        // shell: true, // 移除 shell 包装
        stdio: ['pipe', 'pipe', 'pipe'] // 启用 stdin/stdout/stderr
    });
    processes[key].process = child;
    processes[key].startTime = Date.now();

    // 状态推送
    io.emit('status', { [key]: true });

    child.stdout.on('data', (data) => {
        // 按行分割输出，避免多行合并
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                // 检测是否需要验证码
                if (line.includes('[STEAM_GUARD]')) {
                    const domain = line.replace('[STEAM_GUARD]', '').trim();
                    io.emit('needSteamGuard', { key, domain });
                }
                broadcastLog(key, line, 'info');
            }
        });
    });

    child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                broadcastLog(key, line, 'error');
            }
        });
    });

    child.on('close', (code) => {
        broadcastLog('System', `${key} 进程已退出 (代码: ${code})`, code === 0 ? 'success' : 'error');
        processes[key].process = null;
        processes[key].startTime = null;
        io.emit('status', { [key]: false });
        
        // 如果是工具脚本，清除当前工具状态
        if (key === 'tool') {
            processes.tool.name = null;
            io.emit('toolStatus', { running: false, name: null });
        }
    });

    return true;
}

// 帮助函数：停止进程（先清理再停止）
function stopProcess(key, skipCleanup = false) {
    if (!processes[key].process) {
        return false;
    }
    
    broadcastLog('System', `正在停止 ${key} ...`, 'warning');
    // Windows 下 tree-kill 比较复杂，这里尝试简单的 kill
    try {
        process.kill(processes[key].process.pid);
        // 对于 Windows，可能需要 taskkill
        spawn("taskkill", ["/pid", processes[key].process.pid, '/f', '/t']);
    } catch (e) {
        broadcastLog('System', `停止失败: ${e.message}`, 'error');
    }
    return true;
}

// 帮助函数：清理并停止进程
function cleanupAndStopProcess(key) {
    if (!processes[key].process) {
        return { success: false, reason: 'not_running' };
    }
    
    const targetPid = processes[key].process.pid; // 保存 PID
    const childProcess = processes[key].process;
    
    broadcastLog('System', `正在停止 ${key} 车队...`, 'warning');
    
    // 正确的清理方式：向进程 stdin 发送 "exit" 命令
    // 进程收到后会自己调用 cleanup()，发送退出房间命令，然后退出
    try {
        if (childProcess.stdin && !childProcess.stdin.destroyed) {
            childProcess.stdin.write('exit\n');
            broadcastLog('System', `已发送退出命令到 ${key}`, 'info');
        }
    } catch (e) {
        broadcastLog('System', `发送退出命令失败: ${e.message}`, 'error');
    }
    
    // 设置超时：如果进程 5 秒内没有自己退出，强制杀掉
    const forceKillTimeout = setTimeout(() => {
        if (processes[key].process) {
            broadcastLog('System', `${key} 进程未响应，强制终止...`, 'warning');
            try {
                process.kill(targetPid, 'SIGKILL');
                spawn("taskkill", ["/pid", targetPid, '/f', '/t']);
            } catch (e) {}
            
            processes[key].process = null;
            processes[key].startTime = null;
            
            io.emit('status', { 
                showcase: !!processes.showcase.process, 
                farming: !!processes.farming.process 
            });
            
            broadcastLog('System', `${key} 进程已强制停止`, 'warning');
        }
    }, 5000);
    
    // 监听进程正常退出
    childProcess.once('close', (code) => {
        clearTimeout(forceKillTimeout);
        
        processes[key].process = null;
        processes[key].startTime = null;
        
        io.emit('status', { 
            showcase: !!processes.showcase.process, 
            farming: !!processes.farming.process 
        });
        
        broadcastLog('System', `${key} 进程已完全停止`, 'success');
    });
    
    return { success: true };
}

// ============================================
// API 路由
// ============================================

// 获取状态
app.get('/api/status', (req, res) => {
    res.json({
        showcase: !!processes.showcase.process,
        farming: !!processes.farming.process,
        tool: {
            running: !!processes.tool.process,
            name: processes.tool.name
        }
    });
});

// 解散房间请求（展示车队轮换时调用）
app.post('/api/dissolve_rooms', (req, res) => {
    const { roomIds } = req.body;
    
    if (!roomIds || !Array.isArray(roomIds) || roomIds.length === 0) {
        return res.status(400).json({ error: '无效的房间ID列表' });
    }
    
    broadcastLog('System', `收到解散房间请求: ${roomIds.length} 个房间`, 'info');
    
    // 广播给所有挂机车队进程
    io.emit('dissolveRooms', { roomIds });
    
    // 如果挂机车队进程正在运行，通过 stdin 发送命令
    if (processes.farming.process && processes.farming.process.stdin) {
        const command = JSON.stringify({ type: 'dissolve_rooms', roomIds }) + '\n';
        processes.farming.process.stdin.write(command);
        broadcastLog('System', `已发送解散命令到挂机车队`, 'success');
    } else {
        broadcastLog('System', `挂机车队未运行，无法发送解散命令`, 'warning');
    }
    
    res.json({ success: true, message: `已广播解散 ${roomIds.length} 个房间` });
});

// 读取配置
app.get('/api/config/:type', (req, res) => {
    const type = req.params.type; // showcase | farming
    let configPath;
    
    if (type === 'showcase') configPath = path.join(PROJECT_ROOT, 'config', 'config_showcase.json');
    else if (type === 'farming') configPath = path.join(PROJECT_ROOT, 'config', 'config_farming.json');
    else return res.status(400).json({ error: 'Invalid config type' });

    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf8');
            res.json(JSON.parse(content));
        } else {
            res.json({});
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 保存配置
app.post('/api/config/:type', (req, res) => {
    const type = req.params.type;
    const newConfig = req.body;
    let configPath;
    
    if (type === 'showcase') configPath = path.join(PROJECT_ROOT, 'config', 'config_showcase.json');
    else if (type === 'farming') configPath = path.join(PROJECT_ROOT, 'config', 'config_farming.json');
    else return res.status(400).json({ error: 'Invalid config type' });

    try {
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
        broadcastLog('System', `配置已更新: ${type}`, 'success');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 读取代理列表
app.get('/api/proxies', (req, res) => {
    try {
        const proxyPath = path.join(PROJECT_ROOT, 'data', 'proxies.txt');
        if (fs.existsSync(proxyPath)) {
            const content = fs.readFileSync(proxyPath, 'utf8');
            res.json({ content });
        } else {
            res.json({ content: '' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 列出 CSV 文件
app.get('/api/csv_files', (req, res) => {
    try {
        const files = fs.readdirSync(PROJECT_ROOT)
            .filter(f => f.startsWith('lobbies_') && f.endsWith('.csv'))
            .map(f => {
                const stat = fs.statSync(path.join(PROJECT_ROOT, f));
                return {
                    name: f,
                    size: stat.size,
                    mtime: stat.mtime.getTime()
                };
            })
            .sort((a, b) => b.mtime - a.mtime); // 最新的在前
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 下载 CSV 文件
app.get('/api/csv/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filepath = path.join(PROJECT_ROOT, filename);
        if (fs.existsSync(filepath) && filename.startsWith('lobbies_') && filename.endsWith('.csv')) {
            res.download(filepath);
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 控制进程
app.post('/api/process/:name/:action', (req, res) => {
    const { name, action } = req.params;
    
    if (action === 'start') {
        let cmd = 'node';
        let args = [];
        
        if (name === 'showcase') {
            args = ['src/showcase.js', '--config=config/config_showcase.json'];
        } else if (name === 'farming') {
            args = ['src/farming.js', '--config=config/config_farming.json'];
        } else {
            return res.status(400).json({ error: 'Unknown process' });
        }

        const success = startProcess(name, cmd, args);
        res.json({ success });
        
    } else if (action === 'stop') {
        // 停止时先清理车队账号（退出组队、退出游戏）
        const result = cleanupAndStopProcess(name);
        res.json({ success: result.success });
    } else {
        res.status(400).json({ error: 'Invalid action' });
    }
});

// 执行工具
app.post('/api/tool/:name', (req, res) => {
    const name = req.params.name;
    const body = req.body || {};
    
    if (processes.tool.process) {
        return res.status(409).json({ error: 'Another tool is already running' });
    }

    let cmd = 'node';
    let args = [];
    
    if (name === 'login_leader') {
        // 登录主号: 需要参数 type 和 username
        const type = body.type || '';
        const username = body.username || '';
        args = ['commands/login_leader.js', type, username];
        processes.tool.name = `Login Leader: ${username}`;
        
    } else if (name === 'subscribe_map') {
        // 订阅地图
        args = ['commands/subscribe_map.js'];
        processes.tool.name = 'Subscribe Maps';
        
    } else if (name === 'list_lobbies') {
        // 查询房间: 可选 gameId
        const gameId = body.gameId || '';
        args = ['commands/list_lobbies.js', gameId];
        processes.tool.name = 'List Lobbies';
        
    } else if (name === 'clear_all') {
        // 清理所有
        args = ['commands/clear_all.js'];
        processes.tool.name = 'Clear All';
        
    } else {
        return res.status(400).json({ error: 'Unknown tool' });
    }

    io.emit('toolStatus', { running: true, name: processes.tool.name });
    const success = startProcess('tool', cmd, args);
    res.json({ success });
});

// 监听连接
io.on('connection', (socket) => {
    // console.log('Client connected');
    
    // 发送当前状态
    socket.emit('status', {
        showcase: !!processes.showcase.process,
        farming: !!processes.farming.process
    });
    
    if (processes.tool.process) {
        socket.emit('toolStatus', { running: true, name: processes.tool.name });
    }

    // 接收验证码
    socket.on('submitSteamGuard', ({ key, code }) => {
        if (processes[key] && processes[key].process && processes[key].process.stdin) {
            processes[key].process.stdin.write(code + '\n');
            broadcastLog('System', `已提交验证码到 ${key}`, 'info');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Web Server running at http://localhost:${PORT}`);
    console.log(`Root: ${PROJECT_ROOT}`);
});


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
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

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
// logSource: 日志来源名称（可选，默认使用 key）
function startProcess(key, command, args, cwd = PROJECT_ROOT, logSource = null) {
    if (processes[key].process) {
        broadcastLog('System', `${key} 进程已在运行中`, 'warning');
        return false;
    }

    const source = logSource || key;  // 使用自定义 source 或默认 key
    broadcastLog('System', `正在启动 ${source} ...`, 'info');
    
    // 移除 shell: true，直接启动 node 进程，这样可以获得准确的 PID
    const child = spawn(command, args, { 
        cwd, 
        // shell: true, // 移除 shell 包装
        stdio: ['pipe', 'pipe', 'pipe'] // 启用 stdin/stdout/stderr
    });
    processes[key].process = child;
    processes[key].startTime = Date.now();
    processes[key].logSource = source;  // 保存 source

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
                broadcastLog(source, line, 'info');
            }
        });
    });

    child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                broadcastLog(source, line, 'error');
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
            processes.tool.logSource = null;
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

// 结算房间请求（展示车队调用：由挂机车队自行选择“可解散”的房间）
app.post('/api/settle_rooms', (req, res) => {
    const count = Number(req.body?.count || 1);
    const excludeRoomIds = Array.isArray(req.body?.excludeRoomIds) ? req.body.excludeRoomIds : [];

    if (!Number.isFinite(count) || count <= 0) {
        return res.status(400).json({ error: '无效的 count' });
    }

    broadcastLog('System', `收到结算请求: count=${count} exclude=${excludeRoomIds.length}`, 'info');

    // 广播给所有挂机车队进程（前端/多进程兼容）
    io.emit('settleRooms', { count, excludeRoomIds });

    if (processes.farming.process && processes.farming.process.stdin) {
        const command = JSON.stringify({ type: 'settle_rooms', count, excludeRoomIds }) + '\n';
        processes.farming.process.stdin.write(command);
        broadcastLog('System', `已发送结算命令到挂机车队`, 'success');
    } else {
        broadcastLog('System', `挂机车队未运行，无法发送结算命令`, 'warning');
    }

    res.json({ success: true, message: `已请求结算 ${count} 个房间` });
});

// 读取配置
app.get('/api/config/:type', (req, res) => {
    const type = req.params.type; // showcase | leaders
    let configPath;
    
    if (type === 'showcase') configPath = path.join(PROJECT_ROOT, 'config', 'config_showcase.json');
    else if (type === 'leaders') configPath = path.join(PROJECT_ROOT, 'config', 'config_leaders.json');
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
    else if (type === 'leaders') configPath = path.join(PROJECT_ROOT, 'config', 'config_leaders.json');
    else return res.status(400).json({ error: 'Invalid config type' });

    try {
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
        broadcastLog('System', `配置已更新: ${type}`, 'success');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// Farm 配置管理 API
// ============================================

// 获取所有 farm 配置列表（v4.0：不再有 proxies.txt）
app.get('/api/farm/configs', (req, res) => {
    try {
        const farmDir = path.join(PROJECT_ROOT, 'config', 'farm');
        
        // 确保目录存在
        if (!fs.existsSync(farmDir)) {
            fs.mkdirSync(farmDir, { recursive: true });
            return res.json({ configs: [] });
        }
        
        const items = fs.readdirSync(farmDir, { withFileTypes: true });
        const configs = items
            .filter(item => item.isDirectory() && item.name.startsWith('config_'))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(item => {
                const name = item.name;
                const configDir = path.join(farmDir, name);
                const followersPath = path.join(configDir, 'followers.txt');
                
                let followers = 0;
                if (fs.existsSync(followersPath)) {
                    const content = fs.readFileSync(followersPath, 'utf8');
                    followers = content.split('\n').filter(line => line.trim() && line.includes(',')).length;
                }
                
                return { name, followers };
            })
            .filter(cfg => cfg.followers > 0); // 只返回有小号的配置
        
        res.json({ configs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 读取单个 farm 配置（v4.0：只返回 followers.txt）
app.get('/api/farm/config/:name', (req, res) => {
    try {
        const name = req.params.name;
        const configDir = path.join(PROJECT_ROOT, 'config', 'farm', name);
        
        if (!fs.existsSync(configDir)) {
            return res.status(404).json({ error: 'Config not found' });
        }
        
        const followersPath = path.join(configDir, 'followers.txt');
        const followers = fs.existsSync(followersPath) ? fs.readFileSync(followersPath, 'utf8') : '';
        
        res.json({ followers });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 保存单个 farm 配置（v4.0：只保存 followers.txt）
app.post('/api/farm/config/:name', (req, res) => {
    try {
        const name = req.params.name;
        const configDir = path.join(PROJECT_ROOT, 'config', 'farm', name);
        
        // 确保目录存在
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        
        const { followers } = req.body;
        
        if (followers !== undefined) {
            fs.writeFileSync(path.join(configDir, 'followers.txt'), followers, 'utf8');
        }
        
        broadcastLog('System', `Farm 配置已保存: ${name}`, 'success');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 添加新的 farm 配置（v4.0：只创建 followers.txt）
app.post('/api/farm/add', (req, res) => {
    try {
        const { name } = req.body;
        
        if (!name || !name.match(/^config_\d{3}$/)) {
            return res.status(400).json({ error: '配置名称格式无效，应为 config_XXX (如 config_001)' });
        }
        
        const configDir = path.join(PROJECT_ROOT, 'config', 'farm', name);
        
        // 检查是否已存在
        if (fs.existsSync(configDir)) {
            return res.status(409).json({ error: '配置已存在' });
        }
        
        // 创建目录和空文件
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'followers.txt'), '# 格式：用户名,密码 (每行一个)\n', 'utf8');
        
        broadcastLog('System', `新建 Farm 配置: ${name}`, 'success');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 将配置加入小号池子（v4.0 新增）
app.post('/api/farm/add_to_pool', (req, res) => {
    const { configName } = req.body;
    
    if (!configName) {
        return res.status(400).json({ error: '缺少配置名称' });
    }
    
    if (!processes.farming.process || !processes.farming.process.stdin) {
        return res.status(400).json({ error: '挂机车队未运行' });
    }
    
    try {
        const command = JSON.stringify({ type: 'add_config', configName }) + '\n';
        processes.farming.process.stdin.write(command);
        broadcastLog('System', `已发送添加配置命令: ${configName}`, 'info');
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
        // CSV 统一存放到 data/ 目录
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const files = fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith('lobbies_') && f.endsWith('.csv'))
            .map(f => {
                const stat = fs.statSync(path.join(DATA_DIR, f));
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
        // CSV 统一存放到 data/ 目录
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const filepath = path.join(DATA_DIR, filename);
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
            // farming v3.0 不再需要 --config 参数
            // 自动从 config_leaders.json 和 config/farm/ 目录加载
            args = ['src/farming.js'];
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

// 替换代理配置（用测试成功的代理）
app.post('/api/proxy/replace', (req, res) => {
    const successProxiesPath = path.join(PROJECT_ROOT, 'data', 'success_proxies.json');
    const leadersConfigPath = path.join(PROJECT_ROOT, 'config', 'config_leaders.json');
    
    try {
        // 读取成功代理列表
        if (!fs.existsSync(successProxiesPath)) {
            return res.status(400).json({ error: '没有找到成功代理列表，请先运行代理测试' });
        }
        const successProxies = JSON.parse(fs.readFileSync(successProxiesPath, 'utf8'));
        
        if (!Array.isArray(successProxies) || successProxies.length === 0) {
            return res.status(400).json({ error: '成功代理列表为空' });
        }
        
        // 读取主号配置
        const leadersConfig = JSON.parse(fs.readFileSync(leadersConfigPath, 'utf8').replace(/^\uFEFF/, ''));
        const originalCount = (leadersConfig.proxies || []).length;
        
        // 替换代理列表
        leadersConfig.proxies = successProxies;
        
        // 写回配置文件
        fs.writeFileSync(leadersConfigPath, JSON.stringify(leadersConfig, null, 2), 'utf8');
        
        broadcastLog('System', `✅ 代理配置已替换: ${originalCount} → ${successProxies.length}`, 'success');
        res.json({ success: true, originalCount, newCount: successProxies.length });
        
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 停止工具（必须在 /api/tool/:name 之前定义，否则会被 :name 匹配）
app.post('/api/tool/stop', (req, res) => {
    console.log('[DEBUG] /api/tool/stop called');
    
    if (!processes.tool.process) {
        return res.status(400).json({ error: 'No tool is running' });
    }
    
    const toolName = processes.tool.name;
    const pid = processes.tool.process.pid;
    console.log('[DEBUG] Stopping tool:', toolName, 'PID:', pid);
    
    stopProcess('tool');
    broadcastLog('System', `已停止工具: ${toolName} (PID: ${pid})`, 'warning');
    res.json({ success: true });
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
        // ✅ 修复“展示验证日志跑到挂机日志”的问题：
        // 前端根据 source 分类；showcase 验证必须归到展示日志分页。
        // type: 'showcase' | 'leaders' (旧) | 其他（默认归挂机）
        if (type === 'showcase') {
            processes.tool.logSource = 'showcase';
        } else {
            processes.tool.logSource = 'farming';
        }
        
    } else if (name === 'subscribe_map') {
        // 订阅地图: 可选 configName 和 gameId
        const configName = body.configName || '';
        const gameId = body.gameId || '';
        console.log(`[Subscribe] configName=${configName}, gameId=${gameId}`);
        args = ['commands/subscribe_map.js', configName, gameId];
        processes.tool.name = 'Subscribe Maps';
        
    } else if (name === 'list_lobbies') {
        // 查询房间: 可选 gameId
        const gameId = body.gameId || '';
        args = ['commands/list_lobbies.js', gameId];
        processes.tool.name = 'List Lobbies';
        
    } else if (name === 'test_proxies') {
        // 测试代理
        args = ['commands/test_proxies.js'];
        processes.tool.name = 'Test Proxies';
        
    } else if (name === 'clear_all') {
        // 清理所有
        args = ['commands/clear_all.js'];
        processes.tool.name = 'Clear All';
        
    } else {
        return res.status(400).json({ error: 'Unknown tool' });
    }

    io.emit('toolStatus', { running: true, name: processes.tool.name });
    // 用具体的工具名作为日志 source（login_leader 例外：按 type 归类）
    const logSource = processes.tool.logSource || name;  // subscribe_map, list_lobbies, test_proxies, etc.
    const success = startProcess('tool', cmd, args, PROJECT_ROOT, logSource);
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


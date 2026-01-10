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

// 确保 data 目录存在（用于持久化池子状态）
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Farm 池子（运行态）：已加入的配置名（包含 config_000）。
// ⚠️ 按需求：不能落盘，只跟着“程序(进程)”走。
// 实现：优先从 farming 进程实时查询；同时缓存最近一次结果用于 fallback。
let _farmPoolConfigs = new Set(['config_000']);
let _farmLoadedConfigsWaiters = [];
let _lastFarmLoadedConfigs = null;

// farming 主号状态：等待队列（用于 /api/farming/leaders_status）
let _farmingLeadersStatusWaiters = [];
let _lastFarmingLeadersStatus = null;

// farming 目标挂机人数：等待队列（用于 /api/farming/set_target_followers）
let _farmingTargetFollowersWaiters = [];
let _lastFarmingTargetFollowersResult = null;

// 进程管理
const processes = {
    showcase: { process: null, startTime: null },
    farming: { process: null, startTime: null },
    tool: { process: null, name: null, gameId: null } // 当前运行的工具脚本
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
                // 🔴 解析 farming 输出的 JSON 事件（不写入日志，避免污染界面）
                // 用于：主号状态查询 + 启停结果回传
                if (key === 'farming') {
                    try {
                        const obj = JSON.parse(line);
                        if (obj && typeof obj === 'object') {
                            if (obj.type === 'leaders_status' && Array.isArray(obj.data)) {
                                _lastFarmingLeadersStatus = obj.data;
                                // 唤醒所有等待者
                                const waiters = _farmingLeadersStatusWaiters;
                                _farmingLeadersStatusWaiters = [];
                                waiters.forEach(w => {
                                    try { w.resolve(obj.data); } catch (e) {}
                                });
                                // 推送给前端（可用于实时 UI）
                                io.emit('farmingLeadersStatus', { data: obj.data });
                                return; // 不输出到日志
                            }
                            // 🔴 新增：farm 已加载配置（用于池子状态显示）
                            if (obj.type === 'loaded_configs' && Array.isArray(obj.data)) {
                                _lastFarmLoadedConfigs = obj.data;
                                _farmPoolConfigs = new Set(['config_000', ...obj.data.map(x => String(x)).filter(Boolean)]);
                                const waiters = _farmLoadedConfigsWaiters;
                                _farmLoadedConfigsWaiters = [];
                                waiters.forEach(w => {
                                    try { w.resolve(obj.data); } catch (e) {}
                                });
                                io.emit('farmLoadedConfigs', { data: obj.data });
                                return; // 不输出到日志
                            }
                            if (obj.type === 'stop_leader_result' || obj.type === 'start_leader_result') {
                                io.emit('farmingLeaderActionResult', obj);
                                return; // 不输出到日志
                            }
                            if (obj.type === 'set_target_followers_result') {
                                _lastFarmingTargetFollowersResult = obj;
                                const waiters = _farmingTargetFollowersWaiters;
                                _farmingTargetFollowersWaiters = [];
                                waiters.forEach(w => {
                                    try { w.resolve(obj); } catch (e) {}
                                });
                                io.emit('farmingTargetFollowers', obj);
                                return; // 不输出到日志
                            }
                        }
                    } catch (e) {}
                }

                // 检测是否需要验证码
                if (line.includes('[STEAM_GUARD]')) {
                    const domain = line.replace('[STEAM_GUARD]', '').trim();
                    io.emit('needSteamGuard', { key, domain });
                }
                // 检测房间创建成功信号，自动触发 list_lobbies
                if (line.includes('[ROOM_CREATED]') && processes.tool.gameId) {
                    const gameIdForQuery = processes.tool.gameId;
                    broadcastLog('test_leader', '🔍 房间创建成功，2秒后自动查询房间列表...', 'info');
                    // 延迟 2 秒后运行 list_lobbies（等待房间同步）
                    setTimeout(() => {
                        const listArgs = ['commands/list_lobbies.js', gameIdForQuery];
                        broadcastLog('test_leader', `📋 开始查询游戏ID: ${gameIdForQuery}`, 'info');
                        const listChild = spawn('node', listArgs, { cwd: PROJECT_ROOT });
                        
                        listChild.on('error', (err) => {
                            broadcastLog('test_leader', `❌ 查询启动失败: ${err.message}`, 'error');
                        });
                        
                        listChild.stdout.on('data', (data) => {
                            const lines = data.toString().split('\n');
                            lines.forEach(l => {
                                if (l.trim()) {
                                    // 同时输出到 test_leader 和 list_lobbies
                                    broadcastLog('test_leader', l, 'info');
                                    broadcastLog('list_lobbies', l, 'info');
                                }
                            });
                        });
                        listChild.stderr.on('data', (data) => {
                            const lines = data.toString().split('\n');
                            lines.forEach(l => {
                                if (l.trim()) {
                                    broadcastLog('test_leader', l, 'error');
                                    broadcastLog('list_lobbies', l, 'error');
                                }
                            });
                        });
                        listChild.on('close', (code) => {
                            const msg = code === 0 ? '✅ 查询完成' : `❌ 查询失败 (code: ${code})`;
                            broadcastLog('test_leader', msg, code === 0 ? 'info' : 'error');
                            broadcastLog('list_lobbies', `查询完成 (code: ${code})`, code === 0 ? 'info' : 'error');
                        });
                    }, 2000);
                    // 不输出 [ROOM_CREATED] 到日志
                    return;
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

        // farming 退出：清空运行态缓存，避免 UI 显示“已加入”残留
        if (key === 'farming') {
            _farmPoolConfigs = new Set(['config_000']);
            _lastFarmLoadedConfigs = null;
            _farmLoadedConfigsWaiters = [];
            io.emit('farmLoadedConfigs', { data: ['config_000'] });
        }
        
        // 如果是工具脚本，清除当前工具状态
        if (key === 'tool') {
            processes.tool.name = null;
            processes.tool.logSource = null;
            processes.tool.gameId = null;
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

    // ✅ 停止挂机车队时：重置“Farm 配置加入池子”的状态（只保留默认 config_000）
    // 说明：该状态是运行态内存（不能落盘），停服时应复位，避免 UI 处于不正确逻辑。
    if (key === 'farming') {
        try {
            _farmPoolConfigs = new Set(['config_000']);
            _lastFarmLoadedConfigs = null;
            _farmLoadedConfigsWaiters = [];
            broadcastLog('System', '已停止挂机车队：Farm 池子配置状态已重置(运行态内存)', 'info');
        } catch (e) {}
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

// 停止指定挂机主号（释放账号去做别的事情）
app.post('/api/farming/stop_leader', (req, res) => {
    const { username, index, mode } = req.body || {};

    if (!processes.farming.process || !processes.farming.process.stdin) {
        return res.status(400).json({ error: '挂机车队未运行' });
    }

    if ((!username || !String(username).trim()) && (index === undefined || index === null || index === '')) {
        return res.status(400).json({ error: '缺少 username 或 index' });
    }

    try {
        const payload = { type: 'stop_leader' };
        if (username) payload.username = String(username).trim();
        if (index !== undefined && index !== null && index !== '') payload.index = index;
        if (mode) payload.mode = mode;

        const command = JSON.stringify(payload) + '\n';
        processes.farming.process.stdin.write(command);
        broadcastLog('System', `已发送停止主号命令: ${payload.username || ('index=' + payload.index)} mode=${payload.mode || 'immediate'}`, 'info');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 启动指定挂机主号（加回流程）
app.post('/api/farming/start_leader', (req, res) => {
    const { username, index } = req.body || {};

    if (!processes.farming.process || !processes.farming.process.stdin) {
        return res.status(400).json({ error: '挂机车队未运行' });
    }

    if ((!username || !String(username).trim()) && (index === undefined || index === null || index === '')) {
        return res.status(400).json({ error: '缺少 username 或 index' });
    }

    try {
        const payload = { type: 'start_leader' };
        if (username) payload.username = String(username).trim();
        if (index !== undefined && index !== null && index !== '') payload.index = index;
        const command = JSON.stringify(payload) + '\n';
        processes.farming.process.stdin.write(command);
        broadcastLog('System', `已发送启动主号命令: ${payload.username || ('index=' + payload.index)}`, 'info');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 设置目标挂机人数（动态调整小号在线/可用人数）
app.post('/api/farming/set_target_followers', async (req, res) => {
    const count = Number(req.body?.count);

    if (!processes.farming.process || !processes.farming.process.stdin) {
        return res.status(400).json({ error: '挂机车队未运行' });
    }
    if (!Number.isFinite(count) || count < 0) {
        return res.status(400).json({ error: '无效的 count（必须是 >=0 的数字）' });
    }

    const timeoutMs = Number(req.body?.timeoutMs || 5000);
    const timeout = Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(timeoutMs, 20000)) : 5000;

    try {
        const data = await new Promise((resolve, reject) => {
            const waiter = {};
            const timer = setTimeout(() => {
                _farmingTargetFollowersWaiters = _farmingTargetFollowersWaiters.filter(w => w !== waiter);
                reject(new Error('timeout'));
            }, timeout);
            waiter.resolve = (d) => { clearTimeout(timer); resolve(d); };
            waiter.reject = (e) => { clearTimeout(timer); reject(e); };
            _farmingTargetFollowersWaiters.push(waiter);
            processes.farming.process.stdin.write(JSON.stringify({ type: 'set_target_followers', count }) + '\n');
        });
        res.json({ success: true, ...data });
    } catch (e) {
        // 超时则回退到最近一次结果（若有）
        if (_lastFarmingTargetFollowersResult) {
            return res.json({ success: true, stale: true, ..._lastFarmingTargetFollowersResult });
        }
        res.status(504).json({ error: '设置目标人数超时' });
    }
});

// ✅ 一体化：设置目标挂机人数（若 farming 未运行则先启动）
// 用于前端“应用=启动”的交互：一次点击即可启动并应用目标人数
app.post('/api/farming/apply_target_followers', async (req, res) => {
    const count = Number(req.body?.count);

    if (!Number.isFinite(count) || count < 0) {
        return res.status(400).json({ error: '无效的 count（必须是 >=0 的数字）' });
    }

    let started = false;
    // 若未运行，先启动 farming
    if (!processes.farming.process) {
        const cmd = 'node';
        const args = ['src/farming.js'];
        const ok = startProcess('farming', cmd, args, PROJECT_ROOT, 'farming');
        if (!ok) {
            return res.status(500).json({ error: '启动挂机车队失败' });
        }
        started = true;
    }

    // 启动后直接发命令（stdin 会缓冲，farming 进程起来后会读取）
    if (!processes.farming.process || !processes.farming.process.stdin) {
        return res.status(400).json({ error: '挂机车队未运行' });
    }

    // ✅ 刚启动 farming 时，初始化/加载配置可能更慢；默认给更长等待时间，减少误报超时
    const timeoutMs = Number(req.body?.timeoutMs || (started ? 20000 : 8000));
    const timeout = Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(timeoutMs, 20000)) : 8000;

    try {
        const data = await new Promise((resolve, reject) => {
            const waiter = {};
            const timer = setTimeout(() => {
                _farmingTargetFollowersWaiters = _farmingTargetFollowersWaiters.filter(w => w !== waiter);
                reject(new Error('timeout'));
            }, timeout);
            waiter.resolve = (d) => { clearTimeout(timer); resolve(d); };
            waiter.reject = (e) => { clearTimeout(timer); reject(e); };
            _farmingTargetFollowersWaiters.push(waiter);
            processes.farming.process.stdin.write(JSON.stringify({ type: 'set_target_followers', count }) + '\n');
        });
        res.json({ success: true, started, ...data });
    } catch (e) {
        if (_lastFarmingTargetFollowersResult) {
            return res.json({ success: true, started, stale: true, ..._lastFarmingTargetFollowersResult });
        }
        // ✅ 若是“启动即应用”场景：即使未等到回包，也很可能命令已写入 stdin 缓冲，稍后会生效。
        // 这里返回 pending=true，避免前端弹窗误导；最终结果会通过 socket.io 的 farmingTargetFollowers 回传。
        if (started) {
            return res.json({ success: true, started, pending: true, requested: count });
        }
        res.status(504).json({ error: '设置目标人数超时', started });
    }
});

// 获取挂机主号状态（会向 farming 进程请求一次，等待 JSON 回传）
app.get('/api/farming/leaders_status', async (req, res) => {
    if (!processes.farming.process || !processes.farming.process.stdin) {
        return res.status(400).json({ error: '挂机车队未运行' });
    }

    const timeoutMs = Number(req.query?.timeoutMs || 5000);
    const timeout = Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(timeoutMs, 20000)) : 5000;

    try {
        const data = await new Promise((resolve, reject) => {
            const waiter = {};
            const timer = setTimeout(() => {
                // 超时：从等待队列移除，避免泄漏
                _farmingLeadersStatusWaiters = _farmingLeadersStatusWaiters.filter(w => w !== waiter);
                reject(new Error('timeout'));
            }, timeout);
            waiter.resolve = (d) => { clearTimeout(timer); resolve(d); };
            waiter.reject = (e) => { clearTimeout(timer); reject(e); };
            _farmingLeadersStatusWaiters.push(waiter);
            // 发送查询命令
            processes.farming.process.stdin.write(JSON.stringify({ type: 'get_leaders_status' }) + '\n');
        });
        res.json({ success: true, data });
    } catch (e) {
        // 超时则回退到“最近一次缓存”（如果有）
        if (_lastFarmingLeadersStatus) {
            return res.json({ success: true, data: _lastFarmingLeadersStatus, stale: true });
        }
        res.status(504).json({ error: '获取主号状态超时' });
    }
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
                
                return { name, followers, inPool: _farmPoolConfigs.has(name) };
            })
            .filter(cfg => cfg.followers > 0); // 只返回有小号的配置
        
        res.json({ configs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 获取当前 Farm 池子配置（用于前端刷新后恢复状态）
app.get('/api/farm/pool', (req, res) => {
    // 如果 farming 在运行：向 farming 查询一次最新 loaded_configs（运行态真实来源）
    if (processes.farming.process && processes.farming.process.stdin) {
        const timeoutMs = Number(req.query?.timeoutMs || 3000);
        const timeout = Number.isFinite(timeoutMs) ? Math.max(500, Math.min(timeoutMs, 20000)) : 3000;
        return (async () => {
            try {
                const data = await new Promise((resolve, reject) => {
                    const waiter = {};
                    const timer = setTimeout(() => {
                        _farmLoadedConfigsWaiters = _farmLoadedConfigsWaiters.filter(w => w !== waiter);
                        reject(new Error('timeout'));
                    }, timeout);
                    waiter.resolve = (d) => { clearTimeout(timer); resolve(d); };
                    waiter.reject = (e) => { clearTimeout(timer); reject(e); };
                    _farmLoadedConfigsWaiters.push(waiter);
                    processes.farming.process.stdin.write(JSON.stringify({ type: 'get_loaded_configs' }) + '\n');
                });
                const set = new Set(['config_000', ...(data || []).map(x => String(x)).filter(Boolean)]);
                _farmPoolConfigs = set;
                return res.json({ success: true, configs: Array.from(_farmPoolConfigs) });
            } catch (e) {
                // 超时则回退到缓存
                if (_lastFarmLoadedConfigs) {
                    const set = new Set(['config_000', ..._lastFarmLoadedConfigs.map(x => String(x)).filter(Boolean)]);
                    _farmPoolConfigs = set;
                    return res.json({ success: true, configs: Array.from(_farmPoolConfigs), stale: true });
                }
                return res.json({ success: true, configs: Array.from(_farmPoolConfigs), stale: true });
            }
        })();
    }
    // farming 未运行：返回默认
    res.json({ success: true, configs: Array.from(_farmPoolConfigs) });
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
        // ✅ 运行态内存：立即更新（farming 进程也会实际加载；前端会再拉一次 /api/farm/pool 校验）
        _farmPoolConfigs.add(String(configName));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 🔴 新增：将配置从小号池子移除（运行时移除：退房→登出→退出池子）
app.post('/api/farm/remove_from_pool', (req, res) => {
    const { configName } = req.body;
    
    if (!configName) {
        return res.status(400).json({ error: '缺少配置名称' });
    }
    
    if (!processes.farming.process || !processes.farming.process.stdin) {
        return res.status(400).json({ error: '挂机车队未运行' });
    }
    
    try {
        const command = JSON.stringify({ type: 'remove_config', configName }) + '\n';
        processes.farming.process.stdin.write(command);
        broadcastLog('System', `已发送移除配置命令: ${configName}`, 'info');
        if (configName !== 'config_000') _farmPoolConfigs.delete(String(configName));
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
        
    } else if (name === 'cleanup_config') {
        // 清理某个 farm 配置的小号（退出房间/登出）
        const configName = body.configName || '';
        if (!configName) {
            return res.status(400).json({ error: '缺少 configName' });
        }
        args = ['commands/cleanup_config.js', configName];
        processes.tool.name = `Cleanup Config: ${configName}`;
        // 归类到挂机日志
        processes.tool.logSource = 'farming';

    } else if (name === 'test_leader') {
        // 测试挂机主号：需要 username, password, gameId，可选 proxy, shared_secret
        const { username, password, proxy, shared_secret, gameId } = body;
        if (!username || !password) {
            return res.status(400).json({ error: '缺少账号或密码' });
        }
        if (!gameId) {
            return res.status(400).json({ error: '请先在上方输入游戏ID' });
        }
        args = ['commands/test_leader.js', username, password];
        // 注意：参数顺序必须是 proxy, shared_secret, gameId
        // 如果没有 proxy 或 shared_secret，用空字符串占位
        args.push(proxy || '');
        args.push(shared_secret || '');
        args.push(gameId);
        processes.tool.name = `Test Leader: ${username}`;
        processes.tool.logSource = 'test_leader';
        processes.tool.gameId = gameId;  // 保存 gameId 用于自动查询
        
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


/**
 * 挂机车队独立程序 v4.0 - 简化版本
 * 
 * 核心逻辑：
 * 1. 从 config_leaders.json 加载主号配置和共享代理池
 * 2. 启动时自动加载 config_000 的小号
 * 3. 支持运行时动态添加其他配置的小号（add_config 命令）
 * 4. 主号和小号统一从共享代理池随机选择代理
 * 
 * 使用方法：
 * node src/farming.js
 */

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

// ============================================
// 项目根目录
// ============================================
const projectRoot = path.join(__dirname, '..');

// ============================================
// 文件日志配置
// ============================================
const LOG_CONFIG = {
    enabled: true,           // 是否启用文件日志
    retainDays: 7,           // 保留天数
    logDir: path.join(projectRoot, 'logs')
};

// 确保日志目录存在
if (LOG_CONFIG.enabled && !fs.existsSync(LOG_CONFIG.logDir)) {
    fs.mkdirSync(LOG_CONFIG.logDir, { recursive: true });
}

// 获取当天日志文件路径
function getLogFilePath() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(LOG_CONFIG.logDir, `farming_${today}.log`);
}

// 写入日志文件
function writeToLogFile(level, category, message) {
    if (!LOG_CONFIG.enabled) return;
    
    try {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${level}] [${category}] ${message}\n`;
        fs.appendFileSync(getLogFilePath(), logLine);
    } catch (err) {
        // 忽略写入错误，避免影响主流程
    }
}

// 清理旧日志文件（启动时调用）
function cleanOldLogs() {
    if (!LOG_CONFIG.enabled) return;
    
    try {
        const files = fs.readdirSync(LOG_CONFIG.logDir);
        const now = Date.now();
        const maxAge = LOG_CONFIG.retainDays * 24 * 60 * 60 * 1000;
        let cleaned = 0;
        
        files.forEach(file => {
            if (!file.startsWith('farming_') || !file.endsWith('.log')) return;
            
            const filePath = path.join(LOG_CONFIG.logDir, file);
            const stat = fs.statSync(filePath);
            
            if (now - stat.mtime.getTime() > maxAge) {
                fs.unlinkSync(filePath);
                cleaned++;
            }
        });
        
        if (cleaned > 0) {
            console.log(`[System] 🧹 已清理 ${cleaned} 个旧日志文件`);
        }
    } catch (err) {
        // 忽略清理错误
    }
}

// 启动时清理旧日志
cleanOldLogs();

// ============================================
// GC 消息 ID 定义
// ============================================
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgGCAbandonCurrentGame = 7035;
const k_EMsgGCPracticeLobbyCreate = 7038;
const k_EMsgGCPracticeLobbyLeave = 7040;
const k_EMsgGCPracticeLobbyJoin = 7044;
const k_EMsgGCPracticeLobbyJoinResponse = 7113;
const k_EMsgGCReadyUp = 7070;
const k_EMsgGCReadyUpStatus = 7170;
const k_EMsgGCPracticeLobbySetTeamSlot = 7047;
const k_EMsgGCJoinableCustomLobbiesRequest = 7468;
const k_EMsgGCJoinableCustomLobbiesResponse = 7469;
const k_EMsgProtoMask = 0x80000000;

// SOCache 消息 ID
const k_EMsgGCSOCacheSubscribed = 24;
const k_EMsgGCSOSingleObject = 25;
const k_EMsgGCSOMultipleObjects = 26;
const SOCACHE_TYPE_LOBBY = 2004;

// DOTAJoinLobbyResult 枚举
const DOTAJoinLobbyResult = {
    DOTA_JOIN_RESULT_SUCCESS: 0,
    DOTA_JOIN_RESULT_ALREADY_IN_GAME: 1,
    DOTA_JOIN_RESULT_INVALID_LOBBY: 2,
    DOTA_JOIN_RESULT_INCORRECT_PASSWORD: 3,
    DOTA_JOIN_RESULT_ACCESS_DENIED: 4,
    DOTA_JOIN_RESULT_GENERIC_ERROR: 5,
    DOTA_JOIN_RESULT_INCORRECT_VERSION: 6,
    DOTA_JOIN_RESULT_IN_TEAM_PARTY: 7,
    DOTA_JOIN_RESULT_NO_LOBBY_FOUND: 8,
    DOTA_JOIN_RESULT_LOBBY_FULL: 9,
    DOTA_JOIN_RESULT_CUSTOM_GAME_INCORRECT_VERSION: 10,
    DOTA_JOIN_RESULT_TIMEOUT: 11,
    DOTA_JOIN_RESULT_CUSTOM_GAME_COOLDOWN: 12,
    DOTA_JOIN_RESULT_BUSY: 13,
    DOTA_JOIN_RESULT_NO_PLAYTIME: 14
};

const JoinResultName = Object.entries(DOTAJoinLobbyResult).reduce((acc, [k, v]) => {
    acc[v] = k.replace('DOTA_JOIN_RESULT_', '');
    return acc;
}, {});

const DOTA_GC_TEAM = {
    DOTA_GC_TEAM_GOOD_GUYS: 0,
    DOTA_GC_TEAM_BAD_GUYS: 1,
    DOTA_GC_TEAM_SPECTATOR: 3,
    DOTA_GC_TEAM_PLAYER_POOL: 4
};

const DOTALobbyReadyState = {
    DOTALobbyReadyState_READY: 2
};

// ============================================
// Proto 定义加载
// ============================================
let CMsgClientHello, CMsgPracticeLobbyJoin, CMsgPracticeLobbyJoinResponse, CMsgPracticeLobbyCreate, 
    CMsgPracticeLobbySetDetails, CMsgPracticeLobbySetTeamSlot, CMsgReadyUp, CSODOTALobby,
    CMsgJoinableCustomLobbiesRequest, CMsgJoinableCustomLobbiesResponse;
let CMsgSOSingleObject, CMsgSOMultipleObjects, CMsgSOCacheSubscribed;

try {
    const root = new protobuf.Root();
    root.resolvePath = function(origin, target) {
        if (fs.existsSync(target)) return target;
        const pathInProtobufs = path.join(projectRoot, "Protobufs", target);
        if (fs.existsSync(pathInProtobufs)) return pathInProtobufs;
        const pathInDota2 = path.join(projectRoot, "Protobufs", "dota2", target);
        if (fs.existsSync(pathInDota2)) return pathInDota2;
        return target;
    };

    root.loadSync(path.join(projectRoot, "Protobufs/google/protobuf/descriptor.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/networkbasetypes.proto")); 
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/network_connection.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/steammessages.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/gcsdk_gcmessages.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_shared_enums.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_client_enums.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/base_gcmessages.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_gcmessages_common_lobby.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_gcmessages_client_match_management.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_gcmessages_client.proto"));

    CMsgClientHello = root.lookupType("CMsgClientHello");
    CMsgPracticeLobbyJoin = root.lookupType("CMsgPracticeLobbyJoin");
    CMsgPracticeLobbyJoinResponse = root.lookupType("CMsgPracticeLobbyJoinResponse");
    CMsgPracticeLobbyCreate = root.lookupType("CMsgPracticeLobbyCreate");
    CMsgPracticeLobbySetDetails = root.lookupType("CMsgPracticeLobbySetDetails");
    CMsgPracticeLobbySetTeamSlot = root.lookupType("CMsgPracticeLobbySetTeamSlot");
    CMsgReadyUp = root.lookupType("CMsgReadyUp");
    CSODOTALobby = root.lookupType("CSODOTALobby");
    CMsgJoinableCustomLobbiesRequest = root.lookupType("CMsgJoinableCustomLobbiesRequest");
    CMsgJoinableCustomLobbiesResponse = root.lookupType("CMsgJoinableCustomLobbiesResponse");
    CMsgSOSingleObject = root.lookupType("CMsgSOSingleObject");
    CMsgSOMultipleObjects = root.lookupType("CMsgSOMultipleObjects");
    CMsgSOCacheSubscribed = root.lookupType("CMsgSOCacheSubscribed");
    
    console.log("[System] ✅ Proto 文件加载成功");
} catch (e) {
    console.error("❌ Proto 加载失败: " + e.message);
    process.exit(1);
}

function getHardwareSpecs() {
    return {
        logical_processors: 8,
        cpu_cycles_per_second: Long.fromNumber(3600000000),
        total_physical_memory: Long.fromNumber(17179869184),
        is_64_bit_os: true,
        upload_measurement: Long.fromNumber(10485760),
        prefer_not_host: false
    };
}

// ============================================
// 日志工具
// ============================================
function formatTime() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function logSection(title) {
    console.log('\n' + '═'.repeat(70));
    console.log(`║ ${title}`);
    console.log('═'.repeat(70));
    writeToLogFile('INFO', 'Section', title);
}

function logInfo(category, message) {
    console.log(`[${formatTime()}] [${category}] ${message}`);
    writeToLogFile('INFO', category, message);
}

function logSuccess(category, message) {
    console.log(`[${formatTime()}] [${category}] ✅ ${message}`);
    writeToLogFile('SUCCESS', category, message);
}

function logWarning(category, message) {
    console.log(`[${formatTime()}] [${category}] ⚠️ ${message}`);
    writeToLogFile('WARNING', category, message);
}

function logError(category, message) {
    console.log(`[${formatTime()}] [${category}] ❌ ${message}`);
    writeToLogFile('ERROR', category, message);
}

// ============================================
// 小号状态枚举
// ============================================
const FollowerState = {
    PENDING: 'PENDING',         // 1. 未创建（等待登录）
    LOGGING_IN: 'LOGGING_IN',   // 1.5 正在登录中
    IDLE: 'IDLE',               // 2. 创建未分配（已登录GC，在池子等待）
    ASSIGNED: 'ASSIGNED',       // 3. 创建已分配（已分配给房间，尝试加入中）
    IN_LOBBY: 'IN_LOBBY'        // 4. 创建进入房间（成功进入房间）
};

// ============================================
// FollowerPool - 小号池子
// ============================================
class FollowerPool {
    constructor(manager) {
        this.manager = manager;
        this.idle = [];          // 空闲小号（已登录GC，等待分配）
        this.assigned = new Map(); // lobbyId -> [小号Bot数组]
        this.waitingLeaders = []; // 等待小号的主号回调队列
        this.loginQueue = [];    // 登录队列（待登录/失败放回的小号）
        this.all = [];           // 所有小号引用
    }

    // 添加小号到池子（状态2：创建未分配）
    addToIdle(follower) {
        if (!this.idle.includes(follower)) {
            this.idle.push(follower);
            follower.state = FollowerState.IDLE;
            // 每50个打印一次，避免日志太多
            if (this.idle.length % 50 === 0) {
                logInfo('Pool', `📥 池子小号: ${this.idle.length} 个`);
            }
            
            // 🔴 新增：如果有主号在等待小号，通知它们
            if (this.waitingLeaders.length > 0) {
                const callback = this.waitingLeaders.shift();
                if (callback) {
                    setImmediate(() => callback());
                }
            }
        }
    }

    // 从池子取出N个小号分配给房间（状态2 → 状态3）
    assignToRoom(lobbyId, count) {
        const toAssign = this.idle.splice(0, Math.min(count, this.idle.length));
        
        if (toAssign.length === 0) {
            return [];
        }

        this.assigned.set(lobbyId.toString(), toAssign);
        
        toAssign.forEach(f => {
            f.state = FollowerState.ASSIGNED;
            f.assignedLobbyId = lobbyId;
        });

        logSuccess('Pool', `📤 分配 ${toAssign.length} 个小号 → 房间 ${lobbyId} (池子剩余: ${this.idle.length})`);
        return toAssign;
    }

    // 小号退出房间，回到池子（状态3/4 → 状态2）
    returnToPool(follower) {
        const prevState = follower.state;
        const prevLobby = follower.currentLobbyId || follower.assignedLobbyId;
        
        // 从已分配列表移除
        if (follower.assignedLobbyId) {
            const lobbyId = follower.assignedLobbyId.toString();
            const assigned = this.assigned.get(lobbyId);
            if (assigned) {
                const idx = assigned.indexOf(follower);
                if (idx >= 0) assigned.splice(idx, 1);
                if (assigned.length === 0) this.assigned.delete(lobbyId);
            }
            follower.assignedLobbyId = null;
        }

        // 回到空闲池
        follower.currentLobbyId = null;
        this.addToIdle(follower);
        
        logSuccess('Pool', `✅ ${follower.account.username} 已回到池子 (原房间: ${prevLobby || '无'})`);
        
        // 🔴 新增：如果有主号在等待小号，通知它们
        if (this.waitingLeaders.length > 0 && this.idle.length > 0) {
            const callback = this.waitingLeaders.shift();
            if (callback) {
                // 延迟执行，避免在同一事件循环中处理
                setImmediate(() => callback());
            }
        }
    }

    // 获取统计信息
    getStats() {
        let inLobbyCount = 0;
        let assignedCount = 0;
        let loggingInCount = 0;
        let pendingCount = 0;
        
        // 统计已分配/已进入的
        this.assigned.forEach(followers => {
            followers.forEach(f => {
                if (f.state === FollowerState.IN_LOBBY) inLobbyCount++;
                else assignedCount++;
            });
        });
        
        // 统计所有小号的状态
        this.all.forEach(f => {
            if (f.state === FollowerState.LOGGING_IN) loggingInCount++;
            else if (f.state === FollowerState.PENDING) pendingCount++;
        });

        return {
            idle: this.idle.length,         // 池子空闲
            assigned: assignedCount,         // 正在加入
            inLobby: inLobbyCount,           // 已进入房间
            loggingIn: loggingInCount,       // 正在登录
            queueLength: this.loginQueue.length, // 登录队列长度
            total: this.all.length           // 总数
        };
    }
}

// ============================================
// FollowerBot - 小号Bot
// ============================================
class FollowerBot {
    constructor(account, settings, manager) {
        this.account = account;
        this.settings = settings;
        this.manager = manager;
        this.pool = manager.pool;
        
        this.state = FollowerState.PENDING;
        this.client = null;
        this.proxy = null;
        this.is_gc_connected = false;
        this.currentLobbyId = null;
        this.assignedLobbyId = null;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.ready_up_heartbeat = null;
        this.loginTimeoutHandle = null;  // 登录超时定时器
        this.joinTimeoutHandle = null;   // 加入房间超时定时器
        this.stopped = false;

        // CRC 数据
        this.knownCrc = "1396649696593898392";
        this.knownTimestamp = 1763646905;
        
        // 超时时间（30秒）
        this.LOGIN_TIMEOUT = 30000;
        this.JOIN_TIMEOUT = 30000;
    }

    // 从共享代理池随机选择代理
    selectRandomProxy() {
        return this.manager.getRandomProxy();
    }

    // 开始登录（状态1 → 登录中）
    start() {
        this.state = FollowerState.LOGGING_IN;
        this.stopped = false;
        this.proxy = this.selectRandomProxy();
        
        const sharedDataPath = this.settings.shared_steam_data_path || "../shared_steam_data";
        const steamDataDir = path.resolve(projectRoot, sharedDataPath);
        
        const steamOptions = { dataDirectory: steamDataDir };
        if (this.proxy) {
            steamOptions.httpProxy = this.proxy;
        }

        this.client = new SteamUser(steamOptions);
        this.setupListeners();
        
        // 设置登录超时（30秒）
        this.loginTimeoutHandle = setTimeout(() => {
            if (this.state === FollowerState.LOGGING_IN && !this.is_gc_connected) {
                const proxyIp = this.proxy?.split('@')[1] || 'no-proxy';
                logWarning('Follower', `⏱️ ${this.account.username} 登录超时(30s) [${proxyIp}] → 放回队列`);
                // 超时，清理并放回队列
                this.cleanup();
                this.state = FollowerState.PENDING;
                this.pool.loginQueue.push(this);
            }
        }, this.LOGIN_TIMEOUT);
        
        const logOnOptions = {
            accountName: this.account.username,
            password: this.account.password,
            promptSteamGuardCode: false,
            rememberPassword: true,
            logonID: Math.floor(Math.random() * 1000000)
        };
        
        if (this.account.shared_secret && this.account.shared_secret.length > 5) {
            try { 
                logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(this.account.shared_secret); 
            } catch (err) {}
        }
        
        this.client.logOn(logOnOptions);
    }
    
    // 清除登录超时定时器
    clearLoginTimeout() {
        if (this.loginTimeoutHandle) {
            clearTimeout(this.loginTimeoutHandle);
            this.loginTimeoutHandle = null;
        }
    }

    setupListeners() {
        // 🔴 Steam Guard 验证回调
        this.client.on('steamGuard', (domain, callback, lastCodeWrong) => {
            if (this.account.shared_secret && this.account.shared_secret.length > 5) {
                const code = SteamTotp.generateAuthCode(this.account.shared_secret);
                callback(code);
            } else {
                // 没有 shared_secret，无法自动验证，放回队列
                this.cleanup();
                this.state = FollowerState.PENDING;
                this.pool.loginQueue.push(this);
            }
        });

        this.client.on('loggedOn', () => {
            if (!this.client) return;  // 🔴 防止超时清理后延迟触发
            this.retryCount = 0;
            this.loggedInElsewhereRetry = 0;  // 登录成功，重置计数器
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
        });

        this.client.on('appLaunched', (appid) => {
            if (!this.client) return;  // 🔴 防止超时清理后延迟触发
            if (appid === this.settings.target_app_id) {
                setTimeout(() => this.connectGC(), 1000);
            }
        });

        this.client.on('error', (err) => {
            this.handleError(err);
        });

        this.client.on('receivedFromGC', (appid, msgType, payload) => {
            this.handleGCMessage(appid, msgType, payload);
        });
    }

    connectGC() {
        if (!this.client) return;  // 🔴 防止超时清理后延迟触发
        this.sendHello();
        const helloInterval = setInterval(() => { 
            if (!this.client) { clearInterval(helloInterval); return; }  // 🔴 client 被清理则停止
            if (!this.is_gc_connected) this.sendHello(); 
            else clearInterval(helloInterval);
        }, 5000);
    }

    sendHello() {
        if (!this.client) return;  // 🔴 防止超时清理后延迟触发
        try {
            const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
            const message = CMsgClientHello.create(payload);
            const buffer = CMsgClientHello.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    handleError(err) {
        const errorMessage = err.message || err.toString();
        
        // LoggedInElsewhere: 账号已在别处登录（可能是之前的请求延迟成功了）
        // 解决：销毁 client，等待 3 秒，然后重新创建并登录，直到成功
        if (errorMessage.includes('LoggedInElsewhere')) {
            this.loggedInElsewhereRetry = (this.loggedInElsewhereRetry || 0) + 1;
            
            // 只在第一次和每 5 次打印日志，避免刷屏
            if (this.loggedInElsewhereRetry === 1 || this.loggedInElsewhereRetry % 5 === 0) {
                logWarning('Follower', `${this.account.username} 账号已在别处登录 → 重建连接 (第${this.loggedInElsewhereRetry}次)`);
            }
            
            // 1. 销毁旧 client
            if (this.client) {
                try { this.client.removeAllListeners(); } catch (e) {}
                this.client = null;
            }
            this.is_gc_connected = false;
            this.state = FollowerState.PENDING;
            
            // 2. 等待 3 秒后重新开始登录（不走失败池，直接重试，直到成功）
            setTimeout(() => {
                if (!this.stopped) {
                    this.start();  // 重新创建 client 并登录
                }
            }, 3000);
            
            return;  // 不放入失败池，直接重试
        }
        
        // 重置 LoggedInElsewhere 计数器（其他错误说明连接状态已改变）
        this.loggedInElsewhereRetry = 0;
        
        // 清除登录超时定时器
        this.clearLoginTimeout();
        
        // 记录代理失败，并打印详细错误信息
        const proxyIp = this.proxy?.split('@')[1] || 'no-proxy';
        const errorCode = err.code || 'NO_CODE';
        const isProxyTimeout = errorMessage.includes('timed out') || errorMessage.includes('ETIMEDOUT');
        const isConnectionError = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(errorCode);
        
        if (this.proxy && isProxyTimeout) {
            this.manager.recordProxyFailure(this.proxy);
        }
        
        // 打印详细错误信息（区分错误类型）
        if (isProxyTimeout) {
            logWarning('Follower', `🔌 ${this.account.username} 代理超时 [${proxyIp}] code=${errorCode} → 放回队列`);
        } else if (isConnectionError) {
            logWarning('Follower', `🔗 ${this.account.username} 连接错误 [${proxyIp}] code=${errorCode} → 放回队列`);
        } else {
            logWarning('Follower', `❌ ${this.account.username} 登录失败 [${proxyIp}] code=${errorCode} msg=${errorMessage} → 放回队列`);
        }
        
        // 失败后：清理并放回登录队列末尾
        this.cleanup();
        this.state = FollowerState.PENDING;
        
        // 放回登录队列末尾，等待下次轮到
        this.pool.loginQueue.push(this);
    }

    handleGCMessage(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!this.is_gc_connected) {
                this.is_gc_connected = true;
                this.clearLoginTimeout();  // 登录成功，清除超时定时器
                
                // 记录代理成功
                if (this.proxy) {
                    this.manager.recordProxySuccess(this.proxy);
                }
                
                // 清理残留状态
                if (this.client) {  // 🔴 防止清理后延迟触发
                    this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                    this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                }
                
                // 登录成功 → 进入池子（状态1→状态2）
                setTimeout(() => {
                    this.pool.addToIdle(this);
                }, 1000);
            }
        }
        else if (cleanMsgType === k_EMsgGCJoinableCustomLobbiesResponse) {
            // 由 manager 统一处理查询结果（仅在结算/工具查询时使用）
            try {
                this.manager.onJoinableCustomLobbiesResponse(this, payload);
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCPracticeLobbyJoinResponse) {
            try {
                const response = CMsgPracticeLobbyJoinResponse.decode(payload);
                if (response.result === DOTAJoinLobbyResult.DOTA_JOIN_RESULT_SUCCESS) {
                    this.onJoinSuccess();
                } else {
                    this.onJoinFailed(JoinResultName[response.result] || response.result);
                }
            } catch(e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOCacheSubscribed) {
            try {
                const msg = CMsgSOCacheSubscribed.decode(payload);
                (msg.objects || []).forEach((typeObj) => {
                    if (typeObj.typeId === SOCACHE_TYPE_LOBBY) {
                        (typeObj.objectData || []).forEach((data) => {
                            this.processLobbyData(data);
                        });
                    }
                });
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOSingleObject) {
            try {
                const msg = CMsgSOSingleObject.decode(payload);
                if (msg.typeId === SOCACHE_TYPE_LOBBY) {
                    this.processLobbyData(msg.objectData);
                }
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOMultipleObjects) {
            try {
                const msg = CMsgSOMultipleObjects.decode(payload);
                [...(msg.objectsModified || []), ...(msg.objectsAdded || [])].forEach((obj) => {
                    if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                        this.processLobbyData(obj.objectData);
                    }
                });
                // 检查是否有对象被删除（房间解散）
                if (msg.objectsRemoved && msg.objectsRemoved.length > 0) {
                    msg.objectsRemoved.forEach(obj => {
                        if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                            this.onLobbyRemoved();
                        }
                    });
                }
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCReadyUpStatus) {
            setTimeout(() => this.sendReadyUp(), 200);
        }
    }

    processLobbyData(objectData) {
        if (!objectData || objectData.length === 0) {
            // 不仅检查 IN_LOBBY，也检查 ASSIGNED（加入过程中房间解散）
            if (this.state === FollowerState.IN_LOBBY || this.state === FollowerState.ASSIGNED) {
                this.onLobbyRemoved();
            }
            return;
        }
        
        try {
            const lobby = CSODOTALobby.decode(objectData);
            if (lobby.lobbyId) {
                this.currentLobbyId = lobby.lobbyId;
                if (this.state === FollowerState.ASSIGNED) {
                    this.onJoinSuccess();
                }
            }
        } catch (e) {}
    }

    // 尝试加入分配的房间
    joinAssignedLobby() {
        if (this.stopped) return; // 已停止，不再操作
        if (!this.assignedLobbyId || this.state !== FollowerState.ASSIGNED) return;
        
        // 设置加入房间超时（30秒）
        this.clearJoinTimeout();
        this.joinTimeoutHandle = setTimeout(() => {
            if (this.state === FollowerState.ASSIGNED) {
                // 超时，回到池子
                const proxyIp = this.proxy?.split('@')[1] || 'no-proxy';
                logWarning('Follower', `⏱️ ${this.account.username} 加入房间超时(30s) [${proxyIp}] lobbyId=${this.assignedLobbyId} → 回到池子`);
                this.pool.returnToPool(this);
            }
        }, this.JOIN_TIMEOUT);
        
        try {
            let lobbyIdLong = this.assignedLobbyId;
            if (typeof this.assignedLobbyId === 'string') {
                lobbyIdLong = Long.fromString(this.assignedLobbyId, true);
            }

            const payload = {
                lobbyId: lobbyIdLong,
                customGameCrc: Long.fromString(this.knownCrc, true),
                customGameTimestamp: this.knownTimestamp,
                passKey: this.settings.lobby_password
            };
            
            const message = CMsgPracticeLobbyJoin.create(payload);
            const buffer = CMsgPracticeLobbyJoin.encode(message).finish();
            if (this.client) {  // 🔴 防止清理后延迟触发
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyJoin | k_EMsgProtoMask, {}, buffer);
            }
        } catch (err) {}
    }
    
    // 清除加入房间超时定时器
    clearJoinTimeout() {
        if (this.joinTimeoutHandle) {
            clearTimeout(this.joinTimeoutHandle);
            this.joinTimeoutHandle = null;
        }
    }

    onJoinSuccess() {
        // 清除加入超时定时器
        this.clearJoinTimeout();
        
        // 加入成功（状态3 → 状态4）
        const prevState = this.state;
        this.state = FollowerState.IN_LOBBY;
        this.retryCount = 0;
        
        if (prevState === FollowerState.ASSIGNED) {
            logSuccess('Follower', `${this.account.username} 进入房间 ${this.assignedLobbyId}`);
        }
        
        // 设置队伍
        setTimeout(() => {
            if (!this.client) return;  // 🔴 防止清理后延迟触发
            const teamMsg = CMsgPracticeLobbySetTeamSlot.create({ team: DOTA_GC_TEAM.DOTA_GC_TEAM_GOOD_GUYS, slot: 0 });
            const teamBuf = CMsgPracticeLobbySetTeamSlot.encode(teamMsg).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbySetTeamSlot | k_EMsgProtoMask, {}, teamBuf);
            setTimeout(() => this.sendReadyUp(), 500);
        }, 500);

        // 心跳
        if (this.ready_up_heartbeat) clearInterval(this.ready_up_heartbeat);
        this.ready_up_heartbeat = setInterval(() => this.sendReadyUp(), 30000);
    }

    onJoinFailed(reason) {
        // 清除加入超时定时器
        this.clearJoinTimeout();
        
        // 房间不存在或已满 → 只有这种情况才回到池子
        if (reason === 'NO_LOBBY_FOUND' || reason === 'INVALID_LOBBY') {
            logWarning('Follower', `${this.account.username} 加入失败: ${reason}（房间已解散）→ 回到池子`);
            this.pool.returnToPool(this);
            return;
        }
        
        if (reason === 'LOBBY_FULL') {
            logWarning('Follower', `${this.account.username} 加入失败: ${reason}（房间已满）→ 回到池子`);
            this.pool.returnToPool(this);
            return;
        }

        // 其他错误（网络问题等）→ 换IP继续尝试加入同一个房间
        this.retryCount++;
        logWarning('Follower', `${this.account.username} 加入失败: ${reason} → 换IP重试 (${this.retryCount})`);
        // 断开重连换IP，继续尝试加入同一个房间
        this.reconnectWithNewProxy();
    }

    reconnectWithNewProxy() {
        // 保留 assignedLobbyId，重连后继续加入同一个房间
        const savedLobbyId = this.assignedLobbyId;
        const savedState = this.state;
        
        this.cleanupForReconnect(); // 只断开连接，不清除分配信息
        this.proxy = this.selectRandomProxy();
        
        // 恢复分配信息
        this.assignedLobbyId = savedLobbyId;
        this.state = FollowerState.ASSIGNED; // 保持状态3
        
        setTimeout(() => this.startForReconnect(), 2000);
    }
    
    // 重连专用清理（不清除分配信息）
    cleanupForReconnect() {
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        this.is_gc_connected = false;
        
        try {
            if (this.client) {
                this.client.logOff();
            }
        } catch (err) {}
    }
    
    // 重连专用启动（GC连接后直接尝试加入房间）
    startForReconnect() {
        this.proxy = this.selectRandomProxy();
        
        const sharedDataPath = this.settings.shared_steam_data_path || "../shared_steam_data";
        const steamDataDir = path.resolve(projectRoot, sharedDataPath);
        
        const steamOptions = { dataDirectory: steamDataDir };
        if (this.proxy) {
            steamOptions.httpProxy = this.proxy;
        }

        this.client = new SteamUser(steamOptions);
        this.setupReconnectListeners(); // 使用重连专用监听器
        
        const logOnOptions = {
            accountName: this.account.username,
            password: this.account.password,
            promptSteamGuardCode: false,
            rememberPassword: true,
            logonID: Math.floor(Math.random() * 1000000)
        };
        
        if (this.account.shared_secret && this.account.shared_secret.length > 5) {
            try { 
                logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(this.account.shared_secret); 
            } catch (err) {}
        }
        
        this.client.logOn(logOnOptions);
    }
    
    // 重连专用监听器（GC连接后直接加入房间，不进池子）
    setupReconnectListeners() {
        this.client.on('loggedOn', () => {
            if (!this.client) return;  // 🔴 防止清理后延迟触发
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
        });

        this.client.on('appLaunched', (appid) => {
            if (!this.client) return;  // 🔴 防止清理后延迟触发
            if (appid === this.settings.target_app_id) {
                setTimeout(() => this.connectGCForReconnect(), 1000);
            }
        });

        this.client.on('error', (err) => {
            // 重连失败，继续重试
            const proxyIp = this.proxy?.split('@')[1] || 'no-proxy';
            const errorCode = err.code || 'NO_CODE';
            const errorMessage = err.message || String(err);
            logWarning('Follower', `🔄 ${this.account.username} 重连失败 [${proxyIp}] code=${errorCode} msg=${errorMessage} → 继续重试`);
            this.cleanupForReconnect();
            setTimeout(() => this.startForReconnect(), 3000);
        });

        this.client.on('receivedFromGC', (appid, msgType, payload) => {
            this.handleGCMessageForReconnect(appid, msgType, payload);
        });
    }
    
    connectGCForReconnect() {
        if (!this.client) return;  // 🔴 防止清理后延迟触发
        this.sendHello();
        const helloInterval = setInterval(() => { 
            if (!this.client) { clearInterval(helloInterval); return; }  // 🔴 client 被清理则停止
            if (!this.is_gc_connected) this.sendHello(); 
            else clearInterval(helloInterval);
        }, 5000);
    }
    
    handleGCMessageForReconnect(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!this.is_gc_connected) {
                this.is_gc_connected = true;
                // 清理残留状态
                if (this.client) {  // 🔴 防止清理后延迟触发
                    this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                    this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                }
                
                // 直接尝试加入分配的房间（不进池子）
                setTimeout(() => {
                    if (this.assignedLobbyId) {
                        this.joinAssignedLobby();
                    }
                }, 1000);
            }
        }
        // 复用其他消息处理
        else {
            this.handleGCMessage(appid, msgType, payload);
        }
    }

    onLobbyRemoved() {
        // 房间解散 → 回到池子（IN_LOBBY 或 ASSIGNED 状态）
        const lobbyId = this.currentLobbyId?.toString() || this.assignedLobbyId?.toString() || 'unknown';
        logInfo('Follower', `${this.account.username} 收到房间解散通知 (房间: ${lobbyId}, 状态: ${this.state})`);
        
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        
        // 清除加入超时（如果是 ASSIGNED 状态正在加入）
        this.clearJoinTimeout();
        
        this.pool.returnToPool(this);
    }
    
    // 主动退出房间（用于展示车队轮换时解散）
    leaveLobbyForDissolve() {
        if (this.state !== FollowerState.IN_LOBBY) {
            logWarning('Follower', `${this.account.username} 不在房间中，无需退出`);
            return;
        }
        
        const lobbyId = this.currentLobbyId?.toString() || 'unknown';
        logInfo('Follower', `${this.account.username} 主动退出房间 ${lobbyId}...`);
        
        try {
            // 发送退出房间消息
            if (this.client) {  // 🔴 防止清理后延迟触发
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
            }
        } catch (err) {
            logWarning('Follower', `${this.account.username} 发送退出消息失败: ${err.message}`);
        }
        
        // 兜底机制：5秒后检查是否还在房间内，如果GC没通知则手动回池
        setTimeout(() => {
            if (this.state === FollowerState.IN_LOBBY && this.currentLobbyId?.toString() === lobbyId) {
                logWarning('Follower', `${this.account.username} 未收到GC通知，手动回池`);
                this.onLobbyRemoved();
            }
        }, 5000);
    }

    sendReadyUp() {
        if (!this.client) return;  // 🔴 防止清理后延迟触发
        try {
            const payload = {
                state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                hardware_specs: getHardwareSpecs()
            };
            if (this.currentLobbyId) payload.ready_up_key = this.currentLobbyId;
            const message = CMsgReadyUp.create(payload);
            const buffer = CMsgReadyUp.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    cleanup() {
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        
        // 清除超时定时器
        this.clearLoginTimeout();
        this.clearJoinTimeout();
        
        // 标记为已停止，阻止后续操作
        this.stopped = true;
        this.is_gc_connected = false;
        
        // 保存客户端引用，用于延迟清理
        const clientToClean = this.client;
        
        try {
            if (clientToClean) {
                clientToClean.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                clientToClean.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                
                // 延迟清理，确保消息发送出去
                setTimeout(() => {
                    try { 
                        clientToClean.logOff(); 
                    } catch (e) {}
                    
                    // 彻底清理客户端，释放资源
                    setTimeout(() => {
                        try {
                            clientToClean.removeAllListeners();
                        } catch (e) {}
                    }, 500);
                }, 500);
            }
        } catch (err) {}
        
        // 立即清空引用，防止重复使用
        this.client = null;
        
        // 释放代理统计
        if (this.proxy && this.manager) {
            this.manager.releaseProxy(this.proxy);
        }
    }
}

// ============================================
// LeaderBot - 主号Bot
// ============================================
class LeaderBot {
    constructor(account, settings, manager) {
        this.account = account;
        this.settings = settings;
        this.manager = manager;
        this.pool = manager.pool;
        
        this.client = null;
        this.proxy = null;
        this.is_gc_connected = false;
        this.currentLobbyId = null;
        this.lastLeftLobbyId = null; // 上一个离开的房间ID，用于忽略旧房间的更新
        this.currentRoomMemberCount = 0;
        this.roomsCreated = 0;
        this.seedingThreshold = settings.seeding_threshold || 5;
        this.ready_up_heartbeat = null;
        this.state = 'OFFLINE';
        this.leaveScheduled = false; // 是否已安排离开
        this.stopped = false;

        // 🔴 IP 轮换相关
        this.proxyIndex = 0;
        this.roomsPerProxy = settings.leader_proxy_rotate_rooms || 100;
        this.roomsSinceLastRotate = 0;
        this.isReconnecting = false; // 🔴 防止重复重连

        // CRC 数据
        this.knownCrc = "1396649696593898392";
        this.knownTimestamp = 1763646905;
    }

    log(msg) {
        console.log(`[${formatTime()}] [挂机主号|${this.account.username}] ${msg}`);
    }

    // 🔴 获取主号专用代理（轮换选择）
    selectLeaderProxy() {
        return this.manager.getLeaderProxy(this.proxyIndex);
    }

    // 🔴 检查是否需要换 IP
    shouldRotateProxy() {
        return this.roomsSinceLastRotate >= this.roomsPerProxy;
    }

    // 🔴 轮换 IP（需要重新登录）
    rotateProxyAndRestart() {
        this.log(`🔄 创建了 ${this.roomsSinceLastRotate} 个房间，换 IP 重新登录...`);
        this.proxyIndex++;
        
        // 🔴 当 proxyIndex 超过主号专用代理数量时，重置为 0，循环使用
        const leaderProxyCount = this.manager.leaderProxies?.length || 10;
        if (this.proxyIndex >= leaderProxyCount) {
            this.proxyIndex = 0;
            this.log(`🔁 已用完 ${leaderProxyCount} 个专用代理，从头开始循环`);
        }
        
        this.roomsSinceLastRotate = 0;
        
        // 清理当前连接
        this.cleanup();
        
        // 5 秒后用新 IP 重新登录
        setTimeout(() => this.start(), 5000);
    }

    start() {
        this.stopped = false;  // 🔴 重置停止标志，允许后续操作
        this.state = 'LOGGING_IN';
        this.proxy = this.selectLeaderProxy();  // 🔴 使用主号专用代理
        
        const proxyNum = this.proxyIndex + 1;
        const totalProxies = this.manager.leaderProxies.length;
        this.log(`🔐 开始登录... (专用IP #${proxyNum}/${totalProxies}, 已创建${this.roomsSinceLastRotate}/${this.roomsPerProxy}房间)`);
        if (this.proxy) {
            this.log(`   代理: ${this.proxy.replace(/:[^:@]+@/, ':***@')}`);
        }
        
        const sharedDataPath = this.settings.shared_steam_data_path || "../shared_steam_data";
        const steamDataDir = path.resolve(projectRoot, sharedDataPath);
        
        const steamOptions = { dataDirectory: steamDataDir };
        if (this.proxy) {
            steamOptions.httpProxy = this.proxy;
        }

        this.client = new SteamUser(steamOptions);
        this.setupListeners();
        
        const logOnOptions = {
            accountName: this.account.username,
            password: this.account.password,
            promptSteamGuardCode: false,
            rememberPassword: true,
            logonID: Math.floor(Math.random() * 1000000)
        };
        
        if (this.account.shared_secret && this.account.shared_secret.length > 5) {
            try { 
                logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(this.account.shared_secret); 
            } catch (err) {}
        }
        
        this.client.logOn(logOnOptions);
    }

    setupListeners() {
        // 🔴 Steam Guard 验证回调（换 IP 时可能触发）
        this.client.on('steamGuard', (domain, callback, lastCodeWrong) => {
            if (this.account.shared_secret && this.account.shared_secret.length > 5) {
                const code = SteamTotp.generateAuthCode(this.account.shared_secret);
                this.log(`🔐 Steam Guard 验证${lastCodeWrong ? '(重试)' : ''}，自动提供代码...`);
                callback(code);
            } else {
                this.log(`❌ Steam Guard 需要验证码但未配置 shared_secret`);
            }
        });

        this.client.on('loggedOn', () => {
            this.log('✅ Steam 登录成功');
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
        });

        this.client.on('appLaunched', (appid) => {
            if (appid === this.settings.target_app_id) {
                this.log('🎮 Dota 2 启动');
                setTimeout(() => this.connectGC(), 2000);
            }
        });

        // 🔴 新增：监听断开连接事件
        this.client.on('disconnected', (eresult, msg) => {
            this.log(`⚠️ Steam 断开连接: ${msg || eresult}`);
            this.handleDisconnect('disconnected');
        });

        // 🔴 新增：监听登出事件
        this.client.on('loggedOff', (eresult, msg) => {
            this.log(`⚠️ Steam 登出: ${msg || eresult}`);
            this.handleDisconnect('loggedOff');
        });

        this.client.on('error', (err) => {
            this.log(`❌ Steam 错误: ${err.message}`);
            this.handleDisconnect('error');
        });

        this.client.on('receivedFromGC', (appid, msgType, payload) => {
            this.handleGCMessage(appid, msgType, payload);
        });
    }

    // 🔴 新增：统一处理断开连接
    handleDisconnect(reason) {
        // 🔴 防止重复触发（error 和 disconnected 可能同时触发）
        if (this.isReconnecting) {
            return;
        }
        this.isReconnecting = true;

        this.log(`🔄 因 ${reason} 断开，5秒后重连...`);
        this.is_gc_connected = false;
        this.state = 'DISCONNECTED'; // 🔴 重置状态，防止旧超时检测干扰
        this.cleanup();
        
        setTimeout(() => {
            this.isReconnecting = false; // 🔴 重置标志
            if (!this.stopped) {
                this.start();
            }
        }, 5000);
    }

    connectGC() {
        if (!this.client) return;  // 🔴 防止清理后延迟触发
        this.log('📡 连接 GC...');
        this.sendHello();
        const helloInterval = setInterval(() => { 
            if (!this.client) { clearInterval(helloInterval); return; }  // 🔴 client 被清理则停止
            if (!this.is_gc_connected) this.sendHello(); 
            else clearInterval(helloInterval);
        }, 5000);
    }

    sendHello() {
        if (!this.client) return;  // 🔴 防止清理后延迟触发
        try {
            const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
            const message = CMsgClientHello.create(payload);
            const buffer = CMsgClientHello.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    handleGCMessage(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!this.is_gc_connected) {
                this.is_gc_connected = true;
                this.log('✅ GC 连接成功');
                // 清理残留
                if (this.client) {  // 🔴 防止清理后延迟触发
                    this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                }
                setTimeout(() => this.createRoom(), 1000);
            }
        }
        else if (cleanMsgType === k_EMsgGCJoinableCustomLobbiesResponse) {
            // 由 manager 统一处理查询结果（仅在结算/工具查询时使用）
            try {
                this.manager.onJoinableCustomLobbiesResponse(this, payload);
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOCacheSubscribed) {
            try {
                const msg = CMsgSOCacheSubscribed.decode(payload);
                (msg.objects || []).forEach((typeObj) => {
                    if (typeObj.typeId === SOCACHE_TYPE_LOBBY) {
                        (typeObj.objectData || []).forEach((data) => {
                            this.processLobbyData(data);
                        });
                    }
                });
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOSingleObject) {
            try {
                const msg = CMsgSOSingleObject.decode(payload);
                if (msg.typeId === SOCACHE_TYPE_LOBBY) {
                    this.processLobbyData(msg.objectData);
                }
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOMultipleObjects) {
            try {
                const msg = CMsgSOMultipleObjects.decode(payload);
                [...(msg.objectsModified || []), ...(msg.objectsAdded || [])].forEach((obj) => {
                    if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                        this.processLobbyData(obj.objectData);
                    }
                });
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCReadyUpStatus) {
            setTimeout(() => this.sendReadyUp(), 200);
        }
    }

    processLobbyData(objectData) {
        if (!objectData || objectData.length === 0) return;
        
        try {
            const lobby = CSODOTALobby.decode(objectData);
            const lobbyId = lobby.lobbyId;
            const memberCount = (lobby.allMembers || []).length;
            
            if (lobbyId) {
                // 忽略已离开房间的更新（防止把旧房间当成新房间）
                if (this.lastLeftLobbyId && lobbyId.toString() === this.lastLeftLobbyId.toString()) {
                    return;
                }
                
                // 首次收到房间信息 - 房间创建成功
                if (!this.currentLobbyId && this.state === 'CREATING') {
                    this.currentLobbyId = lobbyId;
                    this.currentRoomMemberCount = memberCount;
                    this.state = 'SEEDING';
                    logSuccess('主号', `房间 #${this.roomsCreated} 创建成功: ${lobbyId.toString()}`);
                    
                    // 从池子分配小号给这个房间
                    this.assignFollowersToRoom(lobbyId);
                }
                
                // 只处理当前房间的更新
                if (this.currentLobbyId && lobbyId.toString() === this.currentLobbyId.toString()) {
                    // 更新房间人数
                    this.currentRoomMemberCount = memberCount;
                    
                    // 人数达标立即离开创建新房间
                    if (this.state === 'SEEDING' && memberCount >= this.seedingThreshold) {
                        this.leaveAndCreateNew();
                    }
                }
            }
        } catch (e) {}
    }

    createRoom(isRetry = false) {
        if (this.stopped) return; // 已停止，不再操作
        
        // 🔴 检查是否需要换 IP（非重试时）
        if (!isRetry && this.shouldRotateProxy()) {
            this.rotateProxyAndRestart();
            return;
        }
        
        // 只有非重试时才增加序号
        if (!isRetry) {
            this.roomsCreated++;
            this.roomsSinceLastRotate++;  // 🔴 增加轮换计数
        }
        
        this.state = 'CREATING';
        this.currentLobbyId = null; // 重置
        // 注意：不清除 lastLeftLobbyId，保留它用于过滤旧房间的延迟消息
        this.leaveScheduled = false; // 重置离开标记
        
        const currentRoomNum = this.roomsCreated; // 记录当前房间号用于超时检测
        this.log(`🏭 创建房间 #${this.roomsCreated}${isRetry ? ' (重试)' : ''} (IP轮换: ${this.roomsSinceLastRotate}/${this.roomsPerProxy})...`);
        
        try {
            const gameIdLong = Long.fromString(this.settings.custom_game_id, true);
            const regions = this.settings.server_regions || [19];
            const selectedRegion = regions[Math.floor(Math.random() * regions.length)];
            
            const detailsPayload = {
                customGameId: gameIdLong,        
                gameName: "",
                serverRegion: selectedRegion, 
                gameMode: 15,                    
                customMaxPlayers: (this.settings.max_players_per_room || 24) - 1, // 最多 max-1 人，防止满员解散
                customMinPlayers: 1,
                allowSpectating: true,
                allchat: true,
                fillWithBots: false,
                allowCheats: false,
                visibility: 0,
                passKey: this.settings.lobby_password,
                customMapName: "zudui_team_map",
                customGameCrc: Long.fromString(this.knownCrc, true),
                customGameTimestamp: this.knownTimestamp
            };
            const lobbyDetails = CMsgPracticeLobbySetDetails.create(detailsPayload);

            const createPayload = {
                searchKey: "",
                passKey: this.settings.lobby_password,
                clientVersion: 0,
                lobbyDetails: lobbyDetails
            };

            const message = CMsgPracticeLobbyCreate.create(createPayload);
            const buffer = CMsgPracticeLobbyCreate.encode(message).finish();
            
            if (!this.client) return;  // 🔴 防止清理后延迟触发
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
            
            // 激活心跳
            let heartbeats = 0;
            const activationInterval = setInterval(() => {
                if (this.state === 'CREATING' || this.state === 'SEEDING') {
                    this.sendReadyUp();
                    heartbeats++;
                    if (heartbeats >= 5) clearInterval(activationInterval);
                } else {
                    clearInterval(activationInterval);
                }
            }, 1000);

            // 创建超时重试（只有当前房间号没变且还在创建状态时才重试）
            setTimeout(() => {
                if (this.state === 'CREATING' && !this.currentLobbyId && this.roomsCreated === currentRoomNum) {
                    const proxyIp = this.proxy?.split('@')[1] || 'no-proxy';
                    this.log(`⚠️ 房间创建超时(30s) | state=${this.state} | gc=${this.is_gc_connected} | proxy=${proxyIp} | room=#${currentRoomNum} → 重试...`);
                    this.createRoom(true); // 标记为重试，不增加序号
                }
            }, 30000); // 30秒超时

        } catch (err) {
            this.log(`❌ 创建房间失败: ${err.message}，3秒后重试`);
            setTimeout(() => this.createRoom(true), 3000);
        }
    }

    assignFollowersToRoom(lobbyId) {
        if (this.stopped) return; // 已停止，不再操作
        
        // 从池子取 (max_players - 2) 个小号
        // max_players_per_room - 1 = 房间实际最大人数（防止满员解散）
        // 再 -1 = 主号占1个位置
        const maxFollowers = (this.settings.max_players_per_room || 24) - 2;
        const followers = this.pool.assignToRoom(lobbyId, maxFollowers);
        
        if (followers.length === 0) {
            this.log(`⏳ 池子为空，等待小号回池后自动分配...`);
            
            // 🔴 修复：注册回调，当小号回到池子时立即触发
            this.pool.waitingLeaders.push(() => {
                if (this.currentLobbyId && this.state === 'SEEDING' && !this.stopped) {
                    this.assignFollowersToRoom(lobbyId);
                }
            });
            
            // 备用：60秒超时保底（防止回调丢失）
            setTimeout(() => {
                if (this.currentLobbyId && this.state === 'SEEDING' && !this.stopped && this.pool.idle.length > 0) {
                    this.assignFollowersToRoom(lobbyId);
                }
            }, 60000);
            return;
        }

        // 打印分配信息（包括是否不足）
        if (followers.length < maxFollowers) {
            logInfo('主号', `🚀 分配 ${followers.length}/${maxFollowers} 个小号 → 房间 #${this.roomsCreated} (池子不足)`);
        } else {
            logInfo('主号', `🚀 分配 ${followers.length} 个小号 → 房间 #${this.roomsCreated}`);
        }
        
        // 一批启动加入（间隔100ms）
        let joinedCount = 0;
        followers.forEach((follower, idx) => {
            setTimeout(() => {
                if (follower.state === FollowerState.ASSIGNED && follower.is_gc_connected) {
                    follower.joinAssignedLobby();
                    joinedCount++;
                } else if (follower.state === FollowerState.ASSIGNED && !follower.is_gc_connected) {
                    // GC未连接，等待连接后自动加入
                    // 在 setupListeners 中已处理
                }
            }, idx * 100);
        });
    }

    leaveAndCreateNew() {
        if (this.stopped) return; // 已停止，不再操作
        
        this.log(`🚪 离开房间 #${this.roomsCreated}，准备创建新房间...`);
        this.leaveLobby();
        setTimeout(() => {
            if (this.state !== 'ABANDONED' && !this.stopped) {
                this.createRoom(false); // 新房间，增加序号
            }
        }, 1000);
    }

    leaveLobby() {
        try {
            if (this.client) {  // 🔴 防止清理后延迟触发
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
            }
        } catch (err) {}
        
        // 记录离开的房间ID，用于忽略后续的旧房间更新
        this.lastLeftLobbyId = this.currentLobbyId;
        this.currentLobbyId = null;
        this.state = 'ONLINE';
        
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
    }

    sendReadyUp() {
        if (!this.client) return;  // 🔴 防止清理后延迟触发
        try {
            const payload = {
                state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                hardware_specs: getHardwareSpecs()
            };
            if (this.currentLobbyId) payload.ready_up_key = this.currentLobbyId;
            const message = CMsgReadyUp.create(payload);
            const buffer = CMsgReadyUp.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    cleanup() {
        if (this.ready_up_heartbeat) clearInterval(this.ready_up_heartbeat);
        
        // 标记为已停止，阻止后续操作
        this.stopped = true;
        this.is_gc_connected = false;
        
        // 保存客户端引用，用于延迟清理
        const clientToClean = this.client;
        
        try {
            if (clientToClean) {
                clientToClean.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                clientToClean.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                
                // 延迟清理，确保消息发送出去
                setTimeout(() => {
                    try { 
                        clientToClean.logOff(); 
                    } catch (e) {}
                    
                    // 彻底清理客户端，释放资源
                    setTimeout(() => {
                        try {
                            clientToClean.removeAllListeners();
                        } catch (e) {}
                    }, 500);
                }, 500);
            }
        } catch (err) {}
        
        // 立即清空引用，防止重复使用
        this.client = null;
    }
}

// ============================================
// FarmingManager - 挂机车队管理器 v4.0 (简化版本)
// ============================================
class FarmingManager {
    constructor(leadersConfig) {
        this.settings = leadersConfig.global_settings;
        this.leadersConfig = leadersConfig.leaders || [];
        this.proxies = leadersConfig.proxies || [];  // 全部代理池
        
        // 🔴 分离主号专用 IP 池
        const leaderProxyCount = this.settings.leader_proxy_count || 10;
        this.leaderProxies = this.proxies.slice(0, leaderProxyCount);  // 前 N 个给主号
        this.followerProxies = this.proxies.slice(leaderProxyCount);   // 剩余给小号
        
        // 已加载的配置（防止重复加载）
        this.loadedConfigs = new Set();
        
        // 时间统计
        this.startTime = null;
        
        // Bot管理
        this.pool = new FollowerPool(this);
        this.leaders = [];
        this.allFollowers = [];  // 所有小号
        
        // 登录参数 - 流水线模式
        this.loginInterval = 100;      // 每个小号间隔100ms
        this.loginPipelineTimer = null; // 登录流水线定时器
        
        // 代理使用统计
        this.proxyStats = new Map();  // proxy -> { used, success, failed, activeConnections }

        // 结算/查询：JoinableCustomLobbies 请求（并发安全：队列 + 单飞行请求）
        this._lobbyQueryCallbacks = [];
        this._lobbyQueryInFlight = false;
        this._lobbyQueryTimeoutHandle = null;
        this._lobbyQueryFinish = null;
        this._lobbyQuerySender = null;
    }

    // 获取随机代理（带统计）- 小号专用
    getRandomProxy() {
        if (!this.followerProxies || this.followerProxies.length === 0) return null;
        const proxy = this.followerProxies[Math.floor(Math.random() * this.followerProxies.length)];
        
        // 初始化统计
        if (!this.proxyStats.has(proxy)) {
            this.proxyStats.set(proxy, { used: 0, success: 0, failed: 0, activeConnections: 0 });
        }
        const stats = this.proxyStats.get(proxy);
        stats.used++;
        stats.activeConnections++;
        
        return proxy;
    }
    
    // 🔴 新增：获取主号专用代理（轮换选择）
    getLeaderProxy(index) {
        if (!this.leaderProxies || this.leaderProxies.length === 0) return null;
        const proxy = this.leaderProxies[index % this.leaderProxies.length];
        
        // 初始化统计
        if (!this.proxyStats.has(proxy)) {
            this.proxyStats.set(proxy, { used: 0, success: 0, failed: 0, activeConnections: 0 });
        }
        const stats = this.proxyStats.get(proxy);
        stats.used++;
        stats.activeConnections++;
        
        return proxy;
    }
    
    // 记录代理成功
    recordProxySuccess(proxy) {
        if (!proxy) return;
        const stats = this.proxyStats.get(proxy);
        if (stats) {
            stats.success++;
        }
    }
    
    // 记录代理失败
    recordProxyFailure(proxy) {
        if (!proxy) return;
        const stats = this.proxyStats.get(proxy);
        if (stats) {
            stats.failed++;
            stats.activeConnections = Math.max(0, stats.activeConnections - 1);
        }
    }
    
    // 记录代理释放（账号断开）
    releaseProxy(proxy) {
        if (!proxy) return;
        const stats = this.proxyStats.get(proxy);
        if (stats) {
            stats.activeConnections = Math.max(0, stats.activeConnections - 1);
        }
    }
    
    // 打印代理统计（详细版）
    printProxyStats() {
        if (this.proxyStats.size === 0) return;
        
        // 计算总计
        let totalUsed = 0, totalSuccess = 0, totalFailed = 0, totalActive = 0;
        let usedProxyCount = 0;
        
        for (const [proxy, stats] of this.proxyStats) {
            totalUsed += stats.used;
            totalSuccess += stats.success;
            totalFailed += stats.failed;
            totalActive += stats.activeConnections;
            if (stats.used > 0) usedProxyCount++;
        }
        
        const overallFailRate = totalUsed > 0 ? (totalFailed / totalUsed * 100).toFixed(1) : '0';
        
        logInfo('ProxyStats', `使用代理: ${usedProxyCount}/${this.proxies.length}个 | 总请求: ${totalUsed} | 成功: ${totalSuccess} | 失败: ${totalFailed} (${overallFailRate}%) | 活跃连接: ${totalActive}`);
    }

    start() {
        this.startTime = Date.now();
        
        logSection('Dota2 挂机车队 v4.0 (简化版本)');
        logInfo('System', `游戏ID: ${this.settings.custom_game_id}`);
        logInfo('System', `房间密码: ${this.settings.lobby_password}`);
        logInfo('System', `Seeding阈值: ${this.settings.seeding_threshold || 5} 人`);
        logInfo('System', `每房间最大人数: ${this.settings.max_players_per_room || 24} 人`);
        logInfo('System', `主号数量: ${this.leadersConfig.length} 个`);
        logInfo('System', `代理总数: ${this.proxies.length} 个`);
        logInfo('System', `  ├─ 主号专用: ${this.leaderProxies.length} 个 (每 ${this.settings.leader_proxy_rotate_rooms || 100} 房间轮换)`);
        logInfo('System', `  └─ 小号共享: ${this.followerProxies.length} 个`);
        
        // 创建主号Bot
        this.leadersConfig.forEach((leaderAccount, idx) => {
            const leaderBot = new LeaderBot(leaderAccount, this.settings, this);
            leaderBot.leaderIndex = idx;
            this.leaders.push(leaderBot);
            logInfo('Leaders', `主号 ${idx + 1}: ${leaderAccount.username}`);
        });
        
        // 启动主号
        this.leaders.forEach(leader => leader.start());
        
        // 自动加载 config_000
        this.addConfig('config_000');
        
        // 启动登录流水线
        this.startLoginPipeline();
    }

    // 添加配置的小号到池子（支持运行时动态添加）
    addConfig(configName) {
        // 检查是否已加载
        if (this.loadedConfigs.has(configName)) {
            logWarning('Farming', `⚠️ ${configName} 已经加载过`);
            return { success: false, reason: 'already_loaded' };
        }
        
        // 读取配置
        const configDir = path.join(projectRoot, 'config', 'farm', configName);
        const followersPath = path.join(configDir, 'followers.txt');
        
        if (!fs.existsSync(followersPath)) {
            logError('Farming', `❌ 配置不存在: ${configName}`);
            return { success: false, reason: 'not_found' };
        }
        
        try {
            const content = fs.readFileSync(followersPath, 'utf8').replace(/^\uFEFF/, '');
            const followers = content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && line.includes(','))
                .map(line => {
                    const [username, password] = line.split(',');
                    return { username: username.trim(), password: password.trim() };
                });
            
            if (followers.length === 0) {
                logWarning('Farming', `⚠️ ${configName} 没有有效的小号`);
                return { success: false, reason: 'empty' };
            }
            
            logSection(`加载配置: ${configName}`);
            logInfo(configName, `📦 加载 ${followers.length} 个小号到登录队列`);
            
            // 创建 FollowerBot 并加入登录队列
            followers.forEach((acc, idx) => {
                const bot = new FollowerBot(acc, this.settings, this);
                this.allFollowers.push(bot);
                this.pool.all.push(bot);
                this.pool.loginQueue.push(bot);  // 加入登录队列
            });
            
            logSuccess(configName, `${followers.length} 个小号已加入登录队列`);
            
            // 标记为已加载
            this.loadedConfigs.add(configName);
            
            return { success: true, count: followers.length };
            
        } catch (e) {
            logError('Farming', `❌ 加载配置失败: ${configName} - ${e.message}`);
            return { success: false, reason: e.message };
        }
    }

    // 登录流水线：智能控制登录速度
    startLoginPipeline() {
        // 🔴 动态计算控制参数（基于主号数量）
        const leaderCount = this.leaders.length || 1;
        const MAX_POOL_IDLE = leaderCount * 100;      // 每个主号配 100 个池子空闲上限
        const MAX_LOGGING_IN = leaderCount * 50;      // 每个主号配 50 个同时登录上限
        const SLOW_INTERVAL = 1000;     // 暂缓时的检查间隔（1秒）
        const NORMAL_INTERVAL = this.loginInterval; // 正常间隔（100ms）
        
        const processNext = () => {
            const poolStats = this.pool.getStats();
            
            // 控制1：池子空闲小号足够，暂缓登录
            if (poolStats.idle >= MAX_POOL_IDLE) {
                // 池子够用，不急着登录，1秒后再检查
                this.loginPipelineTimer = setTimeout(processNext, SLOW_INTERVAL);
                return;
            }
            
            // 控制2：正在登录的太多，等一等
            if (poolStats.loggingIn >= MAX_LOGGING_IN) {
                // 正在登录的已经够多了，500ms后再检查
                this.loginPipelineTimer = setTimeout(processNext, 500);
                return;
            }
            
            // 正常取账号登录
            if (this.pool.loginQueue.length > 0) {
                const bot = this.pool.loginQueue.shift();
                
                // 只处理 PENDING 状态的小号
                if (bot.state === FollowerState.PENDING) {
                    bot.start();
                } else {
                    // 不是 PENDING 状态的跳过
                }
            }
            
            // 继续调度下一个
            this.loginPipelineTimer = setTimeout(processNext, NORMAL_INTERVAL);
        };
        
        // 启动流水线
        processNext();
        logInfo('Farming', `🚀 登录流水线已启动 (主号${leaderCount}个: 池子>${MAX_POOL_IDLE}暂缓, 登录中>${MAX_LOGGING_IN}等待)`);
    }

    getStats() {
        const poolStats = this.pool.getStats();
        let leadersActive = 0;
        let leadersTotal = this.leaders.length;
        let roomsCreated = 0;

        this.leaders.forEach(leader => {
            if (leader.state === 'SEEDING' || leader.currentLobbyId) leadersActive++;
            roomsCreated += leader.roomsCreated || 0;
        });

        const totalElapsed = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;

        return {
            // 小号状态（详细）
            total: poolStats.total,             // 总数
            inLobby: poolStats.inLobby,         // 已进入房间
            assigned: poolStats.assigned,       // 正在加入
            poolIdle: poolStats.idle,           // 池子空闲
            loggingIn: poolStats.loggingIn,     // 正在登录
            queueLength: poolStats.queueLength, // 登录队列长度
            
            // 主号状态
            leadersActive,
            leadersTotal,
            roomsCreated,
            
            // 配置状态
            loadedConfigs: Array.from(this.loadedConfigs),
            
            // 时间
            totalElapsed
        };
    }

    // GC 回调：JoinableCustomLobbiesResponse（由 Follower/Leader 转发）
    onJoinableCustomLobbiesResponse(senderBot, payload) {
        if (!this._lobbyQueryFinish) return;
        if (this._lobbyQuerySender && senderBot !== this._lobbyQuerySender) return;

        try {
            const response = CMsgJoinableCustomLobbiesResponse.decode(payload);
            const lobbies = response.lobbies || [];
            this._lobbyQueryFinish(lobbies, { ok: true });
        } catch (e) {
            this._lobbyQueryFinish([], { ok: false, reason: 'decode_error' });
        }
    }

    // 查询 joinable lobby 列表（用于选择“可解散”的房间）
    queryLobbyListDetailed() {
        return new Promise((resolve) => {
            // 选择一个可用的 GC 连接（优先主号，其次任意在线小号）
            const sender =
                this.leaders.find(b => b && b.is_gc_connected && b.client) ||
                this.allFollowers.find(b => b && b.is_gc_connected && b.client);

            if (!sender) {
                resolve({ lobbies: [], ok: false, meta: { reason: 'no_gc_sender' } });
                return;
            }

            this._lobbyQueryCallbacks.push(resolve);

            // 已有请求在飞，直接排队等待同一结果
            if (this._lobbyQueryInFlight) return;
            this._lobbyQueryInFlight = true;
            this._lobbyQuerySender = sender;

            const timeoutMs = this.settings.lobby_query_timeout_ms || 20000;
            let finished = false;

            const finish = (lobbies, meta) => {
                if (finished) return;
                finished = true;

                this._lobbyQueryInFlight = false;
                this._lobbyQuerySender = null;
                this._lobbyQueryFinish = null;

                if (this._lobbyQueryTimeoutHandle) {
                    clearTimeout(this._lobbyQueryTimeoutHandle);
                    this._lobbyQueryTimeoutHandle = null;
                }

                const callbacks = this._lobbyQueryCallbacks;
                this._lobbyQueryCallbacks = [];

                callbacks.forEach((cb) => {
                    try { cb({ lobbies, ok: !!meta?.ok, meta }); } catch (e) {}
                });
            };

            this._lobbyQueryFinish = finish;

            try {
                const payload = {
                    server_region: 0,
                    custom_game_id: Long.fromString(this.settings.custom_game_id, true)
                };
                const message = CMsgJoinableCustomLobbiesRequest.create(payload);
                const buffer = CMsgJoinableCustomLobbiesRequest.encode(message).finish();
                sender.client.sendToGC(this.settings.target_app_id, k_EMsgGCJoinableCustomLobbiesRequest | k_EMsgProtoMask, {}, buffer);
            } catch (err) {
                finish([], { ok: false, reason: 'send_error' });
                return;
            }

            this._lobbyQueryTimeoutHandle = setTimeout(() => {
                finish([], { ok: false, reason: 'timeout' });
            }, timeoutMs);
        });
    }

    // 自动结算：选择“可解散且无陌生人”的房间并解散（默认 1 个）
    async settleRooms(count = 1, excludeRoomIds = []) {
        const need = Math.max(1, Number(count) || 1);
        const excludeSet = new Set((excludeRoomIds || []).map(x => x?.toString()).filter(Boolean));

        logSection('自动结算房间');
        logInfo('System', `请求结算: ${need} 个 | 排除: ${excludeSet.size} 个房间`);

        const { lobbies, ok, meta } = await this.queryLobbyListDetailed();
        if (!ok || !lobbies || lobbies.length === 0) {
            logWarning('System', `结算跳过：查询无效/空列表 (reason=${meta?.reason || 'unknown'})`);
            return;
        }

        // 统计我方“已在房间内”的小号分布（只有 IN_LOBBY 才能保证可退出）
        const inLobbyCountByRoom = {};
        this.allFollowers.forEach(f => {
            const lobbyId = f.currentLobbyId?.toString();
            if (!lobbyId) return;
            if (f.state !== FollowerState.IN_LOBBY) return;
            inLobbyCountByRoom[lobbyId] = (inLobbyCountByRoom[lobbyId] || 0) + 1;
        });

        const targetGameId = this.settings.custom_game_id;

        // 候选规则（安全优先）：
        // - 必须是本游戏
        // - 必须是带密码房（我方房间必带密码）
        // - 必须能证明“房间内全部成员都是我方可控小号”：memberCount === 我方 IN_LOBBY 小号数
        //   （这样清空后房间会真正消失，不会出现“别人的房间/有陌生人”导致解散无效）
        const candidates = lobbies
            .filter(l => l.customGameId?.toString() === targetGameId)
            .filter(l => l.hasPassKey === true)
            .filter(l => !excludeSet.has(l.lobbyId?.toString()))
            .map(l => {
                const id = l.lobbyId?.toString();
                const ourInLobby = id ? (inLobbyCountByRoom[id] || 0) : 0;
                return {
                    lobbyId: id,
                    memberCount: l.memberCount || 0,
                    ourInLobby,
                    createdAt: l.lobbyCreationTime || 0
                };
            })
            .filter(x => x.lobbyId && x.ourInLobby > 0 && x.memberCount === x.ourInLobby)
            .sort((a, b) => a.createdAt - b.createdAt); // 在“可解散”前提下优先最老

        if (candidates.length === 0) {
            logWarning('System', `结算失败：未找到“可解散且无陌生人”的房间（安全跳过，不误解散）`);
            return;
        }

        const chosen = candidates.slice(0, need);
        logInfo('System', `已选择 ${chosen.length}/${need} 个可解散房间：`);
        chosen.forEach((x, idx) => {
            logInfo('System', `   ${idx + 1}. ${x.lobbyId} | member=${x.memberCount} | our=${x.ourInLobby}`);
        });

        this.dissolveRooms(chosen.map(x => x.lobbyId));
    }

    // 解散指定房间（让在这些房间中的小号退出）
    dissolveRooms(roomIds) {
        if (!roomIds || roomIds.length === 0) {
            logWarning('System', '解散房间: 没有收到有效的房间ID');
            return;
        }
        
        const roomIdSet = new Set(roomIds.map(id => id.toString()));
        let matchedCount = 0;
        
        // 统计当前小号在各房间的分布
        const roomStats = {};
        this.allFollowers.forEach(follower => {
            const lobbyId = follower.currentLobbyId?.toString();
            if (lobbyId) {
                roomStats[lobbyId] = (roomStats[lobbyId] || 0) + 1;
            }
        });
        
        logInfo('System', `当前小号房间分布: ${Object.keys(roomStats).length} 个房间`);
        
        // 检查每个要解散的房间
        roomIds.forEach(roomId => {
            const idStr = roomId.toString();
            const count = roomStats[idStr] || 0;
            logInfo('System', `   房间 ${idStr}: ${count} 个小号 ${count > 0 ? '→ 匹配!' : '→ 无小号'}`);
        });
        
        // 遍历所有小号，检查是否在要解散的房间中
        this.allFollowers.forEach(follower => {
            const followerLobbyId = follower.currentLobbyId?.toString();
            
            if (followerLobbyId && roomIdSet.has(followerLobbyId)) {
                matchedCount++;
                logInfo('Follower', `${follower.account.username} 在房间 ${followerLobbyId} 中，执行退出...`);
                
                // 让小号主动退出房间
                follower.leaveLobbyForDissolve();
            }
        });
        
        logSuccess('System', `解散房间执行完成: 共 ${matchedCount} 个小号被要求退出`);
    }
    
    cleanup() {
        logInfo('Farming', '🧹 清理资源...');
        
        // 停止登录流水线
        if (this.loginPipelineTimer) clearTimeout(this.loginPipelineTimer);
        
        this.leaders.forEach(bot => bot.cleanup());
        this.allFollowers.forEach(bot => bot.cleanup());
        
        logSuccess('Farming', '挂机车队已停止');
    }
}

// ============================================
// Main Entry
// ============================================
const args = process.argv.slice(2);
const isDebugMode = args.includes('debug');

// 加载主号配置 (config_leaders.json)
const leadersConfigPath = path.join(projectRoot, 'config', 'config_leaders.json');
let leadersConfig;
try {
    const rawContent = fs.readFileSync(leadersConfigPath, 'utf8').replace(/^\uFEFF/, '');
    leadersConfig = JSON.parse(rawContent);
    logInfo('System', `📄 主号配置: ${leadersConfigPath}`);
    logInfo('System', `   主号数量: ${(leadersConfig.leaders || []).length} 个`);
    logInfo('System', `   代理数量: ${(leadersConfig.proxies || []).length} 个`);
} catch (e) {
    logError('System', `读取主号配置失败: ${e.message}`);
    process.exit(1);
}

leadersConfig.global_settings.debug_mode = isDebugMode;

// 确保共享验证数据目录存在
const sharedDataPath = leadersConfig.global_settings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);
if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}

// 验证主号配置
if (!leadersConfig.leaders || leadersConfig.leaders.length === 0) {
    logError('System', '没有配置任何主号！请检查 config_leaders.json');
    process.exit(1);
}

// 验证代理配置
if (!leadersConfig.proxies || leadersConfig.proxies.length === 0) {
    logWarning('System', '⚠️ 没有配置代理！主号和小号将不使用代理');
}

// 检查 config_000 是否存在
const config000Path = path.join(projectRoot, 'config', 'farm', 'config_000', 'followers.txt');
if (!fs.existsSync(config000Path)) {
    logError('System', '默认配置 config_000 不存在！请创建 config/farm/config_000/followers.txt');
    process.exit(1);
}

// 创建并启动管理器
const manager = new FarmingManager(leadersConfig);
manager.start();

// 状态监控（每2分钟输出一次）
setInterval(() => {
    const stats = manager.getStats();
    const percentage = stats.total > 0 ? Math.round((stats.inLobby / stats.total) * 100) : 0;
    const totalElapsedMin = Math.floor(stats.totalElapsed / 60);
    const totalElapsedSec = stats.totalElapsed % 60;
    
    // 详细统计格式 (流水线模式：队列替代失败)
    logInfo('Stats', `总:${stats.total} ✅入:${stats.inLobby} ⏳加:${stats.assigned} 💤池:${stats.poolIdle} 🔄登:${stats.loggingIn} 📋队列:${stats.queueLength} | 🚪房:${stats.roomsCreated} 👑主:${stats.leadersActive}/${stats.leadersTotal} | ⏱️${totalElapsedMin}分${totalElapsedSec}秒 (${percentage}%)`);
    
    // 打印代理使用统计
    manager.printProxyStats();
}, 120000);

// 异常处理
process.on('uncaughtException', (err) => {
    if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(err.code)) return;
    logError('System', `未捕获的异常: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
    if (reason?.code && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(reason.code)) return;
    logError('System', `未处理的Promise拒绝: ${reason}`);
});

process.on('SIGINT', () => {
    logSection('程序退出');
    manager.cleanup();
    setTimeout(() => {
        logSuccess('System', '程序已安全退出');
        process.exit(0);
    }, 3000);
});

// 监听 stdin 的命令（用于 Web 控制台）
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
    const input = data.toString().trim();
    
    // 尝试解析 JSON 命令
    try {
        const cmd = JSON.parse(input);
        
        // 解散房间命令
        if (cmd.type === 'dissolve_rooms' && cmd.roomIds) {
            logSection('收到解散房间命令');
            logInfo('System', `需要解散的房间: ${cmd.roomIds.length} 个`);
            cmd.roomIds.forEach((id, idx) => {
                logInfo('System', `   ${idx + 1}. LobbyId: ${id}`);
            });
            manager.dissolveRooms(cmd.roomIds);
            return;
        }

        // 自动结算命令（由挂机车队选择“可解散且无陌生人”的房间）
        if (cmd.type === 'settle_rooms') {
            const count = Number(cmd.count || 1);
            const excludeRoomIds = Array.isArray(cmd.excludeRoomIds) ? cmd.excludeRoomIds : [];
            logSection('收到自动结算命令');
            logInfo('System', `请求结算: count=${count} exclude=${excludeRoomIds.length}`);
            manager.settleRooms(count, excludeRoomIds);
            return;
        }
        
        // 添加配置到池子命令
        if (cmd.type === 'add_config' && cmd.configName) {
            logSection('收到添加配置命令');
            logInfo('System', `配置名称: ${cmd.configName}`);
            const result = manager.addConfig(cmd.configName);
            console.log(JSON.stringify({ type: 'add_config_result', ...result }));
            return;
        }
        
        // 获取状态命令
        if (cmd.type === 'get_stats') {
            const stats = manager.getStats();
            console.log(JSON.stringify({ type: 'stats', data: stats }));
            return;
        }
    } catch (e) {
        // 不是 JSON，检查是否是退出命令
    }
    
    // 普通退出命令
    const cmdLower = input.toLowerCase();
    if (cmdLower === 'exit' || cmdLower === 'stop' || cmdLower === 'quit') {
        logSection('收到退出命令');
        manager.cleanup();
        setTimeout(() => {
            logSuccess('System', '程序已安全退出');
            process.exit(0);
        }, 3000);
    }
});


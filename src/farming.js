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

    // 有小号回池/入池时，尽量唤醒更多等待的主号（避免“池子来了一堆人但只唤醒1个主号”）
    _notifyWaitingLeaders() {
        if (this.waitingLeaders.length === 0) return;
        if (this.idle.length === 0) return;
        // ⚠️ 注意：callback 在 setImmediate 才会执行，此处 idle.length 不会立刻减少。
        // 因此需要用“唤醒次数预算”来避免一次性把 waitingLeaders 全部 shift 掉。
        let wakes = Math.min(this.waitingLeaders.length, this.idle.length);
        while (wakes > 0 && this.waitingLeaders.length > 0) {
            const callback = this.waitingLeaders.shift();
            if (callback) {
                setImmediate(() => {
                    try { callback(); } catch (e) {}
                });
            }
            wakes--;
        }
    }

    // 添加小号到池子（状态2：创建未分配）
    addToIdle(follower) {
        // 🔴 新增：配置移除中/已移除的小号，禁止回池（不影响旧逻辑）
        if (follower && follower.removing) {
            try {
                this.manager?.finalizeFollowerRemoval?.(follower, { from: 'pool.addToIdle' });
            } catch (e) {}
            return;
        }

        // ✅ 小号统一重试策略：若处于 nextRetryAt 冷却期，不进入 idle 池，直接回到登录队列等待到点再试
        // 目的：避免“加入失败/超时后立即回池又被马上分配”，导致持续抖动刷重试
        if (follower && follower.nextRetryAt && Date.now() < follower.nextRetryAt) {
            follower.state = FollowerState.PENDING;
            if (!this.loginQueue.includes(follower)) {
                this.loginQueue.push(follower);
            }
            return;
        }
        if (!this.idle.includes(follower)) {
            this.idle.push(follower);
            follower.state = FollowerState.IDLE;
            // 每50个打印一次，避免日志太多
            if (this.idle.length % 50 === 0) {
                logInfo('Pool', `📥 池子小号: ${this.idle.length} 个`);
            }
            
            // 如果有主号在等待小号，尽量唤醒它们
            this._notifyWaitingLeaders();
        }
    }

    // 从池子取出N个小号分配给房间（状态2 → 状态3）
    assignToRoom(lobbyId, count) {
        const toAssign = this.idle.splice(0, Math.min(count, this.idle.length));
        
        if (toAssign.length === 0) {
            return [];
        }

        // ⚠️ 关键：对同一 lobbyId 支持“追加分配”，用于池子回补后补齐缺口
        const lobbyKey = lobbyId.toString();
        const existing = this.assigned.get(lobbyKey) || [];
        existing.push(...toAssign);
        this.assigned.set(lobbyKey, existing);
        
        toAssign.forEach(f => {
            f.state = FollowerState.ASSIGNED;
            f.assignedLobbyId = lobbyId;
            // ✅ 记录分配时间，用于后续清理“僵尸分配”（大量代理异常时很关键）
            f.assignedAt = Date.now();
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
        // ✅ 清理分配时间戳
        follower.assignedAt = 0;

        // 回到空闲池
        follower.currentLobbyId = null;
        // 🔴 新增：配置移除中/已移除的小号，禁止回池（不影响旧逻辑）
        if (follower && follower.removing) {
            try {
                this.manager?.finalizeFollowerRemoval?.(follower, { from: 'pool.returnToPool' });
            } catch (e) {}
            return;
        }
        this.addToIdle(follower);
        
        logSuccess('Pool', `✅ ${follower.account.username} 已回到池子 (原房间: ${prevLobby || '无'})`);
    }

    // 强制将小号置为 PENDING（不进入 idle 池），用于“缩容/目标人数下降”
    // 说明：调用方通常会先 bot.cleanup()，这里负责把它从 pool 的各种结构里摘除并可选入队。
    forceToPending(follower, options = {}) {
        const { enqueue = true } = options;
        if (!follower) return;

        try {
            // 1) 从 idle 池移除
            if (Array.isArray(this.idle) && this.idle.length > 0) {
                if (this.idle.includes(follower)) {
                    this.idle = this.idle.filter(x => x !== follower);
                }
            }

            // 2) 从 assigned 映射移除（可能挂在多个 key 的脏引用，直接全表过滤一次）
            if (this.assigned && typeof this.assigned.forEach === 'function') {
                const toDelete = [];
                this.assigned.forEach((arr, lobbyId) => {
                    if (!Array.isArray(arr) || arr.length === 0) return;
                    const next = arr.filter(x => x !== follower);
                    if (next.length === 0) toDelete.push(lobbyId);
                    else if (next.length !== arr.length) this.assigned.set(lobbyId, next);
                });
                toDelete.forEach(id => this.assigned.delete(id));
            }

            // 3) 清空占位字段
            follower.currentLobbyId = null;
            follower.assignedLobbyId = null;
            follower.assignedAt = 0;

            // 4) 状态改为 PENDING，并可选入队（去重）
            follower.state = FollowerState.PENDING;
            if (enqueue && Array.isArray(this.loginQueue)) {
                if (!this.loginQueue.includes(follower)) {
                    this.loginQueue.push(follower);
                }
            }
        } catch (e) {}
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

        // 🔴 新增：归属配置 + 移除标记（默认不启用，不影响旧逻辑）
        this.configName = null;
        this.removing = false;
        this._finalizedRemoval = false;
        
        this.state = FollowerState.PENDING;
        this.client = null;
        this.proxy = null;
        this.is_gc_connected = false;
        this.currentLobbyId = null;
        this.assignedLobbyId = null;
        this.assignedAt = 0; // ✅ 分配时间戳（用于清理“僵尸分配”）
        this.ready_up_heartbeat = null;
        this.loginTimeoutHandle = null;  // 登录超时定时器
        this.joinTimeoutHandle = null;   // 加入房间超时定时器
        this.stopped = false;
        // 永久失败（例如 InvalidPassword）：只记录一次并从系统中剔除
        this.permanentFailed = false;
        this._invalidPasswordNotified = false;
        
        // ✅ 小号统一重试策略：除 InvalidPassword 外，任何失败都在 10 分钟后再重试（无限重试）
        this.FOLLOWER_RETRY_DELAY_MS = 10 * 60 * 1000;
        this.nextRetryAt = 0; // 下次允许重试的时间戳(ms)，到点前跳过

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
        // 冷却期间不允许启动（由登录流水线跳过；这里再兜底一次）
        if (this.nextRetryAt && Date.now() < this.nextRetryAt) {
            this.state = FollowerState.PENDING;
            if (!this.pool.loginQueue.includes(this)) {
                this.pool.loginQueue.push(this);
            }
            return;
        }
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
                this.nextRetryAt = Date.now() + this.FOLLOWER_RETRY_DELAY_MS;
                logWarning('Follower', `⏱️ ${this.account.username} 登录超时(30s) [${proxyIp}] → ${Math.ceil(this.FOLLOWER_RETRY_DELAY_MS / 60000)}分钟后重试`);
                this.cleanup();
                this.state = FollowerState.PENDING;
                if (!this.pool.loginQueue.includes(this)) {
                    this.pool.loginQueue.push(this);
                }
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
                this.nextRetryAt = Date.now() + this.FOLLOWER_RETRY_DELAY_MS;
                this.cleanup();
                this.state = FollowerState.PENDING;
                if (!this.pool.loginQueue.includes(this)) {
                    this.pool.loginQueue.push(this);
                }
            }
        });

        this.client.on('loggedOn', () => {
            if (!this.client) return;  // 🔴 防止超时清理后延迟触发
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
        const prevState = this.state;
        const wasIdle = Array.isArray(this.pool?.idle) && this.pool.idle.includes(this);
        const shouldReleaseAssignment = !!this.assignedLobbyId || prevState === FollowerState.ASSIGNED || prevState === FollowerState.IN_LOBBY;
        
        // LoggedInElsewhere: 账号已在别处登录（可能是之前的请求延迟成功了）
        if (errorMessage.includes('LoggedInElsewhere') || errorMessage.includes('AlreadyLoggedInElsewhere')) {
            const proxyIp = this.proxy?.split('@')[1] || 'no-proxy';

            this.nextRetryAt = Date.now() + this.FOLLOWER_RETRY_DELAY_MS;
            logWarning('Follower', `🚪 ${this.account.username} 账号已在别处登录 [${proxyIp}] → ${Math.ceil(this.FOLLOWER_RETRY_DELAY_MS / 60000)}分钟后重试`);
            this.cleanup();

            // ✅ 若正在加入/已在房间：直接回池释放分配（避免长期占用 ASSIGNED/房间缺人）
            if (shouldReleaseAssignment) {
                this.pool.returnToPool(this);
            } else {
                // ✅ 若在 idle 池：先从 idle 移除再入队，避免“既在池子又在队列”
                if (wasIdle) {
                    this.pool.idle = this.pool.idle.filter(x => x !== this);
                }
                this.state = FollowerState.PENDING;
                if (!this.pool.loginQueue.includes(this)) {
                    this.pool.loginQueue.push(this);
                }
            }
            
            return;
        }
        
        // 清除登录超时定时器
        this.clearLoginTimeout();

        // ✅ 只处理：InvalidPassword 一次性清出系统（不再回队列、不占用登录并发）
        // 说明：截图里 msg=InvalidPassword（err.code 可能为 NO_CODE），因此以 message 为主判断
        if (/InvalidPassword/i.test(errorMessage)) {
            const proxyIp = this.proxy?.split('@')[1] || 'no-proxy';
            if (!this._invalidPasswordNotified) {
                this._invalidPasswordNotified = true;
                logWarning('Follower', `🛑 ${this.account.username} 密码错误(InvalidPassword) [${proxyIp}] → 永久剔除，不再重试`);
            }
            this.permanentFailed = true;
            // 先清理网络连接/资源（会停止后续行为）
            this.cleanup();
            // 再从池子/队列/统计引用中摘除（避免继续占用并发/刷屏）
            try {
                this.manager?.finalizeFollowerRemoval?.(this, { from: 'follower.invalid_password' });
            } catch (e) {}
            return;
        }

        // 记录代理失败，并打印详细错误信息
        const proxyIp = this.proxy?.split('@')[1] || 'no-proxy';
        const errorCode = err.code || 'NO_CODE';
        const isProxyTimeout = errorMessage.includes('timed out') || errorMessage.includes('ETIMEDOUT') || errorMessage.includes('Proxy connection timed out');
        const isConnectionError = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(errorCode);
        const is429 = errorMessage.includes('429') || errorMessage.includes('RateLimitExceeded') || errorMessage.includes('Too Many Requests');

        // ✅ 统一：除 InvalidPassword 外，任何错误都 10 分钟后再重试（无限重试）
        this.nextRetryAt = Date.now() + this.FOLLOWER_RETRY_DELAY_MS;
        
        if (this.proxy && isProxyTimeout) {
            this.manager.recordProxyFailure(this.proxy);
        }
        
        // 打印详细错误信息（区分错误类型）
        if (isProxyTimeout) {
            logWarning('Follower', `🔌 ${this.account.username} 代理超时 [${proxyIp}] code=${errorCode} → ${Math.ceil(this.FOLLOWER_RETRY_DELAY_MS / 60000)}分钟后重试`);
        } else if (is429) {
            logWarning('Follower', `🚦 ${this.account.username} 限流429 [${proxyIp}] code=${errorCode} → ${Math.ceil(this.FOLLOWER_RETRY_DELAY_MS / 60000)}分钟后重试`);
        } else if (isConnectionError) {
            logWarning('Follower', `🔗 ${this.account.username} 连接错误 [${proxyIp}] code=${errorCode} → ${Math.ceil(this.FOLLOWER_RETRY_DELAY_MS / 60000)}分钟后重试`);
        } else {
            logWarning('Follower', `❌ ${this.account.username} 登录失败 [${proxyIp}] code=${errorCode} msg=${errorMessage} → ${Math.ceil(this.FOLLOWER_RETRY_DELAY_MS / 60000)}分钟后重试`);
        }
        
        // 失败后：清理并放回登录队列末尾
        this.cleanup();

        // ✅ 若正在加入/已在房间：直接回池释放分配（避免长期占用 ASSIGNED/房间缺人）
        if (shouldReleaseAssignment) {
            this.pool.returnToPool(this);
            return;
        }

        // ✅ 若在 idle 池：先从 idle 移除再入队，避免“既在池子又在队列”
        if (wasIdle) {
            this.pool.idle = this.pool.idle.filter(x => x !== this);
        }

        this.state = FollowerState.PENDING;
        // 放回登录队列末尾，等待下次轮到
        if (!this.pool.loginQueue.includes(this)) {
            this.pool.loginQueue.push(this);
        }
    }

    handleGCMessage(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!this.is_gc_connected) {
                this.is_gc_connected = true;
                this.clearLoginTimeout();  // 登录成功，清除超时定时器
                // ✅ 登录成功：清空下次重试限制
                this.nextRetryAt = 0;
                
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
                this.nextRetryAt = Date.now() + this.FOLLOWER_RETRY_DELAY_MS;
                logWarning('Follower', `⏱️ ${this.account.username} 加入房间超时(30s) [${proxyIp}] lobbyId=${this.assignedLobbyId} → ${Math.ceil(this.FOLLOWER_RETRY_DELAY_MS / 60000)}分钟后重试`);
                // 断开本次连接，避免残留
                try { this.cleanup(); } catch (e) {}
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
        
        if (prevState === FollowerState.ASSIGNED) {
            logSuccess('Follower', `${this.account.username} 进入房间 ${this.assignedLobbyId}`);
        }

        // ✅ 加入成功：清除分配时间戳
        this.assignedAt = 0;
        
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

        // 其他错误（网络/限流/临时不可用等）→ 直接回池 + 冷却10分钟
        const proxyIp = this.proxy?.split('@')[1] || 'no-proxy';
        this.nextRetryAt = Date.now() + this.FOLLOWER_RETRY_DELAY_MS;
        logWarning('Follower', `${this.account.username} 加入失败: ${reason} [${proxyIp}] → 回到池子，${Math.ceil(this.FOLLOWER_RETRY_DELAY_MS / 60000)}分钟后重试`);
        try { this.cleanup(); } catch (e) {}
        this.pool.returnToPool(this);
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

        // 🔴 新增：如果该小号正在被移除，则不回池，只做“摘除引用”
        if (this.removing) {
            try {
                this.manager?.finalizeFollowerRemoval?.(this, { from: 'follower.onLobbyRemoved' });
            } catch (e) {}
            return;
        }
        
        this.pool.returnToPool(this);
    }
    
    // 主动退出房间（用于展示车队轮换时解散）
    leaveLobbyForDissolve() {
        // ✅ 不再依赖 state（state 可能因延迟/丢消息不同步），只要 currentLobbyId 命中就退出
        const lobbyId = this.currentLobbyId?.toString();
        if (!lobbyId) {
            logWarning('Follower', `${this.account.username} 不在房间中，无需退出`);
            return;
        }
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
            if (this.currentLobbyId?.toString() === lobbyId) {
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

        // 固定人数补齐（稳定策略）：
        // - 每个房间预分配固定数量小号：max_players_per_room - 2
        // - 若池子不足导致未分满，则登记等待；当小号回池后自动补齐缺口到固定人数
        this._fillWaitLobbyId = null;
        this._fillWaitPending = false;

        // 🔴 IP 轮换相关
        this.proxyIndex = 0;
        // 🔴 根据主号数量动态计算每个主号的房间阈值
        // leader_proxy_rotate_rooms 表示"总房间数阈值"，所有主号合计达到该数后集体换 IP
        const leaderCount = manager.leadersConfig?.length || 1;
        const totalRoomsThreshold = settings.leader_proxy_rotate_rooms || 100;
        this.roomsPerProxy = Math.max(1, Math.floor(totalRoomsThreshold / leaderCount));
        this.roomsSinceLastRotate = 0;
        this.isReconnecting = false; // 🔴 防止重复重连

        // CRC 数据
        this.knownCrc = "1396649696593898392";
        this.knownTimestamp = 1763646905;
    }

    log(msg) {
        // 统一写入文件日志，避免“主号不建房/断线”在 farming_*.log 中不可观测
        const name = this.account?.username || 'unknown';
        logInfo('主号', `👑[${name}] ${msg}`);
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
        // 🔴 停止/手动退出时会触发 loggedOff/disconnected 事件：
        // 这种情况不需要“重连”，也不应该重复 cleanup 或输出误导日志。
        if (this.stopped) {
            return;
        }
        // 🔴 防止重复触发（error 和 disconnected 可能同时触发）
        if (this.isReconnecting) {
            return;
        }
        this.isReconnecting = true;

        this.log(`🔄 因 ${reason} 断开，5秒后重连...`);
        this.is_gc_connected = false;
        this.state = 'DISCONNECTED'; // 🔴 重置状态，防止旧超时检测干扰

        // 🔴 修复：handleDisconnect 走的是“重连”，不应把 stopped=true
        // 使用 reconnect 专用清理，避免断线后永不重连
        this.cleanupForReconnect();
        
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
                    
                    // 固定人数分配：不足则登记等待，池子回补后补齐缺口
                    this.fillFollowersToFixedTarget(lobbyId, 'room_created');
                }
                
                // 只处理当前房间的更新
                if (this.currentLobbyId && lobbyId.toString() === this.currentLobbyId.toString()) {
                    // 更新房间人数
                    this.currentRoomMemberCount = memberCount;

                    // 固定人数补齐：如果还在 SEEDING 且未达阈值，持续尝试补齐缺口
                    // （避免“分配后中途有人回池/加入失败”导致人数长期 < 阈值）
                    if (this.state === 'SEEDING' && memberCount < this.seedingThreshold) {
                        this.fillFollowersToFixedTarget(lobbyId, 'lobby_update');
                    }
                    
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

    getMaxFollowersPerRoom() {
        return (this.settings.max_players_per_room || 24) - 2;
    }

    _getAssignedCountForLobby(lobbyId) {
        if (!lobbyId) return 0;
        const list = this.pool.assigned.get(lobbyId.toString());
        return Array.isArray(list) ? list.length : 0;
    }

    _registerFillWait(lobbyIdStr) {
        if (!lobbyIdStr) return;
        if (this._fillWaitPending && this._fillWaitLobbyId === lobbyIdStr) return;
        this._fillWaitPending = true;
        this._fillWaitLobbyId = lobbyIdStr;

        this.pool.waitingLeaders.push(() => {
            // 回池触发：尝试补齐缺口
            this._fillWaitPending = false;
            if (this.stopped) return;
            if (this.state !== 'SEEDING') return;
            if (!this.currentLobbyId) return;
            if (this.currentLobbyId.toString() !== lobbyIdStr) return;
            this.fillFollowersToFixedTarget(this.currentLobbyId, 'pool_replenished');
        });
    }

    fillFollowersToFixedTarget(lobbyId, reason = '') {
        if (this.stopped) return;
        if (!lobbyId) return;
        // 只对“当前房间”做补齐，避免旧房间/延迟消息误触发
        if (!this.currentLobbyId) return;
        if (this.currentLobbyId.toString() !== lobbyId.toString()) return;
        if (this.state !== 'SEEDING') return;

        const target = this.getMaxFollowersPerRoom();
        const assignedNow = this._getAssignedCountForLobby(lobbyId);
        const missing = Math.max(0, target - assignedNow);

        if (missing <= 0) {
            // 已补齐：清理等待标记
            if (this._fillWaitLobbyId === lobbyId.toString()) {
                this._fillWaitPending = false;
                this._fillWaitLobbyId = null;
            }
            return;
        }

        if (reason) {
            logInfo('主号', `🧩 补齐检查(${reason}): lobby=${lobbyId.toString()} 已分配=${assignedNow}/${target} 缺口=${missing} idle=${this.pool.idle.length}`);
        }

        const got = this.assignFollowersToRoom(lobbyId, missing);
        const after = assignedNow + (got || 0);
        const remain = Math.max(0, target - after);

        if (remain > 0) {
            // 池子不足：登记等待（池子回补时继续补缺口）
            this._registerFillWait(lobbyId.toString());
        } else {
            // 已补齐：清理等待标记
            this._fillWaitPending = false;
            this._fillWaitLobbyId = null;
            logInfo('主号', `✅ 已补齐固定人数: lobby=${lobbyId.toString()} 已分配=${after}/${target}`);
        }
    }

    assignFollowersToRoom(lobbyId, count) {
        if (this.stopped) return; // 已停止，不再操作
        
        // 从池子取 (max_players - 2) 个小号
        // max_players_per_room - 1 = 房间实际最大人数（防止满员解散）
        // 再 -1 = 主号占1个位置
        const maxFollowers = this.getMaxFollowersPerRoom();
        const requestCount = Math.max(1, Math.min(maxFollowers, Number(count) || 1));
        const followers = this.pool.assignToRoom(lobbyId, requestCount);
        
        if (followers.length === 0) {
            const lobbyIdStr = lobbyId?.toString?.() || String(lobbyId);
            logInfo('主号', `⏳ 池子为空/不足，本次未分配（request=${requestCount} lobby=${lobbyIdStr} idle=${this.pool.idle.length}）`);
            return 0;
        }

        // 打印分配信息（包括是否不足）
        if (followers.length < requestCount) {
            logInfo('主号', `🚀 分配 ${followers.length}/${requestCount} 个小号 → 房间 #${this.roomsCreated} (池子不足)`);
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
        
        return followers.length;
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

        // 离开房间：清理补齐等待标记
        this._fillWaitPending = false;
        this._fillWaitLobbyId = null;

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

    // 🔴 重连专用清理：不设置 stopped=true，避免“断线后永不重连”
    cleanupForReconnect() {
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        this.is_gc_connected = false;

        // 清理房间状态，避免 stats 误报“主号仍活跃”
        this.currentLobbyId = null;
        this.currentRoomMemberCount = 0;
        this.state = 'DISCONNECTED';
        this._fillWaitPending = false;
        this._fillWaitLobbyId = null;

        const clientToClean = this.client;
        try {
            if (clientToClean) {
                clientToClean.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                clientToClean.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                setTimeout(() => {
                    try { clientToClean.logOff(); } catch (e) {}
                    setTimeout(() => {
                        try { clientToClean.removeAllListeners(); } catch (e) {}
                    }, 500);
                }, 300);
            }
        } catch (err) {}

        this.client = null;
    }

    cleanup() {
        if (this.ready_up_heartbeat) clearInterval(this.ready_up_heartbeat);
        
        // 标记为已停止，阻止后续操作
        this.stopped = true;
        this.is_gc_connected = false;
        this._fillWaitPending = false;
        this._fillWaitLobbyId = null;
        
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

        // 🔴 新增：配置 -> 小号集合（用于运行时移除配置，不影响旧逻辑）
        this.configFollowers = new Map(); // configName -> Set<FollowerBot>
        
        // 时间统计
        this.startTime = null;
        
        // Bot管理
        this.pool = new FollowerPool(this);
        this.leaders = [];
        this.allFollowers = [];  // 所有小号

        // 🔴 新增：记录“主号是否应停止”（仅运行时，避免改动旧配置文件）
        // 注意：LeaderBot.stopped 仍是最终开关；这个集合用于查询/展示。
        this.stoppedLeaderUsernames = new Set();
        
        // 登录参数 - 流水线模式
        this.loginInterval = 10;      // 每个小号间隔10ms
        this.loginPipelineTimer = null; // 登录流水线定时器
        
        // 代理使用统计
        this.proxyStats = new Map();  // proxy -> { used, success, failed, activeConnections }

        // 结算/查询：JoinableCustomLobbies 请求（并发安全：队列 + 单飞行请求）
        this._lobbyQueryCallbacks = [];
        this._lobbyQueryInFlight = false;
        this._lobbyQueryTimeoutHandle = null;
        this._lobbyQueryFinish = null;
        this._lobbyQuerySender = null;

        // ✅ 僵尸分配清理日志节流
        this._lastPruneAssignedLogAt = 0;

        // ✅ 动态目标挂机人数（“在线/可用小号”目标）：0 表示不限制（保持旧逻辑）
        this.targetFollowers = 0;
        this._lastApplyTargetAt = 0; // 缩容节流（避免 10ms tick 下反复全量扫描）
    }

    // 计算“当前使用人数”（在线/可用）：IDLE + ASSIGNED + IN_LOBBY + LOGGING_IN
    getActiveFollowerCount() {
        const poolStats = this.pool.getStats();
        return (poolStats.idle || 0) + (poolStats.assigned || 0) + (poolStats.inLobby || 0) + (poolStats.loggingIn || 0);
    }

    // 设置目标挂机人数（可运行时动态调整）
    setTargetFollowers(count) {
        const maxUsable = this.pool?.all?.length || 0;
        let target = Number(count);
        if (!Number.isFinite(target)) target = 0;
        target = Math.max(0, Math.floor(target));
        if (maxUsable > 0) target = Math.min(target, maxUsable);

        this.targetFollowers = target;
        const result = this.applyTargetFollowers();
        return { success: true, target: this.targetFollowers, maxUsable, ...result };
    }

    // 目标人数下降时：缩容登出多余小号（优先 idle，其次房间内/登录中）
    applyTargetFollowers() {
        const target = Number(this.targetFollowers || 0);
        if (!target || target <= 0) {
            return { changed: false, reason: 'no_limit' };
        }

        const poolStats = this.pool.getStats();
        const active = this.getActiveFollowerCount();
        let excess = active - target;
        if (excess <= 0) {
            return { changed: false, active, target };
        }

        let stopped = 0;

        // 1) 优先踢 idle（对房间影响最小）
        while (excess > 0 && Array.isArray(this.pool.idle) && this.pool.idle.length > 0) {
            const bot = this.pool.idle.pop();
            if (!bot || bot.permanentFailed || bot.removing) continue;
            try { bot.cleanup(); } catch (e) {}
            this.pool.forceToPending(bot, { enqueue: true });
            excess--;
            stopped++;
        }

        // 2) 其次踢在房间内的小号（会影响房间人数，但符合“缩容”预期）
        if (excess > 0 && Array.isArray(this.allFollowers)) {
            const inLobbyBots = this.allFollowers.filter(b => b && !b.permanentFailed && !b.removing && b.state === FollowerState.IN_LOBBY);
            for (const bot of inLobbyBots) {
                if (excess <= 0) break;
                try { bot.cleanup(); } catch (e) {}
                this.pool.forceToPending(bot, { enqueue: true });
                excess--;
                stopped++;
            }
        }

        // 3) 再踢正在登录/加入中的（避免占并发/占坑）
        if (excess > 0 && Array.isArray(this.allFollowers)) {
            const midBots = this.allFollowers.filter(b =>
                b && !b.permanentFailed && !b.removing &&
                (b.state === FollowerState.LOGGING_IN || b.state === FollowerState.ASSIGNED)
            );
            for (const bot of midBots) {
                if (excess <= 0) break;
                try { bot.cleanup(); } catch (e) {}
                this.pool.forceToPending(bot, { enqueue: true });
                excess--;
                stopped++;
            }
        }

        if (stopped > 0) {
            logInfo('Farming', `🎯 目标人数=${target}，缩容登出 ${stopped} 个小号（当前active=${active}）`);
        }

        return { changed: stopped > 0, stopped, active, target };
    }

    // ✅ 清理 assigned 映射里长期卡住/状态错乱的小号引用，避免误判“房间已满”导致登录流水线停摆
    pruneStaleAssigned() {
        const now = Date.now();
        const staleMs = this.settings?.assigned_stale_ms || (90 * 1000); // 默认 90 秒
        const assignedMap = this.pool?.assigned;
        if (!assignedMap || typeof assignedMap.forEach !== 'function') return;

        let removed = 0;
        let touchedRooms = 0;

        try {
            assignedMap.forEach((arr, lobbyId) => {
                if (!Array.isArray(arr) || arr.length === 0) return;
                const before = arr.length;

                const kept = arr.filter((b) => {
                    if (!b) return false;
                    const cur = b.currentLobbyId?.toString?.();
                    const asg = b.assignedLobbyId?.toString?.();

                    // 明确在房间内：保留
                    if (cur && cur === lobbyId) return true;

                    // 分配中：未过期才保留
                    if (b.state === FollowerState.ASSIGNED && asg && asg === lobbyId) {
                        const at = Number(b.assignedAt || 0);
                        if (at > 0 && (now - at) <= staleMs) return true;

                        // 过期：丢弃引用并清空占坑字段
                        try { b.assignedLobbyId = null; } catch (e) {}
                        try { b.assignedAt = 0; } catch (e) {}
                        return false;
                    }

                    // 其他状态不应该长期挂在 assigned：丢弃
                    if (asg && asg === lobbyId) {
                        try { b.assignedLobbyId = null; } catch (e) {}
                        try { b.assignedAt = 0; } catch (e) {}
                    }
                    return false;
                });

                if (kept.length !== before) {
                    removed += (before - kept.length);
                    touchedRooms++;
                    if (kept.length === 0) assignedMap.delete(lobbyId);
                    else assignedMap.set(lobbyId, kept);
                }
            });
        } catch (e) {}

        // 节流：最多 30 秒提示一次
        if (removed > 0) {
            const last = this._lastPruneAssignedLogAt || 0;
            if ((now - last) > 30000) {
                this._lastPruneAssignedLogAt = now;
                logWarning('Pool', `🧹 清理僵尸分配: 移除${removed}个引用，影响房间${touchedRooms}个（stale>${Math.round(staleMs/1000)}s）`);
            }
        }
    }

    // 🔴 新增：统一定位主号（username 或 index 兼容）
    _findLeader(params = {}) {
        const username = typeof params.username === 'string' ? params.username.trim() : '';
        const indexRaw = params.index;

        if (username) {
            return this.leaders.find(l => l && l.account && l.account.username === username) || null;
        }

        if (indexRaw !== undefined && indexRaw !== null && indexRaw !== '') {
            const n = Number(indexRaw);
            if (Number.isFinite(n)) {
                const idx0 = (n >= 1) ? (n - 1) : n;
                return this.leaders[idx0] || null;
            }
        }

        return null;
    }

    // 🔴 新增：停止指定挂机主号（释放账号去做别的事情）
    // 设计目标：不改旧流程，只在收到命令时执行。
    // 支持按 username 或 index(1-based / 0-based 兼容) 指定。
    stopLeader(params = {}) {
        const mode = params.mode || 'immediate'; // 'immediate' | 'graceful'
        const leader = this._findLeader(params);

        if (!leader) {
            const u = (typeof params.username === 'string' ? params.username.trim() : '') || '-';
            const i = (params.index ?? '-');
            logWarning('Farming', `⚠️ 停止主号失败：未找到目标 (username=${u} index=${i})`);
            return { success: false, reason: 'not_found' };
        }

        const name = leader.account?.username || 'unknown';
        if (leader.stopped) {
            logWarning('Farming', `⚠️ 主号已停止：${name}`);
            this.stoppedLeaderUsernames.add(name);
            return { success: true, alreadyStopped: true, username: name };
        }

        logSection(`停止挂机主号: ${name}`);
        logInfo('System', `模式: ${mode}`);

        // 平滑模式：先让当前房间的小号退出（主号退出房间会把房主给小号，你说不需要处理；
        // 这里的“平滑”仅用于减少突然解散/波动，可选）
        if (mode === 'graceful') {
            const lobbyId = leader.currentLobbyId?.toString();
            if (lobbyId) {
                try {
                    this.dissolveRooms([lobbyId]);
                } catch (e) {}
            }
        }

        // 立即模式：直接 stop + cleanup（本身会发送 leave + logOff）
        leader.stopped = true;
        this.stoppedLeaderUsernames.add(name);
        try { leader.cleanup(); } catch (e) {}

        logSuccess('Farming', `✅ 已停止主号：${name}`);
        return { success: true, username: name, mode };
    }

    // 🔴 新增：重新启动指定挂机主号（加回流程）
    startLeader(params = {}) {
        const leader = this._findLeader(params);
        if (!leader) {
            const u = (typeof params.username === 'string' ? params.username.trim() : '') || '-';
            const i = (params.index ?? '-');
            logWarning('Farming', `⚠️ 启动主号失败：未找到目标 (username=${u} index=${i})`);
            return { success: false, reason: 'not_found' };
        }

        const name = leader.account?.username || 'unknown';
        if (!leader.stopped && leader.client) {
            // 已在运行/已登录：不重复启动
            this.stoppedLeaderUsernames.delete(name);
            logWarning('Farming', `⚠️ 主号已在运行：${name}`);
            return { success: true, alreadyRunning: true, username: name };
        }

        logSection(`启动挂机主号: ${name}`);
        // start() 内部会把 stopped=false 并重新登录
        try {
            this.stoppedLeaderUsernames.delete(name);
            leader.start();
        } catch (e) {
            logError('Farming', `❌ 启动主号失败: ${name} - ${e.message}`);
            return { success: false, reason: e.message, username: name };
        }

        logSuccess('Farming', `✅ 已启动主号：${name}`);
        return { success: true, username: name };
    }

    // 🔴 新增：获取主号状态（用于前端显示/切换时展示）
    getLeadersStatus() {
        return (this.leaders || []).map((leader, idx) => {
            const username = leader?.account?.username || `leader_${idx + 1}`;
            const stopped = !!leader?.stopped || this.stoppedLeaderUsernames.has(username);
            return {
                index: idx + 1,
                username,
                stopped,
                state: leader?.state || 'UNKNOWN',
                is_gc_connected: !!leader?.is_gc_connected,
                currentLobbyId: leader?.currentLobbyId ? leader.currentLobbyId.toString() : null,
                roomsCreated: Number(leader?.roomsCreated || 0)
            };
        });
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
        const totalRoomsThreshold = this.settings.leader_proxy_rotate_rooms || 100;
        const roomsPerLeader = Math.max(1, Math.floor(totalRoomsThreshold / this.leadersConfig.length));
        logInfo('System', `  ├─ 主号专用: ${this.leaderProxies.length} 个 (总阈值${totalRoomsThreshold}房间/${this.leadersConfig.length}主号=${roomsPerLeader}房间/号后轮换)`);
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
        
        // 解析 --config=config_XXX 参数，默认 config_000
        let configToLoad = 'config_000';
        const configArg = process.argv.find(arg => arg.startsWith('--config='));
        if (configArg) {
            configToLoad = configArg.replace('--config=', '');
        }
        
        this.addConfig(configToLoad);
        
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
                bot.configName = configName;
                bot.removing = false;
                if (!this.configFollowers.has(configName)) {
                    this.configFollowers.set(configName, new Set());
                }
                this.configFollowers.get(configName).add(bot);
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

    // 🔴 新增：将某个小号彻底从池子/管理器中摘除（不做 cleanup，调用方负责）
    // 设计目标：只在“移除配置”场景生效，不影响旧逻辑
    finalizeFollowerRemoval(follower, meta = {}) {
        if (!follower) return;
        if (follower._finalizedRemoval) return;
        follower._finalizedRemoval = true;

        try {
            // 1) 登录队列移除
            if (Array.isArray(this.pool?.loginQueue) && this.pool.loginQueue.length > 0) {
                this.pool.loginQueue = this.pool.loginQueue.filter(x => x !== follower);
            }

            // 2) 池子空闲移除
            if (Array.isArray(this.pool?.idle) && this.pool.idle.length > 0) {
                this.pool.idle = this.pool.idle.filter(x => x !== follower);
            }

            // 3) 已分配映射移除
            if (this.pool?.assigned && typeof this.pool.assigned.forEach === 'function') {
                const toDelete = [];
                this.pool.assigned.forEach((arr, lobbyId) => {
                    if (!Array.isArray(arr) || arr.length === 0) return;
                    const next = arr.filter(x => x !== follower);
                    if (next.length !== arr.length) {
                        if (next.length === 0) toDelete.push(lobbyId);
                        else this.pool.assigned.set(lobbyId, next);
                    }
                });
                toDelete.forEach(id => this.pool.assigned.delete(id));
            }

            // 4) all 列表移除（统计 total 会跟着变化）
            if (Array.isArray(this.pool?.all) && this.pool.all.length > 0) {
                this.pool.all = this.pool.all.filter(x => x !== follower);
            }
            if (Array.isArray(this.allFollowers) && this.allFollowers.length > 0) {
                this.allFollowers = this.allFollowers.filter(x => x !== follower);
            }

            // 5) 从 configFollowers 映射移除
            const cfg = follower.configName;
            if (cfg && this.configFollowers.has(cfg)) {
                const set = this.configFollowers.get(cfg);
                try { set.delete(follower); } catch (e) {}
                if (set && set.size === 0) {
                    // 不主动 delete（由 removeConfig 统一处理），避免误删
                }
            }
        } catch (e) {
            // 摘除失败不应影响主流程
        }
    }

    // 🔴 新增：运行时移除某个配置（退出房间 → 退出登录 → 退出池子/程序）
    removeConfig(configName) {
        if (!configName) return { success: false, reason: 'missing_name' };
        if (configName === 'config_000') {
            // 默认配置保护：避免误操作导致车队无基础小号（不影响旧逻辑）
            logWarning('Farming', `⚠️ 默认配置 ${configName} 不允许移除`);
            return { success: false, reason: 'default_config_protected' };
        }
        if (!this.loadedConfigs.has(configName)) {
            logWarning('Farming', `⚠️ ${configName} 未加载，无法移除`);
            return { success: false, reason: 'not_loaded' };
        }

        const set = this.configFollowers.get(configName);
        const bots = set ? Array.from(set) : [];

        logSection(`移除配置: ${configName}`);
        logInfo('System', `准备移除 ${bots.length} 个小号（退出房间→登出→移出池子）`);

        // 先把队列/池子里引用摘掉，防止继续被分配/继续登录
        bots.forEach(bot => {
            try {
                bot.removing = true;
                bot.stopped = true; // 复用旧逻辑的“停止”检查，避免继续 join/重连
            } catch (e) {}
        });

        // 移除登录队列中属于该配置的 bot
        if (Array.isArray(this.pool?.loginQueue) && this.pool.loginQueue.length > 0) {
            this.pool.loginQueue = this.pool.loginQueue.filter(b => !(b && b.configName === configName));
        }

        // 移除 idle 池中属于该配置的 bot
        if (Array.isArray(this.pool?.idle) && this.pool.idle.length > 0) {
            this.pool.idle = this.pool.idle.filter(b => !(b && b.configName === configName));
        }

        // assigned map 中属于该配置的 bot 全部剔除
        if (this.pool?.assigned && typeof this.pool.assigned.forEach === 'function') {
            const toDelete = [];
            this.pool.assigned.forEach((arr, lobbyId) => {
                if (!Array.isArray(arr) || arr.length === 0) return;
                const next = arr.filter(b => !(b && b.configName === configName));
                if (next.length === 0) toDelete.push(lobbyId);
                else if (next.length !== arr.length) this.pool.assigned.set(lobbyId, next);
            });
            toDelete.forEach(id => this.pool.assigned.delete(id));
        }

        let inLobby = 0;
        let cleaned = 0;

        bots.forEach(bot => {
            if (!bot) return;
            try {
                if (bot.state === FollowerState.IN_LOBBY) {
                    inLobby++;
                    // 先发退房消息（如果已在房间）
                    bot.leaveLobbyForDissolve();
                }
            } catch (e) {}

            try {
                // cleanup 内部会发送 Leave/Abandon 并 logOff（满足“退出房间→退出登录”的要求）
                bot.cleanup();
                cleaned++;
            } catch (e) {}

            // 最后从统计/池子/管理器中摘除引用
            this.finalizeFollowerRemoval(bot, { from: 'manager.removeConfig' });
        });

        // 清理映射与状态：允许后续再次 add_config
        this.loadedConfigs.delete(configName);
        this.configFollowers.delete(configName);

        logSuccess('Farming', `✅ 已移除 ${configName}: 总${bots.length}，房间内${inLobby}，已清理登出${cleaned}`);
        return { success: true, count: bots.length, inLobby, cleaned };
    }

    // ✅ 计算当前池子缺口（所有主号房间的缺口总和）
    _calcPoolDemand() {
        // 每次计算前先清理一次僵尸分配，避免“需求=0”假死
        this.pruneStaleAssigned();

        let totalDemand = 0;
        const maxPerRoom = (this.settings.max_players_per_room || 24) - 2; // 每房间最多小号数
        const now = Date.now();
        const staleMs = this.settings?.assigned_stale_ms || (90 * 1000);
        
        // 遍历所有主号，累计各房间的缺口
        this.leaders.forEach(leader => {
            if (leader.stopped) return;
            if (!leader.currentLobbyId) return;
            const lobbyId = leader.currentLobbyId.toString();
            const assigned = this.pool.assigned.get(lobbyId);
            // 注意：不能直接用 assigned.length（会被“僵尸引用”污染），这里按“在房间内 + 未过期的分配中”计数
            const assignedCount = Array.isArray(assigned)
                ? assigned.filter((b) => {
                    if (!b) return false;
                    const cur = b.currentLobbyId?.toString?.();
                    if (cur && cur === lobbyId) return true;
                    if (b.state === FollowerState.ASSIGNED && b.assignedLobbyId?.toString?.() === lobbyId) {
                        const at = Number(b.assignedAt || 0);
                        return at > 0 && (now - at) <= staleMs;
                    }
                    return false;
                }).length
                : 0;
            const missing = Math.max(0, maxPerRoom - assignedCount);
            totalDemand += missing;
        });
        
        // 加上等待中的主号数量（即将创建房间）* 每房间人数
        const waitingLeaderCount = this.pool.waitingLeaders.length;
        totalDemand += waitingLeaderCount * maxPerRoom;
        
        return totalDemand;
    }

    // 登录流水线：智能控制登录速度（只看池子需求）
    startLoginPipeline() {
        // 🔴 动态计算控制参数（基于主号数量）
        const leaderCount = this.leaders.length || 1;
        const MAX_LOGGING_IN = leaderCount * 200;      // 每个主号配 200 个同时登录上限
        const SLOW_INTERVAL = 1000;     // 暂缓时的检查间隔（1秒）
        const NORMAL_INTERVAL = this.loginInterval; // 正常间隔（100ms）
        
        const processNext = () => {
            // ✅ 保证流水线不会被偶发异常打断（否则会表现为"还有几千号没登但程序像暂停"）
            try {
                const poolStats = this.pool.getStats();

                // ✅ 缩容节流：只有 active > target 且至少间隔 2 秒才执行一次（避免 10ms tick 下 O(n) 扫描）
                const target = Number(this.targetFollowers || 0);
                const active = (poolStats.idle || 0) + (poolStats.assigned || 0) + (poolStats.inLobby || 0) + (poolStats.loggingIn || 0);
                if (target > 0 && active > target) {
                    const now = Date.now();
                    if (!this._lastApplyTargetAt || (now - this._lastApplyTargetAt) >= 2000) {
                        this._lastApplyTargetAt = now;
                        try { this.applyTargetFollowers(); } catch (e) {}
                    }
                }
                
                // ✅ 核心改动：只看池子缺口，缺口 <= 0 则暂缓登录
                const demand = this._calcPoolDemand();
                const currentIdle = poolStats.idle;
                const demandGap = demand - currentIdle; // 缺口 = 需求 - 当前空闲

                // ✅ 新增：目标挂机人数约束（active>=target 时暂停登录）
                const activeGap = target > 0 ? (target - active) : Number.POSITIVE_INFINITY;

                const gap = Math.min(demandGap, activeGap);
                
                if (gap <= 0) {
                    // 池子够用，不需要登录，1秒后再检查
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
                    // 🔴 新增：移除中的小号直接跳过（不影响旧逻辑）
                    if (bot && bot.removing) {
                        // skip
                    } else if (bot && bot.permanentFailed) {
                        // 永久失败：跳过
                    } else if (bot && bot.nextRetryAt && Date.now() < bot.nextRetryAt) {
                        // ✅ 冷却中：放回队尾，避免反复占用并发
                        this.pool.loginQueue.push(bot);
                    } else if (bot.state === FollowerState.PENDING) {
                        bot.start();
                    } else {
                        // 不是 PENDING 状态的跳过
                    }
                }
            
                // 继续调度下一个
                this.loginPipelineTimer = setTimeout(processNext, NORMAL_INTERVAL);
            } catch (e) {
                // 兜底：异常也要继续调度，避免流水线"断了"
                this.loginPipelineTimer = setTimeout(processNext, 500);
            }
        };
        
        // 启动流水线
        processNext();
        logInfo('Farming', `🚀 登录流水线已启动 (主号${leaderCount}个: 只看池子缺口, 登录中>${MAX_LOGGING_IN}等待)`);
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

            // 目标/使用人数（用于 UI 显示）
            targetFollowers: this.targetFollowers || 0,
            activeFollowers: this.getActiveFollowerCount(),
            
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

        // 候选规则（按你的要求简化）：
        // - 必须是本游戏
        // - 必须是带密码房（hasPassKey=true）
        // - 只要能证明“房间里至少有我方 IN_LOBBY 小号”即可作为备选
        //   （避免 memberCount 口径差异导致“永远选不到房间”）
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
            .filter(x => x.lobbyId && x.ourInLobby > 0)
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

    // 解散指定房间：收到房间ID后，让“所有在这些房间里的账号（主号+小号）”全部退出
    dissolveRooms(roomIds) {
        if (!roomIds || roomIds.length === 0) {
            logWarning('System', '解散房间: 没有收到有效的房间ID');
            return;
        }
        
        const roomIdSet = new Set(roomIds.map(id => id.toString()));
        let followerLeaveCount = 0;
        let leaderLeaveCount = 0;
        
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

        // ✅ 主号：只要在目标房间里就退出（不区分主号/小号，目标是“房间里我方账号清空”）
        try {
            this.leaders.forEach(leader => {
                const lid = leader?.currentLobbyId?.toString?.();
                if (lid && roomIdSet.has(lid)) {
                    leaderLeaveCount++;
                    logInfo('主号', `👑[${leader.account?.username || 'unknown'}] 在房间 ${lid} 中，执行退出...`);
                    try { leader.leaveLobby(); } catch (e) {}
                }
            });
        } catch (e) {}
        
        // 小号：只要 currentLobbyId 命中就退出
        this.allFollowers.forEach(follower => {
            const followerLobbyId = follower.currentLobbyId?.toString();
            
            if (followerLobbyId && roomIdSet.has(followerLobbyId)) {
                followerLeaveCount++;
                logInfo('Follower', `${follower.account.username} 在房间 ${followerLobbyId} 中，执行退出...`);
                
                // 让小号主动退出房间
                follower.leaveLobbyForDissolve();
            }
        });
        
        logSuccess('System', `解散房间执行完成: 小号退出=${followerLeaveCount} | 主号退出=${leaderLeaveCount}`);
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
    const msg = err?.message || String(err);
    // ✅ 代理超时属于高频噪音，且会拖慢事件循环（刷屏+阻塞定时器），这里直接忽略/节流
    if (msg.includes('Proxy connection timed out')) return;
    if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(err.code)) return;
    logError('System', `未捕获的异常: ${msg}`);
});

process.on('unhandledRejection', (reason) => {
    const msg = (reason && (reason.message || String(reason))) || String(reason);
    if (msg.includes('Proxy connection timed out')) return;
    if (reason?.code && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(reason.code)) return;
    logError('System', `未处理的Promise拒绝: ${msg}`);
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

        // ✅ 新增：查询当前已加载配置（给 Web 控制台显示“已加入/未加入”使用）
        if (cmd.type === 'get_loaded_configs') {
            try {
                const list = Array.from(manager.loadedConfigs || []);
                console.log(JSON.stringify({ type: 'loaded_configs', data: list }));
            } catch (e) {
                console.log(JSON.stringify({ type: 'loaded_configs', data: [] }));
            }
            return;
        }

        // 🔴 新增：移除配置（退出房间→退出登录→退出池子）
        if (cmd.type === 'remove_config' && cmd.configName) {
            logSection('收到移除配置命令');
            logInfo('System', `配置名称: ${cmd.configName}`);
            const result = manager.removeConfig(cmd.configName);
            console.log(JSON.stringify({ type: 'remove_config_result', ...result }));
            return;
        }

        // 🔴 新增：停止指定挂机主号（释放账号）
        if (cmd.type === 'stop_leader') {
            const result = manager.stopLeader({
                username: cmd.username,
                index: cmd.index,
                mode: cmd.mode
            });
            console.log(JSON.stringify({ type: 'stop_leader_result', ...result }));
            return;
        }

        // 🔴 新增：启动指定挂机主号（加回流程）
        if (cmd.type === 'start_leader') {
            const result = manager.startLeader({
                username: cmd.username,
                index: cmd.index
            });
            console.log(JSON.stringify({ type: 'start_leader_result', ...result }));
            return;
        }

        // 🔴 新增：获取主号状态（用于前端显示）
        if (cmd.type === 'get_leaders_status') {
            const data = manager.getLeadersStatus();
            console.log(JSON.stringify({ type: 'leaders_status', data }));
            return;
        }
        
        // 获取状态命令
        if (cmd.type === 'get_stats') {
            const stats = manager.getStats();
            console.log(JSON.stringify({ type: 'stats', data: stats }));
            return;
        }

        // ✅ 新增：设置目标挂机人数（动态调整小号在线/可用人数）
        if (cmd.type === 'set_target_followers') {
            const count = Number(cmd.count || 0);
            const result = manager.setTargetFollowers(count);
            logInfo('System', `🎯 设置目标挂机人数: ${result.target} / max=${result.maxUsable} (changed=${result.changed ? 'yes' : 'no'})`);
            console.log(JSON.stringify({ type: 'set_target_followers_result', ...result }));
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


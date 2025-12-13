/**
 * 展示车队独立程序
 * 
 * 功能：
 * - 管理2个展示主号，轮流创建公开房间（无密码）
 * - 每N分钟轮换：先创建新展示房，再解散旧展示房
 * - 轮换后通知挂机车队解散最老的5个挂机房间
 * 
 * 使用方法：
 * node src/showcase.js --config=config/config_showcase.json
 * node src/showcase.js --config=config/config_showcase.json debug
 */

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');
const http = require('http');

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
    return path.join(LOG_CONFIG.logDir, `showcase_${today}.log`);
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
            if (!file.startsWith('showcase_') || !file.endsWith('.log')) return;
            
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
const k_EMsgGCPracticeLobbyResponse = 7055;
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

// 服务器区域名称映射
const RegionNameMap = {
    0: "Auto", 1: "US West", 2: "US East", 3: "Europe", 5: "Singapore", 
    6: "Dubai", 7: "Australia", 8: "Stockholm", 9: "Austria", 
    10: "Brazil", 11: "South Africa", 12: "PW Telecom", 13: "PW Unicom", 
    14: "Chile", 15: "Peru", 16: "India", 17: "Reg:17", 18: "Reg:18", 
    19: "Japan", 20: "Reg:20", 25: "PW Tianjin"
};

// Dota 2 枚举
const DOTA_GC_TEAM = {
    DOTA_GC_TEAM_GOOD_GUYS: 0,
    DOTA_GC_TEAM_BAD_GUYS: 1,
    DOTA_GC_TEAM_BROADCASTER: 2,
    DOTA_GC_TEAM_SPECTATOR: 3,
    DOTA_GC_TEAM_PLAYER_POOL: 4,
    DOTA_GC_TEAM_NOTEAM: 5
};

const DOTALobbyReadyState = {
    DOTALobbyReadyState_UNDECLARED: 0,
    DOTALobbyReadyState_NOT_READY: 1,
    DOTALobbyReadyState_READY: 2
};

// ============================================
// Proto 定义加载
// ============================================
let CMsgClientHello, CMsgPracticeLobbyCreate, CMsgPracticeLobbySetDetails,
    CMsgPracticeLobbySetTeamSlot, CMsgReadyUp, CMsgReadyUpStatus, CSODOTALobby, CDOTAClientHardwareSpecs;
let CMsgSOSingleObject, CMsgSOMultipleObjects, CMsgSOCacheSubscribed;
let CMsgJoinableCustomLobbiesRequest, CMsgJoinableCustomLobbiesResponse;

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
    CMsgPracticeLobbyCreate = root.lookupType("CMsgPracticeLobbyCreate");
    CMsgPracticeLobbySetDetails = root.lookupType("CMsgPracticeLobbySetDetails");
    CMsgPracticeLobbySetTeamSlot = root.lookupType("CMsgPracticeLobbySetTeamSlot");
    CMsgReadyUp = root.lookupType("CMsgReadyUp");
    CMsgReadyUpStatus = root.lookupType("CMsgReadyUpStatus");
    CSODOTALobby = root.lookupType("CSODOTALobby");
    CDOTAClientHardwareSpecs = root.lookupType("CDOTAClientHardwareSpecs");
    CMsgSOSingleObject = root.lookupType("CMsgSOSingleObject");
    CMsgSOMultipleObjects = root.lookupType("CMsgSOMultipleObjects");
    CMsgSOCacheSubscribed = root.lookupType("CMsgSOCacheSubscribed");
    CMsgJoinableCustomLobbiesRequest = root.lookupType("CMsgJoinableCustomLobbiesRequest");
    CMsgJoinableCustomLobbiesResponse = root.lookupType("CMsgJoinableCustomLobbiesResponse");
    
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

function logDebug(category, message, debugMode) {
    if (debugMode) {
        console.log(`[${formatTime()}] [${category}] 🔍 ${message}`);
        writeToLogFile('DEBUG', category, message);
    }
}

// ============================================
// ShowcaseBot - 展示主号Bot
// ============================================
class ShowcaseBot {
    constructor(account, settings, index) {
        this.account = account;
        this.settings = settings;
        this.index = index; // 0=主号A, 1=主号B
        this.label = index === 0 ? 'A' : 'B';
        
        const sharedDataPath = settings.shared_steam_data_path || "../shared_steam_data";
        const steamDataDir = path.resolve(projectRoot, sharedDataPath);
        
        const steamOptions = { dataDirectory: steamDataDir };
        
        // 使用配置中的代理
        if (account.proxy) {
            steamOptions.httpProxy = account.proxy;
            logInfo(`展示主号${this.label}`, `使用代理: ${account.proxy}`);
        }

        this.client = new SteamUser(steamOptions);
        this.handleClientError = this.handleClientError.bind(this);
        this.client.on('error', this.handleClientError);
        
        this.is_gc_connected = false;
        this.currentLobbyId = null;
        this.ready_up_heartbeat = null;
        this.state = 'OFFLINE'; // OFFLINE -> LOGGING_IN -> ONLINE -> CREATING_LOBBY -> IN_LOBBY
        this.retryCount = 0;
        this.lobbyCreatedAt = null;
        // Presence mode: 连续“消失(不在展示位)”开始时间（0=未消失）
        this.missingSince = 0;

        // CRC 数据
        this.knownCrc = "1396649696593898392";
        this.knownTimestamp = 1763646905;
        
        // 房间查询回调
        // 旧版单回调容易被并发查询覆盖，改为并发安全的队列式查询
        this._lobbyQueryCallbacks = [];
        this._lobbyQueryInFlight = false;
        this._lobbyQueryTimeoutHandle = null;
        this._lobbyQueryFinish = null;

        // Presence mode: 每个主号的冷却时间（创建/结算后暂停操作）
        this.cooldownUntil = 0;

        this.setupListeners();
    }

    log(msg) {
        console.log(`[${formatTime()}] [展示主号${this.label}|${this.account.username}] ${msg}`);
    }

    error(msg) {
        console.error(`[${formatTime()}] [展示主号${this.label}|${this.account.username}] ❌ ${msg}`);
    }

    handleClientError(err) {
        this.error(`Steam 客户端错误: ${err.message}`);
        
        // 错误发生后重置状态，允许重试
        this.state = 'OFFLINE';
        this.is_gc_connected = false;  // 重置GC连接状态
        this.currentLobbyId = null;    // 重置房间ID
        this.lobbyCreatedAt = null;    // 重置房间创建时间
        this.missingSince = 0;
        
        if (err.message === 'LoggedInElsewhere') {
            this.error(`账号在其他地方登录，已放弃`);
            this.state = 'ABANDONED';
            return;
        }
        
        if (err.message === 'RateLimitExceeded') {
            this.log(`Steam 限流，60秒后重试`);
            setTimeout(() => this.start(), 60000);
            return;
        }
        
        // 网络错误重试（使用相同代理，无限重试，固定30秒间隔）
        if (err.message.includes('timed out') || err.message.includes('ETIMEDOUT')) {
            this.retryCount++;
            this.log(`网络超时，30秒后重试`);
            setTimeout(() => this.start(), 30000);
        }
    }

    start() {
        if (this.state === 'ABANDONED') return;
        
        // 防止重复登录
        if (this.state === 'LOGGING_IN') {
            return;
        }
        
        // 如果 Steam 已经登录（有steamID），只需重新连接GC
        if (this.client.steamID) {
            this.log('♻️ Steam已登录，重新连接GC...');
            this.state = 'ONLINE';
            this.is_gc_connected = false;
            this.client.gamesPlayed([this.settings.target_app_id]);
            setTimeout(() => this.connectGC(), 2000);
            return;
        }
        
        this.state = 'LOGGING_IN';
        this.log(`🔐 开始登录...`);
        
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
            } catch (err) {
                this.error(`生成2FA代码失败: ${err.message}`);
            }
        }
        
        this.client.logOn(logOnOptions);
    }

    setupListeners() {
        this.client.removeAllListeners('loggedOn');
        this.client.removeAllListeners('appLaunched');
        this.client.removeAllListeners('receivedFromGC');
        
        this.client.on('loggedOn', () => {
            this.log('✅ Steam 登录成功');
            this.retryCount = 0;
            this.state = 'ONLINE';
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
        });

        this.client.on('appLaunched', (appid) => {
            if (appid === this.settings.target_app_id) {
                this.log('🎮 Dota 2 启动');
                setTimeout(() => this.connectGC(), 2000);
            }
        });

        this.client.on('receivedFromGC', (appid, msgType, payload) => {
            if (this.state !== 'ABANDONED') {
                this.handleGCMessage(appid, msgType, payload);
            }
        });
    }

    connectGC() {
        if (this.state === 'ABANDONED') return;
        this.log('📡 连接 GC...');
        this.sendHello();
        
        const helloInterval = setInterval(() => { 
            if (this.state === 'ABANDONED') {
                clearInterval(helloInterval);
                return;
            }
            if (!this.is_gc_connected) this.sendHello(); 
            else clearInterval(helloInterval);
        }, 5000);
    }

    sendHello() {
        try {
            const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
            const message = CMsgClientHello.create(payload);
            const buffer = CMsgClientHello.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    // 创建公开房间
    createPublicRoom() {
        if (this.state === 'IN_LOBBY') {
            this.log('⚠️ 已在房间中，先离开');
            this.leaveLobby();
            setTimeout(() => this.createPublicRoom(), 2000);
            return;
        }

        this.log('🏠 创建公开房间 (无密码)...');
        
        // 先清理可能的残留状态
        this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
        
        setTimeout(() => {
            try {
                const gameIdLong = Long.fromString(this.settings.custom_game_id, true);
                const regions = this.settings.server_regions || [14];
                const selectedRegion = regions[Math.floor(Math.random() * regions.length)];
                
                const detailsPayload = {
                    customGameId: gameIdLong,        
                    gameName: "",
                    serverRegion: selectedRegion, 
                    gameMode: 15,                    
                    customMaxPlayers: this.settings.max_players_per_room || 23,
                    customMinPlayers: 1,
                    allowSpectating: true,
                    allchat: true,
                    fillWithBots: false,
                    allowCheats: false,
                    visibility: 0, // 公开可见
                    passKey: "", // 无密码！
                    customMapName: "zudui_team_map",
                    customGameCrc: Long.fromString(this.knownCrc, true),
                    customGameTimestamp: this.knownTimestamp
                };
                const lobbyDetails = CMsgPracticeLobbySetDetails.create(detailsPayload);

                const createPayload = {
                    searchKey: "",
                    passKey: "", // 无密码！
                    clientVersion: 0,
                    lobbyDetails: lobbyDetails
                };

                const message = CMsgPracticeLobbyCreate.create(createPayload);
                const buffer = CMsgPracticeLobbyCreate.encode(message).finish();
                
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
                
                const regionName = RegionNameMap[selectedRegion] || `Reg:${selectedRegion}`;
                this.log(`🌐 创建公开房，区域: ${regionName}`);
                
                this.state = 'CREATING_LOBBY';
                
                // 创建超时检测
                setTimeout(() => {
                    if (this.state === 'CREATING_LOBBY') {
                        this.log('⚠️ 创建房间超时，重试...');
                        this.createPublicRoom();
                    }
                }, 15000);
                
            } catch (err) {
                this.error(`创建公开房失败: ${err.message}`);
            }
        }, 1000);
    }

    // 离开房间
    leaveLobby() {
        this.log('🚪 离开房间...');
        
        try {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        } catch (err) {}
        
        const oldLobbyId = this.currentLobbyId;
        this.currentLobbyId = null;
        this.lobbyCreatedAt = null;
        this.missingSince = 0;
        this.state = 'ONLINE';
        
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        
        if (oldLobbyId) {
            this.log(`✅ 已离开房间: ${oldLobbyId.toString()}`);
        }
    }

    handleGCMessage(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!this.is_gc_connected) {
                this.is_gc_connected = true;
                this.log('✅ GC 连接成功');
            }
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
            try {
                const status = CMsgReadyUpStatus.decode(payload);
                if (status.lobbyId) this.currentLobbyId = status.lobbyId;
                setTimeout(() => this.sendReadyUp(this.currentLobbyId), 200);
            } catch(e) {}
        }
        else if (cleanMsgType === k_EMsgGCJoinableCustomLobbiesResponse) {
            try {
                const response = CMsgJoinableCustomLobbiesResponse.decode(payload);
                const lobbies = response.lobbies || [];
                if (this._lobbyQueryFinish) {
                    this._lobbyQueryFinish(lobbies, { ok: true });
                }
            } catch (e) {}
        }
    }
    
    // 查询房间列表
    queryLobbyList(callback) {
        // 兼容旧接口：只返回 lobbies 数组
        this.queryLobbyListDetailed((lobbies) => callback(lobbies));
    }

    // 查询房间列表（并发安全 + 返回 meta，用于判断查询是否有效）
    queryLobbyListDetailed(callback) {
        if (!this.is_gc_connected) {
            callback([], { ok: false, reason: 'no_gc' });
            return;
        }

        this._lobbyQueryCallbacks.push(callback);

        // 已有请求在飞，直接排队等待同一结果
        if (this._lobbyQueryInFlight) return;
        this._lobbyQueryInFlight = true;

        const timeoutMs = this.settings.lobby_query_timeout_ms || 20000;
        let finished = false;

        const finish = (lobbies, meta) => {
            if (finished) return;
            finished = true;

            this._lobbyQueryInFlight = false;
            this._lobbyQueryFinish = null;

            if (this._lobbyQueryTimeoutHandle) {
                clearTimeout(this._lobbyQueryTimeoutHandle);
                this._lobbyQueryTimeoutHandle = null;
            }

            const callbacks = this._lobbyQueryCallbacks;
            this._lobbyQueryCallbacks = [];

            callbacks.forEach((cb) => {
                try { cb(lobbies, meta); } catch (e) {}
            });
        };

        this._lobbyQueryFinish = finish;

        try {
            const gameId = this.settings.custom_game_id;
            const gameIdLong = Long.fromString(gameId, true);
            const payload = { server_region: 0, custom_game_id: gameIdLong };
            const message = CMsgJoinableCustomLobbiesRequest.create(payload);
            const buffer = CMsgJoinableCustomLobbiesRequest.encode(message).finish();

            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCJoinableCustomLobbiesRequest | k_EMsgProtoMask, {}, buffer);
        } catch (err) {
            finish([], { ok: false, reason: 'send_error' });
            return;
        }

        this._lobbyQueryTimeoutHandle = setTimeout(() => {
            finish([], { ok: false, reason: 'timeout' });
        }, timeoutMs);
    }

    processLobbyData(objectData) {
        if (!objectData || objectData.length === 0) return;
        
        try {
            const lobby = CSODOTALobby.decode(objectData);
            const lobbyId = lobby.lobbyId;
            const memberCount = (lobby.allMembers || []).length;
            
            if (lobbyId && this.state === 'CREATING_LOBBY') {
                this.currentLobbyId = lobbyId;
                this.lobbyCreatedAt = Date.now();
                this.state = 'IN_LOBBY';
                
                logSuccess(`展示主号${this.label}`, `公开房创建成功: ${lobbyId.toString()} | 人数: ${memberCount}`);
                
                // 设置队伍并就位
                this.onEnterLobby();
            }
        } catch (e) {}
    }

    onEnterLobby() {
        // 设置队伍
        setTimeout(() => {
            const teamMsg = CMsgPracticeLobbySetTeamSlot.create({ team: DOTA_GC_TEAM.DOTA_GC_TEAM_GOOD_GUYS, slot: 0 });
            const teamBuf = CMsgPracticeLobbySetTeamSlot.encode(teamMsg).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbySetTeamSlot | k_EMsgProtoMask, {}, teamBuf);
            
            setTimeout(() => this.sendReadyUp(this.currentLobbyId), 500);
        }, 1000);

        // 心跳保活
        if (this.ready_up_heartbeat) clearInterval(this.ready_up_heartbeat);
        this.ready_up_heartbeat = setInterval(() => {
            this.sendReadyUp(this.currentLobbyId);
        }, 30000);
    }

    sendReadyUp(lobbyId) {
        try {
            const payload = {
                state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                hardware_specs: getHardwareSpecs()
            };
            if (lobbyId) payload.ready_up_key = lobbyId;
            const message = CMsgReadyUp.create(payload);
            const buffer = CMsgReadyUp.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    cleanup() {
        if (this.ready_up_heartbeat) clearInterval(this.ready_up_heartbeat);
        
        try {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        } catch (err) {}
        
        try {
            this.client.logOff();
        } catch (err) {}
    }
}

// ============================================
// ShowcaseManager - 展示车队管理器
// ============================================
class ShowcaseManager {
    constructor(config) {
        this.settings = config.global_settings;
        this.showcaseLeaders = config.showcase_leaders;
        this.bots = [];
        // Presence mode（简单稳定模式）- 仅保留这一套逻辑，避免双实现带来的排查成本
        this.presenceTimers = [];
        this.presenceLock = false;
    }

    start() {
        logSection('展示车队启动');
        
        if (this.showcaseLeaders.length < 2) {
            logError('Showcase', '展示主号数量不足，需要至少2个主号');
            process.exit(1);
        }
        
        logInfo('Showcase', `展示主号A: ${this.showcaseLeaders[0].username}`);
        logInfo('Showcase', `展示主号B: ${this.showcaseLeaders[1].username}`);

        // 创建2个展示主号Bot
        this.showcaseLeaders.forEach((account, idx) => {
            const bot = new ShowcaseBot(account, this.settings, idx);
            this.bots.push(bot);
        });

        // 两个主号都先登录预热（A/B都需要随时可用）
        logInfo('Showcase', `🔄 启动展示主号A/B 预热登录（仅登录，按需创建房间）...`);
        this.bots[0].start();
        this.bots[1].start();

        this.waitForGCOnly(this.bots[0]);
        this.waitForGCOnly(this.bots[1]);

        // 仅保留 Presence 模式（按需创建 + 结算1个 + 冷却）
        this.startPresenceMode();
    }
    
    // 仅等待GC连接（用于预热，不创建房间）
    waitForGCOnly(bot) {
        const checkInterval = setInterval(() => {
            if (bot.is_gc_connected) {
                clearInterval(checkInterval);
                logSuccess('Showcase', `展示主号${bot.label} 预热完成，GC已连接`);
            }
        }, 1000);
        
        // 超时处理
        setTimeout(() => {
            clearInterval(checkInterval);
            if (!bot.is_gc_connected) {
                logWarning('Showcase', `展示主号${bot.label} 预热超时，将在轮换时重试`);
            }
        }, 60000);
    }

    // ========== Presence Mode（简单稳定模式）==========
    startPresenceMode() {
        // 规则：
        // - A/B 每2分钟查询一次，错开1分钟
        // - 查询无效（超时/空）不触发
        // - 如果查询有效且看不到“本主号的房间”，则创建新房 + 结算(解散)1个最老挂机房
        // - 创建/结算后进入5分钟冷却，不做任何操作

        const intervalMs = (this.settings.presence_query_interval_minutes || 2) * 60 * 1000;
        const offsetMs = (this.settings.presence_query_offset_minutes || 1) * 60 * 1000;
        const cooldownMs = (this.settings.presence_cooldown_minutes || 5) * 60 * 1000;

        logInfo('Showcase', `✅ 已启用 Presence 模式：查询间隔=${intervalMs / 60000}m，AB错开=${offsetMs / 60000}m，冷却=${cooldownMs / 60000}m，结算=1个`);

        const scheduleBot = (bot, initialDelay) => {
            const timer = setTimeout(() => {
                // 先立即执行一次，然后再进入 interval
                this.presenceTick(bot, cooldownMs);
                const t2 = setInterval(() => this.presenceTick(bot, cooldownMs), intervalMs);
                this.presenceTimers.push(t2);
            }, initialDelay);
            this.presenceTimers.push(timer);
        };

        // A 立即开始；B 延迟 offset
        scheduleBot(this.bots[0], 0);
        scheduleBot(this.bots[1], offsetMs);
    }

    async presenceTick(bot, cooldownMs) {
        // 严格串行：避免 A/B 同时创建/结算导致更多不可控因素
        if (this.presenceLock) return;

        // 未连接GC、或在冷却期 → 不操作
        if (!bot.is_gc_connected) return;
        if (Date.now() < (bot.cooldownUntil || 0)) return;

        this.presenceLock = true;
        try {
            // 查询（带 meta）
            const { lobbies, ok } = await this.queryLobbiesDetailed(bot);

            // 查询无效 或 空列表（按你的规则：不触发任何动作）
            if (!ok || !lobbies || lobbies.length === 0) {
                logWarning('Showcase', `主号${bot.label} 查询无效/空列表，跳过本轮（不创建/不结算）`);
                return;
            }

            const targetGameId = this.settings.custom_game_id;
            const filteredLobbies = lobbies.filter(lobby => lobby.customGameId?.toString() === targetGameId);
            const lobbyCount = filteredLobbies.length;
            const minLobbyCountForRotation = this.settings.min_lobby_count_for_rotation || 75;

            const myLobbyId = bot.currentLobbyId?.toString();
            const inList = myLobbyId ? filteredLobbies.some(l => l.lobbyId?.toString() === myLobbyId) : false;

            // rotation_cycle_minutes：房间“有效活跃统计窗口”（你定义的语义）
            // 只要房间存在时间超过该阈值，就必须刷新（重新创建新房间），否则就算房间还在也没有展示活跃意义
            const rotationCycleMinutes = this.settings.rotation_cycle_minutes || 0;
            const roomAgeMin = this.getRoomAge(bot);
            const expiredByAge = !!(myLobbyId && rotationCycleMinutes > 0 && roomAgeMin >= rotationCycleMinutes);

            logInfo(
                'Showcase',
                `Presence检查 主号${bot.label}: 当前房间=${myLobbyId || '无'} | 游廊=${lobbyCount} | 阈值=${minLobbyCountForRotation} | 在展示位=${inList ? '是' : '否'} | 房龄=${roomAgeMin}m/${rotationCycleMinutes || 0}m`
            );

            // ===== 稳定护栏：避免单次/短暂查询抖动导致误重建 =====
            // 注意：rotation_cycle_minutes 只表示“房龄到期必须刷新”，不能用于“消失阈值”。
            // 这里用“两次查询确认窗口”：默认 presence_query_interval_minutes * 2（例如 2min * 2 = 4min），不新增配置项。
            if (myLobbyId && inList) {
                bot.missingSince = 0; // 已看到，清零
            }
            if (myLobbyId && !inList) {
                const queryIntervalMin = this.settings.presence_query_interval_minutes || 2;
                const missingGraceMinutes = Math.max(2, queryIntervalMin * 2);
                const missingThresholdMs = missingGraceMinutes * 60 * 1000;
                const now = Date.now();
                if (!bot.missingSince) bot.missingSince = now;
                const missingMs = now - bot.missingSince;
                const missingMinutes = Math.floor(missingMs / 60000);

                // 未超过“二次确认窗口”时不触发创建（稳定优先）
                // 但如果房龄已过期（expiredByAge），则必须刷新，不能被此护栏挡住
                if (!expiredByAge && missingMs < missingThresholdMs) {
                    logInfo('Showcase', `主号${bot.label} 暂时不在展示位（消失${missingMinutes}m<${missingGraceMinutes}m），等待下轮...`);
                    return;
                }
                // 超过阈值：允许按原逻辑继续触发创建
            }

            // 没有房间 / 房龄过期(>=rotation_cycle_minutes) / (消失超过二次确认窗口后)不在列表 → 创建新房间 + 结算1个
            if (!myLobbyId || expiredByAge || !inList) {
                if (!myLobbyId) {
                    logInfo('Showcase', `主号${bot.label} 当前无房间，创建新房...`);
                } else if (expiredByAge) {
                    logInfo('Showcase', `主号${bot.label} 房间已过期(${roomAgeMin}m>=${rotationCycleMinutes}m)，强制刷新创建新房...`);
                } else {
                    logInfo('Showcase', `主号${bot.label} 未在展示位，创建新房并结算 1 个最老挂机房...`);
                }

                // 如果有旧房间，先离开（确保“新房”是新的 lobbyId）
                if (bot.currentLobbyId) {
                    bot.leaveLobby();
                    await new Promise(r => setTimeout(r, 2000));
                }

                bot.createPublicRoom();
                const created = await this.waitForRoomCreation(bot, 20000);
                if (!created || !bot.currentLobbyId) {
                    logError('Showcase', `主号${bot.label} 创建新房失败，本轮结束`);
                    return;
                }

                const newLobbyId = bot.currentLobbyId.toString();
                logSuccess('Showcase', `主号${bot.label} 新房创建成功: ${newLobbyId}`);

                // 结算：仅当展示位接近上限（>=阈值）才需要解散 1 个最老挂机房腾位
                if (lobbyCount >= minLobbyCountForRotation) {
                    const showcaseLobbyIds = [this.bots[0].currentLobbyId?.toString(), this.bots[1].currentLobbyId?.toString()].filter(Boolean);
                    const oldestRooms = this.findOldestRoomsExcluding(lobbies, 1, showcaseLobbyIds);
                    if (oldestRooms.length > 0) {
                        logInfo('Showcase', `结算：房间数达到阈值(${lobbyCount}>=${minLobbyCountForRotation})，通知挂机车队解散 1 个最老房间...`);
                        logInfo('Showcase', `   1. ${oldestRooms[0].lobbyId} (创建时间: ${new Date(oldestRooms[0].createdAt * 1000).toLocaleTimeString()})`);
                        await this.notifyFarmingFleet([oldestRooms[0].lobbyId.toString()]);
                    } else {
                        logInfo('Showcase', `结算：房间数达到阈值，但未找到可解散的挂机房间（跳过）`);
                    }
                } else {
                    logInfo('Showcase', `结算：房间数未达阈值(${lobbyCount}<${minLobbyCountForRotation})，无需解散（跳过）`);
                }

                // 冷却 5 分钟（严格不操作）
                bot.cooldownUntil = Date.now() + cooldownMs;
                logInfo('Showcase', `主号${bot.label} 进入冷却 ${(cooldownMs / 60000)} 分钟`);
            }
        } catch (e) {
            logWarning('Showcase', `PresenceTick 异常: ${e.message}`);
        } finally {
            this.presenceLock = false;
        }
    }

    queryLobbiesDetailed(bot) {
        return new Promise((resolve) => {
            bot.queryLobbyListDetailed((lobbies, meta) => {
                resolve({ lobbies, ok: !!meta?.ok, meta });
            });
        });
    }
    
    // 找到最老的N个挂机房间（排除当前展示房间）- 兼容旧接口
    findOldestRooms(lobbies, count, currentShowcaseLobbyId) {
        const excludeIds = currentShowcaseLobbyId ? [currentShowcaseLobbyId.toString()] : [];
        return this.findOldestRoomsExcluding(lobbies, count, excludeIds);
    }
    
    // 找到最老的N个挂机房间（排除多个展示房间）
    findOldestRoomsExcluding(lobbies, count, excludeLobbyIds) {
        const excludeSet = new Set(excludeLobbyIds.filter(id => id));
        const targetGameId = this.settings.custom_game_id;
        
        // 过滤掉展示房间，并按创建时间排序（最老的在前）
        const sortedLobbies = lobbies
            .filter(lobby => {
                // 过滤游戏ID，只保留当前游戏的房间
                const gameId = lobby.customGameId?.toString();
                if (gameId !== targetGameId) return false;
                
                const lobbyIdStr = lobby.lobbyId?.toString();
                // 排除所有展示房间
                if (excludeSet.has(lobbyIdStr)) return false;
                // 只保留有密码的房间（挂机房间通常有密码）
                return lobby.hasPassKey === true;
            })
            .map(lobby => ({
                lobbyId: lobby.lobbyId,
                createdAt: lobby.lobbyCreationTime || 0,
                memberCount: lobby.memberCount || 0
            }))
            .sort((a, b) => a.createdAt - b.createdAt); // 按创建时间升序（最老的在前）
        
        return sortedLobbies.slice(0, count);
    }
    
    // 通知挂机车队解散指定房间
    async notifyFarmingFleet(roomIds) {
        return new Promise((resolve) => {
            const postData = JSON.stringify({ roomIds });
            
            const options = {
                hostname: '127.0.0.1',
                port: 3000,
                path: '/api/dissolve_rooms',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        logSuccess('Showcase', `   已通知挂机车队解散房间`);
                    } else {
                        logWarning('Showcase', `   通知挂机车队失败: ${res.statusCode}`);
                    }
                    resolve();
                });
            });
            
            req.on('error', (err) => {
                logWarning('Showcase', `   无法连接到 Web 服务器: ${err.message}`);
                resolve();
            });
            
            req.write(postData);
            req.end();
        });
    }

    getRoomAge(bot) {
        if (!bot.lobbyCreatedAt) return 0;
        return Math.floor((Date.now() - bot.lobbyCreatedAt) / 60000);
    }

    waitForGCConnection(bot, timeout) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                if (bot.is_gc_connected) {
                    clearInterval(checkInterval);
                    resolve(true);
                } else if (Date.now() - startTime > timeout) {
                    clearInterval(checkInterval);
                    resolve(false);
                }
            }, 500);
        });
    }

    waitForRoomCreation(bot, timeout) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                if (bot.currentLobbyId && bot.state === 'IN_LOBBY') {
                    clearInterval(checkInterval);
                    resolve(true);
                } else if (Date.now() - startTime > timeout) {
                    clearInterval(checkInterval);
                    resolve(false);
                }
            }, 500);
        });
    }

    cleanup() {
        logInfo('Showcase', '🧹 清理资源...');

        // presence timers
        if (this.presenceTimers && this.presenceTimers.length > 0) {
            this.presenceTimers.forEach((t) => {
                try { clearTimeout(t); } catch (e) {}
                try { clearInterval(t); } catch (e) {}
            });
            this.presenceTimers = [];
        }
        
        this.bots.forEach(bot => bot.cleanup());
        
        logSuccess('Showcase', '展示车队已停止');
    }

    getStatus() {
        const botA = this.bots[0];
        const botB = this.bots[1];
        const now = Date.now();

        const cooldownLeftA = botA?.cooldownUntil && botA.cooldownUntil > now ? Math.ceil((botA.cooldownUntil - now) / 60000) : 0;
        const cooldownLeftB = botB?.cooldownUntil && botB.cooldownUntil > now ? Math.ceil((botB.cooldownUntil - now) / 60000) : 0;
        return {
            lobbyA: botA.currentLobbyId ? `${botA.currentLobbyId.toString().slice(-6)}(${this.getRoomAge(botA)}m)` : '无',
            lobbyB: botB.currentLobbyId ? `${botB.currentLobbyId.toString().slice(-6)}(${this.getRoomAge(botB)}m)` : '无',
            cooldownA: cooldownLeftA ? `${cooldownLeftA}m` : '0m',
            cooldownB: cooldownLeftB ? `${cooldownLeftB}m` : '0m'
        };
    }
    
    // 查询当前游戏的房间数量
    async queryGameLobbyCount() {
        const bot = this.bots.find(b => b && b.is_gc_connected);
        if (!bot) {
            return -1; // 未连接
        }
        
        try {
            const { lobbies, ok } = await this.queryLobbiesDetailed(bot);
            if (!ok || !lobbies) return -1;
            const targetGameId = this.settings.custom_game_id;
            const filteredLobbies = lobbies.filter(lobby => {
                const gameId = lobby.customGameId?.toString();
                return gameId === targetGameId;
            });
            return filteredLobbies.length;
        } catch (err) {
            return -1;
        }
    }
}

// ============================================
// Main Entry
// ============================================
const args = process.argv.slice(2);
const isDebugMode = args.includes('debug');

// 解析配置文件路径
let configPath = path.join(projectRoot, 'config', 'config_showcase.json');
const configArg = args.find(arg => arg.startsWith('--config='));
if (configArg) {
    const customPath = configArg.split('=')[1];
    configPath = path.resolve(projectRoot, customPath);
}

let config;
try {
    const rawContent = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(rawContent);
    logInfo('System', `📄 配置文件: ${configPath}`);
} catch (e) {
    logError('System', `读取配置失败: ${e.message}`);
    logError('System', `配置文件路径: ${configPath}`);
    process.exit(1);
}

config.global_settings.debug_mode = isDebugMode;

// 确保共享验证数据目录存在
const sharedDataPath = config.global_settings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);
if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
    logInfo('System', `📁 创建目录: ${steamDataDir}`);
}

logSection('Dota2 展示车队 v1.0');
logInfo('System', `模式: ${isDebugMode ? '调试模式' : '生产模式'}`);
logInfo('System', `游戏ID: ${config.global_settings.custom_game_id}`);

// 验证配置
if (!config.showcase_leaders || config.showcase_leaders.length < 2) {
    logError('System', '需要至少2个展示主号！');
    logError('System', '请检查 config_showcase.json 中的 showcase_leaders 配置');
    process.exit(1);
}

// 创建并启动管理器
const manager = new ShowcaseManager(config);
manager.start();

// 状态监控（每分钟输出一次）
setInterval(async () => {
    const status = manager.getStatus();
    const lobbyCount = await manager.queryGameLobbyCount();
    const lobbyCountStr = lobbyCount >= 0 ? `${lobbyCount}` : '查询中';
    logInfo('Status', `模式: Presence | 房间A: ${status.lobbyA} 冷却:${status.cooldownA} | 房间B: ${status.lobbyB} 冷却:${status.cooldownB} | 游廊: ${lobbyCountStr}个`);
}, 60000);

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

// 监听 stdin 的 exit 命令（用于 Web 控制台停止）
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
    const cmd = data.toString().trim().toLowerCase();
    if (cmd === 'exit' || cmd === 'stop' || cmd === 'quit') {
        logSection('收到退出命令');
        manager.cleanup();
        setTimeout(() => {
            logSuccess('System', '程序已安全退出');
            process.exit(0);
        }, 3000);
    }
});


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
}

function logInfo(category, message) {
    console.log(`[${formatTime()}] [${category}] ${message}`);
}

function logSuccess(category, message) {
    console.log(`[${formatTime()}] [${category}] ✅ ${message}`);
}

function logWarning(category, message) {
    console.log(`[${formatTime()}] [${category}] ⚠️ ${message}`);
}

function logError(category, message) {
    console.log(`[${formatTime()}] [${category}] ❌ ${message}`);
}

function logDebug(category, message, debugMode) {
    if (debugMode) {
        console.log(`[${formatTime()}] [${category}] 🔍 ${message}`);
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

        // CRC 数据
        this.knownCrc = "1396649696593898392";
        this.knownTimestamp = 1763646905;
        
        // 房间查询回调
        this.lobbyQueryCallback = null;

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
        
        // 网络错误重试（使用相同代理）
        if (err.message.includes('timed out') || err.message.includes('ETIMEDOUT')) {
            this.retryCount++;
            if (this.retryCount < 5) {
                const delay = Math.min(this.retryCount * 5000, 30000);
                this.log(`网络超时，${delay/1000}秒后重试 (${this.retryCount}/5)`);
                setTimeout(() => this.start(), delay);
            } else {
                this.error(`重试次数过多，放弃`);
            }
        }
    }

    start() {
        if (this.state === 'ABANDONED') return;
        
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
                if (this.lobbyQueryCallback) {
                    this.lobbyQueryCallback(lobbies);
                    this.lobbyQueryCallback = null;
                }
            } catch (e) {}
        }
    }
    
    // 查询房间列表
    queryLobbyList(callback) {
        if (!this.is_gc_connected) {
            callback([]);
            return;
        }
        
        this.lobbyQueryCallback = callback;
        
        try {
            const gameId = this.settings.custom_game_id;
            const gameIdLong = Long.fromString(gameId, true);
            const payload = { server_region: 0, custom_game_id: gameIdLong };
            const message = CMsgJoinableCustomLobbiesRequest.create(payload);
            const buffer = CMsgJoinableCustomLobbiesRequest.encode(message).finish();
            
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCJoinableCustomLobbiesRequest | k_EMsgProtoMask, {}, buffer);
        } catch (err) {
            callback([]);
        }
        
        // 超时处理
        setTimeout(() => {
            if (this.lobbyQueryCallback === callback) {
                this.lobbyQueryCallback = null;
                callback([]);
            }
        }, 5000);
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
        this.currentActiveIndex = 0; // 当前活跃的展示主号 (0=A, 1=B)
        this.rotationTimer = null;
        this.rotationCycleMinutes = this.settings.rotation_cycle_minutes || 25;
        this.rotationCount = 0;
        this.isRotating = false;
    }

    start() {
        logSection('展示车队启动');
        
        if (this.showcaseLeaders.length < 2) {
            logError('Showcase', '展示主号数量不足，需要至少2个主号');
            process.exit(1);
        }
        
        logInfo('Showcase', `展示主号A: ${this.showcaseLeaders[0].username}`);
        logInfo('Showcase', `展示主号B: ${this.showcaseLeaders[1].username}`);
        logInfo('Showcase', `轮换周期: ${this.rotationCycleMinutes} 分钟`);
        
        // 创建2个展示主号Bot
        this.showcaseLeaders.forEach((account, idx) => {
            const bot = new ShowcaseBot(account, this.settings, idx);
            this.bots.push(bot);
        });
        
        // 只启动主号A，创建第一个公开房
        logInfo('Showcase', `🚀 启动展示主号A，创建初始公开房...`);
        this.bots[0].start();
        
        // 等待主号A连接GC后创建房间
        this.waitForGCAndCreateRoom(this.bots[0]);
        
        // 启动轮换定时器
        this.startRotationTimer();
    }

    waitForGCAndCreateRoom(bot) {
        const checkInterval = setInterval(() => {
            if (bot.is_gc_connected) {
                clearInterval(checkInterval);
                logInfo('Showcase', `展示主号${bot.label} GC已连接，创建公开房...`);
                bot.createPublicRoom();
            }
        }, 1000);
        
        // 超时处理
        setTimeout(() => {
            clearInterval(checkInterval);
            if (!bot.is_gc_connected) {
                logError('Showcase', `展示主号${bot.label} GC连接超时`);
            }
        }, 60000);
    }

    startRotationTimer() {
        const rotationMs = this.rotationCycleMinutes * 60 * 1000;
        
        logInfo('Showcase', `⏱️ 轮换定时器已启动`);
        logInfo('Showcase', `   下次轮换: ${this.rotationCycleMinutes} 分钟后`);
        
        this.rotationTimer = setInterval(() => {
            this.executeRotation();
        }, rotationMs);
    }

    async executeRotation() {
        if (this.isRotating) {
            logWarning('Showcase', '轮换正在进行中，跳过本次');
            return;
        }
        
        this.isRotating = true;
        this.rotationCount++;
        
        const currentBot = this.bots[this.currentActiveIndex];
        const nextIndex = (this.currentActiveIndex + 1) % 2;
        const nextBot = this.bots[nextIndex];
        
        logSection(`第 ${this.rotationCount} 次轮换`);
        logInfo('Showcase', `当前活跃: 主号${currentBot.label} (${currentBot.account.username})`);
        logInfo('Showcase', `房间存活: ${this.getRoomAge(currentBot)} 分钟`);
        logInfo('Showcase', `即将切换: 主号${nextBot.label} (${nextBot.account.username})`);
        
        try {
            // ========== 主号轮换（必须执行）==========
            
            // 步骤1: 确保新主号已连接
            logInfo('Showcase', `[步骤1/3] 确保主号${nextBot.label}已连接...`);
            if (!nextBot.is_gc_connected) {
                logInfo('Showcase', `   主号${nextBot.label}尚未连接，启动登录...`);
                nextBot.start();
                await this.waitForGCConnection(nextBot, 30000);
            }
            
            if (!nextBot.is_gc_connected) {
                logError('Showcase', `主号${nextBot.label}连接失败，取消本次轮换`);
                this.isRotating = false;
                return;
            }
            logSuccess('Showcase', `   主号${nextBot.label}已就绪`);
            
            // 步骤2: 新主号创建公开房
            logInfo('Showcase', `[步骤2/3] 主号${nextBot.label}创建新公开房...`);
            nextBot.createPublicRoom();
            await this.waitForRoomCreation(nextBot, 20000);
            
            if (!nextBot.currentLobbyId) {
                logError('Showcase', `新公开房创建失败，取消本次轮换`);
                this.isRotating = false;
                return;
            }
            logSuccess('Showcase', `   新公开房: ${nextBot.currentLobbyId.toString()}`);
            
            // 步骤3: 解散旧公开房
            logInfo('Showcase', `[步骤3/3] 解散主号${currentBot.label}的旧公开房...`);
            if (currentBot.currentLobbyId) {
                const oldLobbyId = currentBot.currentLobbyId.toString();
                currentBot.leaveLobby();
                logSuccess('Showcase', `   已解散: ${oldLobbyId}`);
            }
            
            // 更新活跃索引
            this.currentActiveIndex = nextIndex;
            
            logSuccess('Showcase', `主号轮换完成，当前活跃: 主号${nextBot.label}`);
            
            // ========== 小号房间处理 ==========
            
            // 查询房间列表（带重试，确保主号房间已被GC收录）
            logInfo('Showcase', `查询游廊房间列表...`);
            const targetGameId = this.settings.custom_game_id;
            const showcaseLobbyId = nextBot.currentLobbyId?.toString();
            const minLobbyCountForRotation = this.settings.min_lobby_count_for_rotation || 75;
            const maxRetries = 3;
            const retryDelay = 2000; // 2秒
            
            let lobbies, filteredLobbies, lobbyCount, showcaseInList;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                lobbies = await this.queryLobbies(nextBot);
                filteredLobbies = lobbies.filter(lobby => {
                    const gameId = lobby.customGameId?.toString();
                    return gameId === targetGameId;
                });
                lobbyCount = filteredLobbies.length;
                showcaseInList = filteredLobbies.some(lobby => lobby.lobbyId?.toString() === showcaseLobbyId);
                
                if (showcaseInList) {
                    if (attempt > 1) {
                        logInfo('Showcase', `第${attempt}次查询成功，主号房间已在列表中`);
                    }
                    break;
                }
                
                if (attempt < maxRetries) {
                    logInfo('Showcase', `主号房间暂未在列表中（第${attempt}次查询），${retryDelay/1000}秒后重试...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
            
            logInfo('Showcase', `当前游廊房间: ${lobbyCount} 个，阈值: ${minLobbyCountForRotation}，主号房间在列表中: ${showcaseInList ? '是' : '否'}`);
            
            // 情况3: 重试后主号仍不在列表中 → 真正的展示位满了，强制解散
            if (!showcaseInList) {
                logWarning('Showcase', `⚠️ 多次查询后主号房间仍不在列表中（展示位已满），强制解散小号房间腾出位置...`);
                const oldestRooms = this.findOldestRooms(lobbies, 5, nextBot.currentLobbyId);
                if (oldestRooms.length > 0) {
                    logInfo('Showcase', `通知挂机车队解散 ${oldestRooms.length} 个最老房间...`);
                    oldestRooms.forEach((room, idx) => {
                        logInfo('Showcase', `   ${idx + 1}. ${room.lobbyId} (创建时间: ${new Date(room.createdAt * 1000).toLocaleTimeString()})`);
                    });
                    await this.notifyFarmingFleet(oldestRooms.map(r => r.lobbyId.toString()));
                } else {
                    logWarning('Showcase', `没有找到可解散的挂机房间`);
                }
            }
            // 情况2: 房间数 >= 阈值 → 解散5个最老的小号
            else if (lobbyCount >= minLobbyCountForRotation) {
                const oldestRooms = this.findOldestRooms(lobbies, 5, nextBot.currentLobbyId);
                if (oldestRooms.length > 0) {
                    logInfo('Showcase', `通知挂机车队解散 ${oldestRooms.length} 个最老房间...`);
                    oldestRooms.forEach((room, idx) => {
                        logInfo('Showcase', `   ${idx + 1}. ${room.lobbyId} (创建时间: ${new Date(room.createdAt * 1000).toLocaleTimeString()})`);
                    });
                    await this.notifyFarmingFleet(oldestRooms.map(r => r.lobbyId.toString()));
                } else {
                    logInfo('Showcase', `没有找到需要解散的挂机房间`);
                }
            }
            // 情况1: 房间数 < 阈值 → 不解散
            else {
                logInfo('Showcase', `房间数量未达阈值，跳过解散小号房间`);
            }
            
            logSection(`轮换完成`);
            logInfo('Showcase', `下次轮换: ${this.rotationCycleMinutes} 分钟后`);
            
        } catch (err) {
            logError('Showcase', `轮换失败: ${err.message}`);
        }
        
        this.isRotating = false;
    }
    
    // 查询房间列表
    queryLobbies(bot) {
        return new Promise((resolve) => {
            bot.queryLobbyList((lobbies) => {
                resolve(lobbies);
            });
        });
    }
    
    // 找到最老的N个挂机房间（排除当前展示房间）
    findOldestRooms(lobbies, count, currentShowcaseLobbyId) {
        const currentShowcaseId = currentShowcaseLobbyId?.toString();
        const targetGameId = this.settings.custom_game_id;
        
        // 过滤掉当前展示房间，并按创建时间排序（最老的在前）
        const sortedLobbies = lobbies
            .filter(lobby => {
                // 过滤游戏ID，只保留当前游戏的房间
                const gameId = lobby.customGameId?.toString();
                if (gameId !== targetGameId) return false;
                
                const lobbyIdStr = lobby.lobbyId?.toString();
                // 排除当前展示房间
                if (lobbyIdStr === currentShowcaseId) return false;
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
        
        if (this.rotationTimer) {
            clearInterval(this.rotationTimer);
            this.rotationTimer = null;
        }
        
        this.bots.forEach(bot => bot.cleanup());
        
        logSuccess('Showcase', '展示车队已停止');
    }

    getStatus() {
        const currentBot = this.bots[this.currentActiveIndex];
        return {
            currentActive: `主号${currentBot.label}`,
            currentLobbyId: currentBot.currentLobbyId?.toString() || '无',
            roomAge: this.getRoomAge(currentBot),
            rotationCount: this.rotationCount,
            nextRotation: `${this.rotationCycleMinutes}分钟周期`
        };
    }
    
    // 查询当前游戏的房间数量
    async queryGameLobbyCount() {
        const currentBot = this.bots[this.currentActiveIndex];
        if (!currentBot || !currentBot.is_gc_connected) {
            return -1; // 未连接
        }
        
        try {
            const lobbies = await this.queryLobbies(currentBot);
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
logInfo('System', `轮换周期: ${config.global_settings.rotation_cycle_minutes || 25} 分钟`);

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
    logInfo('Status', `活跃: ${status.currentActive} | 房间: ${status.currentLobbyId} | 存活: ${status.roomAge}分钟 | 轮换次数: ${status.rotationCount} | 游廊房间: ${lobbyCountStr}`);
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


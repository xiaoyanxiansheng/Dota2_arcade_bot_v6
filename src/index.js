const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

// ============================================
// 项目根目录和代理加载
// ============================================
const projectRoot = path.join(__dirname, '..');
let proxies = [];
try {
    const proxiesPath = path.join(projectRoot, 'data', 'proxies.txt');
    if (fs.existsSync(proxiesPath)) {
        const content = fs.readFileSync(proxiesPath, 'utf8');
        proxies = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        console.log(`[System] 加载了 ${proxies.length} 个代理 IP`);
    }
} catch (e) {
    console.error("⚠️ 读取代理文件失败: " + e.message);
}

// ============================================
// GC 消息 ID 定义
// ============================================
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgGCAbandonCurrentGame = 7035;
const k_EMsgGCPracticeLobbyCreate = 7038;
const k_EMsgGCPracticeLobbyLeave = 7040;
const k_EMsgGCPracticeLobbyJoin = 7044;
const k_EMsgGCPracticeLobbyResponse = 7055;
const k_EMsgGCPracticeLobbyJoinResponse = 7113;
const k_EMsgGCJoinableCustomLobbiesRequest = 7468;
const k_EMsgGCJoinableCustomLobbiesResponse = 7469;
const k_EMsgGCReadyUp = 7070;
const k_EMsgGCReadyUpStatus = 7170;
const k_EMsgGCPracticeLobbySetTeamSlot = 7047;
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
let CMsgClientHello, CMsgPracticeLobbyJoin, CMsgPracticeLobbyJoinResponse, CMsgPracticeLobbyCreate, 
    CMsgPracticeLobbySetDetails, CMsgJoinableCustomLobbiesRequest, CMsgJoinableCustomLobbiesResponse, 
    CMsgPracticeLobbySetTeamSlot, CMsgReadyUp, CMsgReadyUpStatus, CSODOTALobby, CDOTAClientHardwareSpecs;
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
    CMsgJoinableCustomLobbiesRequest = root.lookupType("CMsgJoinableCustomLobbiesRequest");
    CMsgJoinableCustomLobbiesResponse = root.lookupType("CMsgJoinableCustomLobbiesResponse");
    CMsgPracticeLobbySetTeamSlot = root.lookupType("CMsgPracticeLobbySetTeamSlot");
    CMsgReadyUp = root.lookupType("CMsgReadyUp");
    CMsgReadyUpStatus = root.lookupType("CMsgReadyUpStatus");
    CSODOTALobby = root.lookupType("CSODOTALobby");
    CDOTAClientHardwareSpecs = root.lookupType("CDOTAClientHardwareSpecs");
    CMsgSOSingleObject = root.lookupType("CMsgSOSingleObject");
    CMsgSOMultipleObjects = root.lookupType("CMsgSOMultipleObjects");
    CMsgSOCacheSubscribed = root.lookupType("CMsgSOCacheSubscribed");
    
    console.log("[System] Proto 文件加载成功");
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

// ============================================
// GlobalRoomTracker - 全局房间追踪器
// ============================================
class GlobalRoomTracker {
    constructor(settings) {
        this.settings = settings;
        this.allRooms = new Map(); // lobbyId -> { createdAt, leaderUsername, memberCount, isPublic }
        this.displayedRooms = new Set(); // 在75个槽位中的房间ID
        this.lastQueryTime = 0;
    }

    // 注册新创建的房间
    registerRoom(lobbyId, leaderUsername, isPublic) {
        const lobbyIdStr = lobbyId.toString();
        this.allRooms.set(lobbyIdStr, {
            lobbyId: lobbyIdStr,
            createdAt: Date.now(),
            leaderUsername: leaderUsername,
            memberCount: 1,
            isPublic: isPublic
        });
        logInfo('RoomTracker', `📝 注册房间: ${lobbyIdStr} | Leader: ${leaderUsername} | 公开: ${isPublic ? '是' : '否'}`);
    }

    // 更新房间人数
    updateMemberCount(lobbyId, memberCount) {
        const lobbyIdStr = lobbyId.toString();
        if (this.allRooms.has(lobbyIdStr)) {
            this.allRooms.get(lobbyIdStr).memberCount = memberCount;
        }
    }

    // 移除房间
    removeRoom(lobbyId) {
        const lobbyIdStr = lobbyId.toString();
        if (this.allRooms.has(lobbyIdStr)) {
            const room = this.allRooms.get(lobbyIdStr);
            logInfo('RoomTracker', `🗑️ 移除房间: ${lobbyIdStr} | Leader: ${room.leaderUsername}`);
            this.allRooms.delete(lobbyIdStr);
            this.displayedRooms.delete(lobbyIdStr);
        }
    }

    // 更新展示房间列表（从 list_lobbies 查询结果）
    updateDisplayedRooms(lobbies) {
        this.displayedRooms.clear();
        this.lastQueryTime = Date.now();
        
        lobbies.forEach(lobby => {
            const lobbyIdStr = lobby.lobbyId.toString();
            this.displayedRooms.add(lobbyIdStr);
        });
        
        logInfo('RoomTracker', `📊 更新展示房间列表: ${this.displayedRooms.size} 个房间在75个槽位中`);
    }

    // 获取最老的N个展示房间（挂机房）
    getOldestDisplayedFarmingRooms(count) {
        const displayedFarmingRooms = [];
        
        this.displayedRooms.forEach(lobbyIdStr => {
            const room = this.allRooms.get(lobbyIdStr);
            if (room && !room.isPublic) { // 只找挂机房（有密码的）
                displayedFarmingRooms.push(room);
            }
        });
        
        // 按创建时间排序，最老的在前
        displayedFarmingRooms.sort((a, b) => a.createdAt - b.createdAt);
        
        return displayedFarmingRooms.slice(0, count);
    }

    // 获取统计信息
    getStats() {
        let totalRooms = this.allRooms.size;
        let publicRooms = 0;
        let farmingRooms = 0;
        let totalMembers = 0;
        
        this.allRooms.forEach(room => {
            if (room.isPublic) publicRooms++;
            else farmingRooms++;
            totalMembers += room.memberCount;
        });
        
        return {
            totalRooms,
            publicRooms,
            farmingRooms,
            displayedRooms: this.displayedRooms.size,
            totalMembers
        };
    }
}

// ============================================
// ShowcaseManager - 展示车队管理器
// ============================================
class ShowcaseManager {
    constructor(showcaseLeaders, settings, globalManager) {
        this.showcaseLeaders = showcaseLeaders; // 2个展示主号配置
        this.settings = settings;
        this.globalManager = globalManager;
        this.bots = []; // 展示主号Bot实例
        this.currentActiveIndex = 0; // 当前活跃的展示主号索引 (0 或 1)
        this.rotationTimer = null;
        this.rotationCycleMinutes = settings.rotation_cycle_minutes || 25;
        this.dissolveCount = settings.dissolve_count || 10;
        this.isRotating = false;
        this.rotationCount = 0;
    }

    start() {
        logSection('展示车队启动');
        
        if (this.showcaseLeaders.length < 2) {
            logError('Showcase', '展示主号数量不足，需要至少2个主号');
            return;
        }
        
        logInfo('Showcase', `展示主号A: ${this.showcaseLeaders[0].username}`);
        logInfo('Showcase', `展示主号B: ${this.showcaseLeaders[1].username}`);
        logInfo('Showcase', `轮换周期: ${this.rotationCycleMinutes} 分钟`);
        logInfo('Showcase', `每次解散挂机房数量: ${this.dissolveCount} 个`);
        
        // 创建展示主号Bot
        this.showcaseLeaders.forEach((account, idx) => {
            const proxyIndex = idx;
            const proxy = proxies.length > 0 ? proxies[proxyIndex] : null;
            
            const bot = new BotClient(
                account, 
                this.settings, 
                'SHOWCASE_LEADER', 
                `showcase_${idx}`,
                this.globalManager,
                proxy,
                proxyIndex
            );
            bot.showcaseIndex = idx;
            bot.showcaseManager = this;
            this.bots.push(bot);
        });
        
        // 只启动第一个展示主号（主号A驻留）
        logInfo('Showcase', `启动展示主号A (${this.showcaseLeaders[0].username}) 创建公开房...`);
        this.bots[0].start();
        
        // 启动轮换定时器
        this.startRotationTimer();
    }

    startRotationTimer() {
        const rotationMs = this.rotationCycleMinutes * 60 * 1000;
        
        logInfo('Showcase', `⏱️ 轮换定时器已启动，${this.rotationCycleMinutes} 分钟后执行第一次轮换`);
        
        this.rotationTimer = setInterval(() => {
            this.executeRotation();
        }, rotationMs);
    }

    async executeRotation() {
        if (this.isRotating) {
            logWarning('Showcase', '轮换正在进行中，跳过本次轮换');
            return;
        }
        
        this.isRotating = true;
        this.rotationCount++;
        
        logSection(`第 ${this.rotationCount} 次轮换开始`);
        
        const currentBot = this.bots[this.currentActiveIndex];
        const nextIndex = (this.currentActiveIndex + 1) % 2;
        const nextBot = this.bots[nextIndex];
        
        logInfo('Showcase', `当前活跃: 主号${this.currentActiveIndex === 0 ? 'A' : 'B'} (${currentBot.account.username})`);
        logInfo('Showcase', `即将切换: 主号${nextIndex === 0 ? 'A' : 'B'} (${nextBot.account.username})`);
        
        try {
            // 步骤1: 新主号创建公开房
            logInfo('Showcase', `[步骤1] 新主号创建公开房...`);
            if (!nextBot.is_gc_connected) {
                logInfo('Showcase', `新主号尚未连接，先启动登录...`);
                nextBot.start();
                // 等待连接
                await this.waitForGCConnection(nextBot, 30000);
            }
            
            nextBot.createPublicRoom();
            await this.waitForRoomCreation(nextBot, 15000);
            
            if (!nextBot.currentLobbyId) {
                logError('Showcase', '新公开房创建失败，取消本次轮换');
                this.isRotating = false;
                return;
            }
            
            logSuccess('Showcase', `新公开房创建成功: ${nextBot.currentLobbyId.toString()}`);
            
            // 步骤2: 查询当前展示房间
            logInfo('Showcase', `[步骤2] 查询当前展示房间...`);
            const displayedRooms = await this.queryDisplayedRooms();
            logInfo('Showcase', `查询到 ${displayedRooms.length} 个展示房间`);
            
            // 步骤3: 找到最老的N个挂机房
            const roomsToDissolve = this.globalManager.roomTracker.getOldestDisplayedFarmingRooms(this.dissolveCount);
            logInfo('Showcase', `[步骤3] 准备解散 ${roomsToDissolve.length} 个最老的挂机房`);
            
            roomsToDissolve.forEach((room, idx) => {
                const age = Math.floor((Date.now() - room.createdAt) / 60000);
                logInfo('Showcase', `  ${idx + 1}. ${room.lobbyId} | Leader: ${room.leaderUsername} | 存活: ${age}分钟`);
            });
            
            // 步骤4: 解散旧公开房
            logInfo('Showcase', `[步骤4] 解散旧公开房...`);
            if (currentBot.currentLobbyId) {
                currentBot.dissolveRoom();
                logSuccess('Showcase', `旧公开房已解散: ${currentBot.currentLobbyId?.toString() || 'unknown'}`);
            }
            
            // 步骤5: 通知挂机车队解散指定房间
            logInfo('Showcase', `[步骤5] 通知挂机车队解散 ${roomsToDissolve.length} 个房间...`);
            roomsToDissolve.forEach(room => {
                this.globalManager.requestRoomDissolve(room.lobbyId);
            });
            
            // 等待解散完成
            await this.sleep(3000);
            
            // 步骤6: 更新活跃索引
            this.currentActiveIndex = nextIndex;
            
            logSuccess('Showcase', `轮换完成！当前活跃: 主号${nextIndex === 0 ? 'A' : 'B'}`);
            
        } catch (err) {
            logError('Showcase', `轮换失败: ${err.message}`);
        }
        
        this.isRotating = false;
    }

    async queryDisplayedRooms() {
        return new Promise((resolve) => {
            const activeBot = this.bots.find(b => b.is_gc_connected);
            if (!activeBot) {
                resolve([]);
                return;
            }
            
            activeBot.queryLobbyList((lobbies) => {
                this.globalManager.roomTracker.updateDisplayedRooms(lobbies);
                resolve(lobbies);
            });
            
            // 超时处理
            setTimeout(() => resolve([]), 5000);
        });
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
                if (bot.currentLobbyId) {
                    clearInterval(checkInterval);
                    resolve(true);
                } else if (Date.now() - startTime > timeout) {
                    clearInterval(checkInterval);
                    resolve(false);
                }
            }, 500);
        });
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    cleanup() {
        if (this.rotationTimer) {
            clearInterval(this.rotationTimer);
        }
        this.bots.forEach(bot => bot.cleanup());
    }
}

// ============================================
// GlobalManager - 全局管理器
// ============================================
class GlobalManager {
    constructor(settings) {
        this.settings = settings;
        this.roomTracker = new GlobalRoomTracker(settings);
        this.fleetManagers = [];
        this.showcaseManager = null;
        this.allBots = []; // 所有Bot引用
        this.roomDissolveQueue = new Set(); // 待解散的房间ID
    }

    setShowcaseManager(manager) {
        this.showcaseManager = manager;
    }

    addFleetManager(manager) {
        this.fleetManagers.push(manager);
    }

    registerBot(bot) {
        this.allBots.push(bot);
    }

    // 请求解散指定房间
    requestRoomDissolve(lobbyId) {
        const lobbyIdStr = lobbyId.toString();
        this.roomDissolveQueue.add(lobbyIdStr);
        logInfo('GlobalManager', `📢 请求解散房间: ${lobbyIdStr}`);
        
        // 通知对应的Bot
        const targetBot = this.allBots.find(bot => 
            bot.currentLobbyId && bot.currentLobbyId.toString() === lobbyIdStr && bot.role === 'LEADER'
        );
        
        if (targetBot) {
            logInfo('GlobalManager', `找到目标主号: ${targetBot.account.username}，执行解散`);
            targetBot.dissolveRoom();
        } else {
            logWarning('GlobalManager', `未找到房间 ${lobbyIdStr} 的主号`);
        }
    }

    // 检查房间是否需要解散
    shouldDissolveRoom(lobbyId) {
        return this.roomDissolveQueue.has(lobbyId.toString());
    }

    // 确认房间已解散
    confirmRoomDissolved(lobbyId) {
        const lobbyIdStr = lobbyId.toString();
        this.roomDissolveQueue.delete(lobbyIdStr);
        this.roomTracker.removeRoom(lobbyIdStr);
    }

    getStats() {
        return this.roomTracker.getStats();
    }
}

// ============================================
// FleetManager - 挂机车队管理器
// ============================================
class FleetManager {
    constructor(fleetConfig, globalSettings, globalAccountOffset = 0, globalManager) {
        this.id = fleetConfig.id || 'unknown_fleet';
        this.config = fleetConfig;
        this.settings = globalSettings;
        this.globalManager = globalManager;
        this.bots = [];
        this.pendingJoins = new Map();
        this.globalAccountOffset = globalAccountOffset;
    }

    start(leaderIndex = 0) {
        logInfo(`Fleet:${this.id}`, `🚀 车队启动! Leader: ${this.config.leader.username}`);

        // 启动 Leader
        let leaderProxy = null;
        if (proxies.length > 0) {
            // 展示主号占用前2个代理，挂机主号从第3个开始
            const proxyOffset = 2;
            leaderProxy = proxies[(leaderIndex + proxyOffset) % proxies.length];
        }
        
        const leaderBot = new BotClient(
            this.config.leader, 
            this.settings, 
            'LEADER', 
            this.id, 
            this.globalManager, 
            leaderProxy, 
            leaderIndex
        );
        leaderBot.fleetManager = this;
        this.bots.push(leaderBot);
        this.globalManager.registerBot(leaderBot);
        leaderBot.start();

        // 启动 Followers（随机选择代理）
        this.config.followers.forEach((acc, idx) => {
            setTimeout(() => {
                let followerProxy = null;
                if (proxies.length > 0) {
                    // 随机选择代理
                    followerProxy = proxies[Math.floor(Math.random() * proxies.length)];
                }

                const bot = new BotClient(
                    acc, 
                    this.settings, 
                    'FOLLOWER', 
                    this.id, 
                    this.globalManager, 
                    followerProxy, 
                    idx
                );
                bot.fleetManager = this;
                this.bots.push(bot);
                this.globalManager.registerBot(bot);
                bot.start();
            }, idx * 10);
        });
    }

    cleanup() {
        let successCount = 0;
        this.bots.forEach(bot => {
            try {
                bot.cleanup();
                    successCount++;
            } catch (err) {}
        });
        return successCount;
    }
                }
                
// ============================================
// BotClient - Bot客户端
// ============================================
class BotClient {
    constructor(account, settings, role, fleetId, globalManager, proxy, proxyIndex = 0) {
        this.account = account;
        this.settings = settings;
        this.role = role; // 'SHOWCASE_LEADER' | 'LEADER' | 'FOLLOWER'
        this.fleetId = fleetId;
        this.globalManager = globalManager;
        this.proxy = proxy;
        this.proxyIndex = proxyIndex;

        const sharedDataPath = settings.shared_steam_data_path || "../shared_steam_data";
        const steamDataDir = path.resolve(projectRoot, sharedDataPath);
        
        const steamOptions = { dataDirectory: steamDataDir };
        if (this.proxy) {
            steamOptions.httpProxy = this.proxy;
        }

        this.client = new SteamUser(steamOptions);
        this.handleClientError = this.handleClientError.bind(this);
        this.client.on('error', this.handleClientError);
        
        this.is_gc_connected = false;
        this.currentLobbyId = null;
        this.ready_up_heartbeat = null;
        this.state = 'OFFLINE';
        this.retryCount = 0;
        this.roomsCreated = 0;
        this.lobbyQueryCallback = null;

        // CRC 数据
        this.knownCrc = "1396649696593898392";
        this.knownTimestamp = 1763646905;

        this.setupListeners();
    }
    
    log(msg) {
        if (this.settings.debug_mode) {
            console.log(`[${formatTime()}] [${this.account.username}|${this.role}] ${msg}`);
        }
    }

    error(msg) {
        console.error(`[${formatTime()}] [${this.account.username}|${this.role}] ❌ ${msg}`);
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
        
        // 网络错误重试
        if (err.message.includes('timed out') || err.message.includes('ETIMEDOUT')) {
            this.retryCount++;
            if (this.retryCount < 5) {
                const delay = Math.min(this.retryCount * 5000, 30000);
                setTimeout(() => this.start(), delay);
            }
        }
    }

    start() {
        if (this.state === 'ABANDONED') return;

        this.state = 'LOGGING_IN';
        this.log(`开始登录...`);
        
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
        this.client.removeAllListeners('loggedOn');
        this.client.removeAllListeners('appLaunched');
        this.client.removeAllListeners('receivedFromGC');
        
        this.client.on('loggedOn', () => {
                this.log('Steam 登录成功');
            this.retryCount = 0;
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
        this.log('连接 GC...');
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

    startArcadeFlow() {
        if (this.state === 'IN_LOBBY') return;

        // 清理残留状态
        this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
        setTimeout(() => {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        }, 500);
        
        setTimeout(() => {
            if (this.role === 'SHOWCASE_LEADER') {
                this.createPublicRoom();
            } else if (this.role === 'LEADER') {
                this.createFarmingRoom();
                } else {
                this.enterIdlePool();
            }
        }, 1500);
    }

    // 创建公开房间（展示主号专用）
    createPublicRoom() {
        this.log('🏠 创建公开房间 (无密码)...');
        
        try {
            const gameIdLong = Long.fromString(this.settings.custom_game_id, true);
            const regions = this.settings.server_regions || [this.settings.server_region];
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
            this.isPublicRoom = true;
        } catch (err) {
            this.error(`创建公开房失败: ${err.message}`);
        }
    }

    // 创建挂机房间（挂机主号专用）
    createFarmingRoom() {
        this.roomsCreated++;
        this.log(`🏭 创建挂机房间 #${this.roomsCreated} (有密码)...`);
        
        try {
            const gameIdLong = Long.fromString(this.settings.custom_game_id, true);
            const regions = this.settings.server_regions || [this.settings.server_region];
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
                visibility: 0, // 公开可见（在list中显示）
                passKey: this.settings.lobby_password, // 有密码！
                customMapName: "zudui_team_map",
                customGameCrc: Long.fromString(this.knownCrc, true),
                customGameTimestamp: this.knownTimestamp
            };
            const lobbyDetails = CMsgPracticeLobbySetDetails.create(detailsPayload);

            const createPayload = {
                searchKey: "",
                passKey: this.settings.lobby_password, // 有密码！
                clientVersion: 0,
                lobbyDetails: lobbyDetails
            };

            const message = CMsgPracticeLobbyCreate.create(createPayload);
            const buffer = CMsgPracticeLobbyCreate.encode(message).finish();
            
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
            
            const regionName = RegionNameMap[selectedRegion] || `Reg:${selectedRegion}`;
            this.log(`🌐 创建挂机房 #${this.roomsCreated}，区域: ${regionName}`);
            
            this.state = 'SEEDING';
            this.isPublicRoom = false;
            this.currentRoomMemberCount = 1;
            
            // 激活心跳
            let heartbeats = 0;
            const activationInterval = setInterval(() => {
                if (this.state === 'SEEDING') {
                    this.sendReadyUp();
                    heartbeats++;
                    if (heartbeats >= 5) clearInterval(activationInterval);
                } else {
                    clearInterval(activationInterval);
                }
            }, 1000);

            // 创建超时重试
            setTimeout(() => {
                if (this.state === 'SEEDING' && !this.currentLobbyId) {
                    this.log('房间创建超时，重试...');
                    this.createFarmingRoom();
                }
            }, 15000);

        } catch (err) {
            this.error(`创建挂机房失败: ${err.message}`);
        }
    }

    // 小号进入待命池
    enterIdlePool() {
        if (this.role !== 'FOLLOWER') return;
        this.state = 'IDLE';
        this.log('进入待命池');
        
        // 开始轮询寻找房间
        this.startPolling();
    }

    startPolling() {
        this.tryJoinRoom();
        
        this.poll_interval = setInterval(() => {
            if (this.state !== 'IN_LOBBY') {
                this.tryJoinRoom();
            } else {
                clearInterval(this.poll_interval);
            }
        }, 5000);
    }

    tryJoinRoom() {
        this.queryLobbyList((lobbies) => {
            // 找到本车队的挂机房间
            const targetLobby = lobbies.find(l => 
                l.memberCount < (this.settings.max_players_per_room - 1)
            );
            
            if (targetLobby) {
                this.joinLobby(targetLobby.lobbyId);
            }
        });
    }

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

    joinLobby(lobbyId) {
        if (this.state === 'IN_LOBBY') return;
        
        try {
            let lobbyIdLong = lobbyId;
            if (typeof lobbyId === 'string') lobbyIdLong = Long.fromString(lobbyId, true);
            else if (typeof lobbyId === 'number') lobbyIdLong = Long.fromNumber(lobbyId, true);

            const payload = {
                lobbyId: lobbyIdLong,
                customGameCrc: Long.fromString(this.knownCrc, true),
                customGameTimestamp: this.knownTimestamp,
                passKey: this.settings.lobby_password
            };
            
            const message = CMsgPracticeLobbyJoin.create(payload);
            const buffer = CMsgPracticeLobbyJoin.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyJoin | k_EMsgProtoMask, {}, buffer);
            
            this.log(`尝试加入房间: ${lobbyId.toString()}`);
        } catch (err) {}
    }

    // 解散房间
    dissolveRoom() {
        this.log('🗑️ 解散房间...');
        
        if (this.currentLobbyId) {
            this.globalManager.confirmRoomDissolved(this.currentLobbyId);
        }
        
        // 通知所有在这个房间的小号退出
        if (this.globalManager) {
            const lobbyIdStr = this.currentLobbyId?.toString();
            this.globalManager.allBots.forEach(bot => {
                if (bot.role === 'FOLLOWER' && 
                    bot.currentLobbyId?.toString() === lobbyIdStr) {
                    bot.leaveLobby();
                }
            });
        }
        
        this.leaveLobby();
        
        // 挂机主号：解散后继续创建新房间
        if (this.role === 'LEADER') {
            setTimeout(() => {
                if (this.state !== 'ABANDONED') {
                    this.createFarmingRoom();
                }
            }, 2000);
        }
    }

    leaveLobby() {
        try {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                                this.currentLobbyId = null;
            this.state = 'ONLINE';
                                
                                if (this.ready_up_heartbeat) {
                                    clearInterval(this.ready_up_heartbeat);
                                    this.ready_up_heartbeat = null;
                                }
                                
            if (this.poll_interval) {
                clearInterval(this.poll_interval);
                this.poll_interval = null;
            }
            
            // 小号：重新进入待命池
            if (this.role === 'FOLLOWER') {
                setTimeout(() => this.enterIdlePool(), 1000);
            }
        } catch (err) {}
    }

    handleGCMessage(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!this.is_gc_connected) {
                this.is_gc_connected = true;
                this.log('✅ GC 连接成功');
                this.startArcadeFlow();
            }
        }
        else if (cleanMsgType === k_EMsgGCJoinableCustomLobbiesResponse) {
            try {
                const response = CMsgJoinableCustomLobbiesResponse.decode(payload);
                const targetId = this.settings.custom_game_id;
                
                const myLobbies = (response.lobbies || []).filter(l => 
                    (l.customGameId ? l.customGameId.toString() : '0') === targetId
                );

                if (this.lobbyQueryCallback) {
                    this.lobbyQueryCallback(myLobbies);
                    this.lobbyQueryCallback = null;
                }
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
        else if (cleanMsgType === k_EMsgGCPracticeLobbyJoinResponse) {
             try {
                const response = CMsgPracticeLobbyJoinResponse.decode(payload);
                if (response.result === DOTAJoinLobbyResult.DOTA_JOIN_RESULT_SUCCESS) {
                    this.onEnterLobby();
                } else {
                    this.log(`加入失败: ${JoinResultName[response.result] || response.result}`);
                }
             } catch(e) {}
        }
        else if (cleanMsgType === k_EMsgGCReadyUpStatus) {
             try {
                 const status = CMsgReadyUpStatus.decode(payload);
                if (status.lobbyId) this.currentLobbyId = status.lobbyId;
                setTimeout(() => this.sendReadyUp(this.currentLobbyId), 200);
            } catch(e) {}
        }
    }

    processLobbyData(objectData) {
        if (!objectData || objectData.length === 0) return;
        
        try {
            const lobby = CSODOTALobby.decode(objectData);
            const lobbyId = lobby.lobbyId;
            const memberCount = (lobby.allMembers || []).length;
            
            if (lobbyId) {
                this.currentLobbyId = lobbyId;
                
                // 注册到全局追踪器
                if ((this.role === 'LEADER' || this.role === 'SHOWCASE_LEADER') && 
                    this.state === 'SEEDING' || this.state === 'CREATING_LOBBY') {
                    this.globalManager.roomTracker.registerRoom(lobbyId, this.account.username, this.isPublicRoom);
                    logSuccess(this.role, `房间创建成功: ${lobbyId.toString()} | 人数: ${memberCount}`);
                    
                    if (this.role === 'SHOWCASE_LEADER') {
                        this.state = 'IN_LOBBY';
                        this.onEnterLobby();
                    }
                }
                
                // 挂机主号：检测有人加入后离开
                if (this.role === 'LEADER' && this.state === 'SEEDING') {
                        if (memberCount > 1) {
                        this.log(`有小号加入 (${memberCount}人)，离开并创建新房间`);
                        this.globalManager.roomTracker.updateMemberCount(lobbyId, memberCount);
                        
                        // 断开重连创建新房间
                        this.leaveLobby();
                        setTimeout(() => this.createFarmingRoom(), 2000);
                    }
                }
            }
        } catch (e) {}
    }

    onEnterLobby() {
        if (this.state === 'IN_LOBBY' && this.role !== 'SHOWCASE_LEADER') return;
            this.state = 'IN_LOBBY';
        this.log(`✅ 已进入房间`);
                 
        // 设置队伍
                 setTimeout(() => {
            const teamMsg = CMsgPracticeLobbySetTeamSlot.create({ team: DOTA_GC_TEAM.DOTA_GC_TEAM_GOOD_GUYS, slot: 0 });
            const teamBuf = CMsgPracticeLobbySetTeamSlot.encode(teamMsg).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbySetTeamSlot | k_EMsgProtoMask, {}, teamBuf);
            
            setTimeout(() => this.sendReadyUp(this.currentLobbyId), 500);
        }, 1000);

        // 心跳
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
        if (this.poll_interval) clearInterval(this.poll_interval);
        
        try {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        } catch (err) {}
        
        try {
            this.client.logOff();
        } catch (err) {}
        
        return true;
    }
}

// ============================================
// Main Entry
// ============================================
const args = process.argv.slice(2);
const isDebugMode = args.includes('debug');

let config;
             try {
    const configPath = path.join(projectRoot, 'config', 'config.json');
    const rawContent = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(rawContent);
             } catch (e) {
    console.error("❌ 读取配置失败: " + e.message);
    process.exit(1);
}

const globalSettings = config.global_settings;
globalSettings.debug_mode = isDebugMode;

// 添加新配置项默认值
globalSettings.rotation_cycle_minutes = globalSettings.rotation_cycle_minutes || 25;
globalSettings.dissolve_count = globalSettings.dissolve_count || 10;

// 确保共享验证数据目录存在
const sharedDataPath = globalSettings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);
if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}

logSection('Dota2 Arcade Bot v2.0 启动');
logInfo('System', `模式: ${isDebugMode ? '调试模式' : '生产模式'}`);
logInfo('System', `轮换周期: ${globalSettings.rotation_cycle_minutes} 分钟`);
logInfo('System', `每次解散挂机房: ${globalSettings.dissolve_count} 个`);

// 创建全局管理器
const globalManager = new GlobalManager(globalSettings);

// 解析配置
let fleets = config.fleets || [];
let showcaseLeaders = config.showcase_leaders || [];

// 如果没有单独的展示主号配置，从第一个车队的leader数组中取前2个作为展示主号
if (showcaseLeaders.length === 0 && fleets.length > 0 && Array.isArray(fleets[0].leader)) {
    const allLeaders = fleets[0].leader;
    if (allLeaders.length >= 2) {
        showcaseLeaders = allLeaders.slice(0, 2);
        // 剩余的作为挂机主号
        const farmingLeaders = allLeaders.slice(2);
        
        logInfo('System', `自动分配: 前2个主号作为展示主号，剩余 ${farmingLeaders.length} 个作为挂机主号`);
        
        // 重构fleets，每个挂机主号配一批小号
        const followers = fleets[0].followers || [];
        const followersPerLeader = Math.floor(followers.length / farmingLeaders.length);
        
    fleets = [];
    let followerIndex = 0;
        farmingLeaders.forEach((leader, idx) => {
            const currentFollowers = followers.slice(followerIndex, followerIndex + followersPerLeader);
            followerIndex += followersPerLeader;
        
        fleets.push({
            id: `fleet_${idx + 1}`,
                leader: leader,
            followers: currentFollowers
        });
    });
    
        // 剩余小号分配给最后一个车队
        if (followerIndex < followers.length && fleets.length > 0) {
            fleets[fleets.length - 1].followers.push(...followers.slice(followerIndex));
        }
    }
}

if (showcaseLeaders.length < 2) {
    logError('System', '需要至少2个展示主号！请检查配置。');
    process.exit(1);
}

// 统计信息
const totalFarmingLeaders = fleets.length;
const totalFollowers = fleets.reduce((sum, f) => sum + (f.followers?.length || 0), 0);

logInfo('System', `展示主号: ${showcaseLeaders.length} 个`);
logInfo('System', `挂机主号: ${totalFarmingLeaders} 个`);
logInfo('System', `小号: ${totalFollowers} 个`);

// 启动展示车队
const showcaseManager = new ShowcaseManager(showcaseLeaders, globalSettings, globalManager);
globalManager.setShowcaseManager(showcaseManager);
showcaseManager.start();

// 延迟启动挂机车队（等展示主号创建公开房后）
setTimeout(() => {
    logSection('挂机车队启动');
    
    let globalFollowerOffset = 0;
fleets.forEach((fleetConfig, leaderIndex) => {
        const fleet = new FleetManager(fleetConfig, globalSettings, globalFollowerOffset, globalManager);
        globalManager.addFleetManager(fleet);
        fleet.start(leaderIndex);
    globalFollowerOffset += (fleetConfig.followers?.length || 0);
});
}, 30000); // 30秒后启动挂机车队

// 状态监控
setInterval(() => {
    const stats = globalManager.getStats();
    logInfo('Stats', `总房间: ${stats.totalRooms} | 公开房: ${stats.publicRooms} | 挂机房: ${stats.farmingRooms} | 展示中: ${stats.displayedRooms} | 总人数: ${stats.totalMembers}`);
}, 60000);

// 异常处理
process.on('uncaughtException', (err) => {
    if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(err.code)) return;
    console.error('\n[System] ⚠️ 未捕获的异常:', err.message);
});

process.on('unhandledRejection', (reason) => {
    if (reason?.code && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(reason.code)) return;
    console.error('\n[System] ⚠️ 未处理的 Promise 拒绝:', reason);
});

process.on('SIGINT', () => {
    logSection('程序退出');
    
    if (showcaseManager) showcaseManager.cleanup();
    globalManager.fleetManagers.forEach(f => f.cleanup());
    
    setTimeout(() => {
        logSuccess('System', '程序已安全退出');
        process.exit(0);
    }, 5000);
});


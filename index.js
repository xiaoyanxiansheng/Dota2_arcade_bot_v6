const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');

// 消息 ID 定义
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
const k_EMsgGCQuickJoinCustomLobbyResponse = 7471;
const k_EMsgGCReadyUp = 7070;
const k_EMsgGCReadyUpStatus = 7170;
const k_EMsgGCPracticeLobbySetTeamSlot = 7047;
const k_EMsgProtoMask = 0x80000000;

// SOCache 消息 ID (GC SDK)
const k_EMsgGCSOCacheSubscribed = 24;        // 订阅缓存
const k_EMsgGCSOSingleObject = 25;           // 单对象更新
const k_EMsgGCSOMultipleObjects = 26;        // 多对象更新

// CSODOTALobby 的 TypeID
const SOCACHE_TYPE_LOBBY = 2004;

// DOTAJoinLobbyResult 枚举 (来自 dota_shared_enums.proto)
const DOTAJoinLobbyResult = {
    DOTA_JOIN_RESULT_SUCCESS: 0,
    DOTA_JOIN_RESULT_ALREADY_IN_GAME: 1,
    DOTA_JOIN_RESULT_INVALID_LOBBY: 2,       // <-- Code 2 的真正含义！
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

// 反向映射：Code -> 名称
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

// 全局 Proto 定义
let CMsgClientHello, CMsgPracticeLobbyJoin, CMsgPracticeLobbyJoinResponse, CMsgPracticeLobbyCreate, CMsgPracticeLobbySetDetails, CMsgJoinableCustomLobbiesRequest, CMsgJoinableCustomLobbiesResponse, CMsgQuickJoinCustomLobbyResponse, CMsgPracticeLobbySetTeamSlot, CMsgReadyUp, CMsgReadyUpStatus, CSODOTALobby, CDOTAClientHardwareSpecs;
// SOCache 相关 Proto 类型
let CMsgSOSingleObject, CMsgSOMultipleObjects, CMsgSOCacheSubscribed;

// 加载 Proto
try {
    const root = new protobuf.Root();
    root.resolvePath = function(origin, target) {
        if (fs.existsSync(target)) return target;
        const pathInProtobufs = "Protobufs/" + target;
        if (fs.existsSync(pathInProtobufs)) return pathInProtobufs;
        const pathInDota2 = "Protobufs/dota2/" + target;
        if (fs.existsSync(pathInDota2)) return pathInDota2;
        return target;
    };

    root.loadSync("Protobufs/google/protobuf/descriptor.proto");
    root.loadSync("Protobufs/dota2/networkbasetypes.proto"); 
    root.loadSync("Protobufs/dota2/network_connection.proto");
    root.loadSync("Protobufs/dota2/steammessages.proto");
    root.loadSync("Protobufs/dota2/gcsdk_gcmessages.proto");
    root.loadSync("Protobufs/dota2/dota_shared_enums.proto");
    root.loadSync("Protobufs/dota2/dota_client_enums.proto");
    root.loadSync("Protobufs/dota2/base_gcmessages.proto");
    root.loadSync("Protobufs/dota2/dota_gcmessages_common_lobby.proto");
    root.loadSync("Protobufs/dota2/dota_gcmessages_client_match_management.proto");
    root.loadSync("Protobufs/dota2/dota_gcmessages_client.proto");

    CMsgClientHello = root.lookupType("CMsgClientHello");
    CMsgPracticeLobbyJoin = root.lookupType("CMsgPracticeLobbyJoin");
    CMsgPracticeLobbyJoinResponse = root.lookupType("CMsgPracticeLobbyJoinResponse");
    CMsgPracticeLobbyCreate = root.lookupType("CMsgPracticeLobbyCreate");
    CMsgPracticeLobbySetDetails = root.lookupType("CMsgPracticeLobbySetDetails");
    CMsgJoinableCustomLobbiesRequest = root.lookupType("CMsgJoinableCustomLobbiesRequest");
    CMsgJoinableCustomLobbiesResponse = root.lookupType("CMsgJoinableCustomLobbiesResponse");
    CMsgQuickJoinCustomLobbyResponse = root.lookupType("CMsgQuickJoinCustomLobbyResponse");
    CMsgPracticeLobbySetTeamSlot = root.lookupType("CMsgPracticeLobbySetTeamSlot");
    CMsgReadyUp = root.lookupType("CMsgReadyUp");
    CMsgReadyUpStatus = root.lookupType("CMsgReadyUpStatus");
    CSODOTALobby = root.lookupType("CSODOTALobby");
    CDOTAClientHardwareSpecs = root.lookupType("CDOTAClientHardwareSpecs");
    
    // 加载 SOCache 相关类型
    CMsgSOSingleObject = root.lookupType("CMsgSOSingleObject");
    CMsgSOMultipleObjects = root.lookupType("CMsgSOMultipleObjects");
    CMsgSOCacheSubscribed = root.lookupType("CMsgSOCacheSubscribed");
    
    console.log("[System] Proto 文件加载成功");
    console.log("[System] SOCache 类型加载完成: CMsgSOSingleObject, CMsgSOMultipleObjects, CMsgSOCacheSubscribed");
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

// --- Fleet Manager ---
class FleetManager {
    constructor(fleetConfig, globalSettings) {
        this.id = fleetConfig.id || 'unknown_fleet';
        this.config = fleetConfig;
        this.settings = globalSettings;
        this.bots = [];
        // [新增] 共享房间状态表 (Key: RoomName, Value: { lobbyId, count: number, time: number })
        this.roomStates = new Map();
        
        // [新增] 虚拟人数表 (Key: LobbyID string, Value: number)
        // 用于防止并发加入导致的超员
        this.pendingJoins = new Map();

        // [核心新增] 确认的房间信息 - 由 Leader 通过 SOCache 确认后设置
        this.confirmedLobby = null; // { lobbyId, roomName, roomNumber, memberCount, confirmedAt }
        
        // [进度条] 统计信息
        this.totalBots = 1 + (fleetConfig.followers?.length || 0); // Leader + Followers
        this.progressInterval = null; // 进度条更新定时器
    }
    
    // [进度条] 启动进度统计（每秒查询一次）
    startProgressMonitor() {
        // 只在生产模式下启动
        if (this.settings.debug_mode) return;
        
        this.progressInterval = setInterval(() => {
            this.updateProgress();
        }, 1000); // 每秒更新一次
    }
    
    // [进度条] 停止进度统计
    stopProgressMonitor() {
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
    }
    
    // [进度条] 更新进度显示
    updateProgress() {
        // 统计当前状态
        let botsInLobby = 0;
        let roomsCreated = 0;
        const roomSet = new Set();
        
        // 遍历所有 Bot，统计在房间内的数量
        this.bots.forEach(bot => {
            if (bot.state === 'IN_LOBBY' || bot.state === 'SEEDING') {
                botsInLobby++;
                
                // 统计房间数量（通过 currentLobbyId 去重）
                if (bot.currentLobbyId) {
                    roomSet.add(bot.currentLobbyId.toString());
                }
            }
        });
        
        roomsCreated = roomSet.size;
        
        const percentage = Math.floor((botsInLobby / this.totalBots) * 100);
        const barLength = 40;
        const filledLength = Math.floor((percentage / 100) * barLength);
        const emptyLength = barLength - filledLength;
        
        const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
        const info = `房间: ${roomsCreated} | Bot: ${botsInLobby}/${this.totalBots}`;
        
        // 使用 \r 覆盖当前行
        process.stdout.write(`\r[${bar}] ${percentage}% | ${info}`);
        
        // 如果达到100%，换行
        if (percentage === 100 && botsInLobby === this.totalBots) {
            process.stdout.write('\n');
            this.stopProgressMonitor(); // 完成后停止监控
        }
    }

    updateRoomState(roomName, lobbyId, count) {
        // 清理过期的 pending joins (超过30秒的)
        const now = Date.now();
        
        this.roomStates.set(roomName, {
            lobbyId: lobbyId,
            count: count,
            time: now
        });
    }

    // [核心] Follower 申请加入房间
    requestJoinSlot(followerName) {
        const debugMode = this.settings.debug_mode || false;
        const maxPerRoom = debugMode 
            ? (this.settings.debug_max_bots_per_room || 3) 
            : (this.settings.max_players_per_room - 1 || 3);

        // 1. 收集所有候选房间 (合并 roomStates 和 confirmedLobby)
        const candidates = new Map(this.roomStates);

        // 确保 confirmedLobby 也在候选列表中
        if (this.confirmedLobby && this.confirmedLobby.lobbyId) {
            // 只有当 roomStates 里没有更新的数据时才覆盖
            if (!candidates.has(this.confirmedLobby.roomName)) {
                candidates.set(this.confirmedLobby.roomName, {
                    lobbyId: this.confirmedLobby.lobbyId,
                    count: this.confirmedLobby.memberCount,
                    time: Date.now()
                });
            }
        }

        // 2. 严格排序：优先填满旧房间 (最小的房间号)
        const sortedRooms = Array.from(candidates.entries())
            .filter(([name, data]) => Date.now() - data.time < 60000) // 只看1分钟内的活跃房间
            .sort((a, b) => {
                const aNum = parseInt(a[0].match(/#(\d+)/)?.[1] || '0');
                const bNum = parseInt(b[0].match(/#(\d+)/)?.[1] || '0');
                return aNum - bNum; // 升序：#1, #2, #3...
            });

        // 3. 顺序分配
        for (const [roomName, data] of sortedRooms) {
            if (!data.lobbyId) continue;
            
            const lobbyIdStr = data.lobbyId.toString();
            const pending = this.pendingJoins.get(lobbyIdStr) || 0;
            const currentCount = data.count;
            const totalVirtual = currentCount + pending;
            
            if (totalVirtual < maxPerRoom) {
                // 批准加入
                this.pendingJoins.set(lobbyIdStr, pending + 1);
                
                // 30秒后自动释放 pending 计数
                setTimeout(() => {
                    const p = this.pendingJoins.get(lobbyIdStr) || 0;
                    if (p > 0) this.pendingJoins.set(lobbyIdStr, p - 1);
                }, 30000);

                if (this.settings.debug_mode) {
                    console.log(`[Fleet:${this.id}] 🎫 分配 ${followerName} -> ${roomName} (实:${currentCount} + 虚:${pending} = ${totalVirtual + 1}/${maxPerRoom})`);
                }
                return { 
                    action: 'JOIN', 
                    lobbyId: data.lobbyId,
                    roomName: roomName
                };
            }
        }

        return { action: 'WAIT' };
    }

    getRoomState(roomName) {
        return this.roomStates.get(roomName);
    }
    
    // [核心新增] Leader 确认房间创建成功后调用
    setConfirmedLobby(lobbyId, roomName, roomNumber, memberCount) {
        const oldLobby = this.confirmedLobby;
        this.confirmedLobby = {
            lobbyId: lobbyId,
            roomName: roomName,
            roomNumber: roomNumber,
            memberCount: memberCount,
            confirmedAt: Date.now()
        };
        
        // [新增] 同步更新到全局 roomStates，确保刚创建的房间立即参与分配
        this.updateRoomState(roomName, lobbyId, memberCount);
        
        if (this.settings.debug_mode) {
            console.log(`[Fleet:${this.id}] 🎯 [CONFIRMED] 房间已确认: ID=${lobbyId.toString()} | Name="${roomName}" | Members=${memberCount}`);
        }
    }
    
    // [核心新增] Follower 获取确认的房间信息
    getConfirmedLobby() {
        return this.confirmedLobby;
    }
    
    // [核心新增] 清除确认的房间（Leader 离开时调用）
    clearConfirmedLobby() {
        if (this.confirmedLobby && this.settings.debug_mode) {
            console.log(`[Fleet:${this.id}] 🗑️ [CLEAR] 清除确认的房间: ID=${this.confirmedLobby.lobbyId?.toString() || 'null'}`);
        }
        this.confirmedLobby = null;
    }

    start() {
        if (this.settings.debug_mode) {
            console.log(`\n[Fleet:${this.id}] 🚀 车队启动! Leader: ${this.config.leader.username}`);
        }

        // 1. 启动 Leader (传入 fleetId 和 manager)
        const leaderBot = new BotClient(this.config.leader, this.settings, 'LEADER', this.id, this);
        this.bots.push(leaderBot);
        leaderBot.start();

        // 2. 启动 Followers (错峰，传入 fleetId 和 manager)
        this.config.followers.forEach((acc, idx) => {
            setTimeout(() => {
                if (this.settings.debug_mode) {
                    console.log(`[Fleet:${this.id}] 启动 Follower ${idx+1}: ${acc.username}`);
                }
                const bot = new BotClient(acc, this.settings, 'FOLLOWER', this.id, this);
                this.bots.push(bot);
                bot.start();
            }, 5000 + (idx * 3000)); // Leader 先跑5秒，然后每个Follower间隔3秒
        });
        
        // 3. 启动进度监控（生产模式）
        if (!this.settings.debug_mode) {
            // 延迟10秒后启动，等 Bot 们都开始运行
            setTimeout(() => {
                this.startProgressMonitor();
            }, 10000);
        }
    }

    cleanup() {
        this.stopProgressMonitor(); // 停止进度监控
        this.bots.forEach(b => b.cleanup());
    }
                }
                
// --- Bot Client ---
class BotClient {
    constructor(account, settings, role, fleetId, manager) {
        this.account = account;
        this.settings = settings;
        this.role = role; // 'LEADER' | 'FOLLOWER'
        this.fleetId = fleetId; // 车队 ID，用于识别房间
        this.manager = manager; // [新增] 全局管理器引用
        
        // [修改] 显式指定数据目录，与 login_leader.js 保持一致
        this.client = new SteamUser({
            dataDirectory: "./steam_data"
        });
        this.is_gc_connected = false;
        this.currentLobbyId = null;
        this.ready_up_heartbeat = null;
        this.state = 'OFFLINE';
        this.poll_interval = null; // Follower 的轮询定时器
        
        // [播种模式] Leader 专用变量
        this.roomsCreated = 0; // 已创建房间计数
        this.isSeeding = settings.seeding_mode || false; // 是否启用播种模式
        this.currentRoomMemberCount = 1; // 当前房间人数（包括自己）
        this.currentRoomNumber = 0; // 当前正在播种的房间编号

        // CRC 数据 (硬编码或后续从 Leader 获取)
        this.knownCrc = "1396649696593898392";
        this.knownTimestamp = 1763646905;
        
        // [新增] 状态快照，用于差量更新日志
        this.lastFleetSnapshot = ''; 
        
        // [新增] Follower 健康检查：记录自己所在房间的最后可见时间
        this.myRoomLastSeen = 0; // 上次在列表中看到自己房间的时间戳
        this.myRoomMissingCount = 0; // 连续未找到自己房间的次数

        this.setupListeners();
    }

    log(msg) {
        // 生产模式下不打印日志
        if (!this.settings.debug_mode) return;
        console.log(`[${this.account.username}|${this.role}] ${msg}`);
    }

    error(msg) {
        // 错误始终打印（换行后打印，避免覆盖进度条）
        if (!this.settings.debug_mode) {
            process.stdout.write('\n'); // 确保进度条不被覆盖
        }
        console.error(`[${this.account.username}|${this.role}] ❌ ${msg}`);
    }

    start() {
        this.state = 'LOGGING_IN';
    const logOnOptions = {
            accountName: this.account.username,
            password: this.account.password,
            promptSteamGuardCode: false // 禁止交互式输入验证码，避免阻塞批量流程
    };
        if (this.account.shared_secret && this.account.shared_secret.length > 5) {
            try { logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(this.account.shared_secret); } catch (err) {}
    }
        this.client.logOn(logOnOptions);
    }

    setupListeners() {
        this.client.on('loggedOn', () => {
            if (this.settings.debug_mode) {
                this.log('Steam 登录成功');
            }
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
    });

        this.client.on('appLaunched', (appid) => {
            if (appid === this.settings.target_app_id) {
                if (this.settings.debug_mode) {
                    this.log('🎮 Dota 2 启动');
                }
                setTimeout(() => this.connectGC(), 2000);
        }
    });

        this.client.on('receivedFromGC', (appid, msgType, payload) => this.handleGCMessage(appid, msgType, payload));
    }

    connectGC() {
        if (this.settings.debug_mode) {
            this.log('开始连接 GC...');
        }
        this.sendHello();
        const helloInterval = setInterval(() => { 
            if(!this.is_gc_connected) this.sendHello(); 
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

        // 1. 清理残留
        this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
        setTimeout(() => {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        }, 500);
        
        // 2. 根据角色行动
        setTimeout(() => {
            if (this.role === 'LEADER') {
                if (this.isSeeding) {
                    if (this.settings.debug_mode) {
                        this.log('🌱 播种模式启动：将持续创建房间...');
                    }
                    this.createLobbyAndSeed(); // 播种模式：创建并离开
                } else {
                    if (this.settings.debug_mode) {
                        this.log('👑 车头模式：创建房间（仅一次）...');
                    }
                    this.createLobby(); // 普通模式：创建一次
                }
            } else {
                if (this.settings.debug_mode) {
                    this.log('💤 乘客模式：启动轮询，寻找车头房间...');
                }
                this.startPolling(); // 启动轮询机制
            }
        }, 1500);
    }

    // [新增] Follower 轮询机制
    startPolling() {
        if (this.role !== 'FOLLOWER') return;
        
        // 立即执行一次
        this.tryJoinOrPoll();
        
        // 每 5 秒轮询一次（加快轮询频率）
        this.poll_interval = setInterval(() => {
            if (this.state !== 'IN_LOBBY') {
                this.tryJoinOrPoll();
            } else {
                // 已经进房了，停止轮询
                clearInterval(this.poll_interval);
                this.poll_interval = null;
            }
        }, 5000);
    }
    
    // [核心新增] Follower 优先使用确认的 lobbyId 加入
    tryJoinOrPoll() {
        // 1. 向 Manager 申请分配
        if (this.manager && this.role === 'FOLLOWER') {
            const decision = this.manager.requestJoinSlot(this.account.username);
            
            if (decision.action === 'JOIN') {
                if (this.settings.debug_mode) {
                    this.log(`🎯 [分配模式] Manager 分配至: "${decision.roomName}"`);
                }
                this.joinLobbyDirectly(decision.lobbyId);
                return;
            } else if (this.settings.debug_mode) {
                this.log(`⏳ [分配模式] 暂无空位，继续等待/轮询...`);
            }
        }
        
        // 2. 如果没有分配到，使用传统轮询来发现房间并上报状态
        this.requestLobbyList();
    }

    requestLobbyList() {
        if (!this.is_gc_connected) {
            this.log('⚠️ GC 未连接，跳过查询');
            return;
        }

        try {
            const gameId = this.settings.custom_game_id;
            const gameIdLong = Long.fromString(gameId, true);
            const payload = { server_region: 0, custom_game_id: gameIdLong };
            const message = CMsgJoinableCustomLobbiesRequest.create(payload);
            const buffer = CMsgJoinableCustomLobbiesRequest.encode(message).finish();
            
            // [优化] 仅在调试模式下打印请求日志
            if (this.settings.debug_mode) {
                if (this.role === 'FOLLOWER') {
                    this.log(`🔍 轮询房间列表，寻找车队 [${this.fleetId}] 的房间...`);
                } else {
                    this.log(`📤 请求房间列表 (ID: ${gameId})`);
                }
            }
            
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCJoinableCustomLobbiesRequest | k_EMsgProtoMask, {}, buffer);
        } catch (err) { this.error(`请求列表失败: ${err.message}`); }
        }
    createLobby() {
        try {
            const gameIdLong = Long.fromString(this.settings.custom_game_id, true);
            const detailsPayload = {
                customGameId: gameIdLong,        
                gameName: `Bot Room ${this.fleetId}`, // 使用车队 ID 作为房间名
                serverRegion: this.settings.server_region, 
                gameMode: 15,                    
                customMaxPlayers: this.settings.max_players_per_room || 4,
                customMinPlayers: 1,
                allowSpectating: true,
                allchat: true,
                fillWithBots: false,
                allowCheats: false,
                visibility: 0, // Public
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
            
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
            this.log(`🔨 发送创建请求 (房间名: Bot Room ${this.fleetId})`);
            
            // [修复死循环] Leader 创建一次后就停止，不再轮询
            this.state = 'CREATING_LOBBY';
        } catch (err) {
            this.error(`创建房间失败: ${err.message}`);
        }
    }

        // [播种模式] 创建房间并等待小号加入
    createLobbyAndSeed() {
        this.roomsCreated++;
        this.currentRoomNumber = this.roomsCreated; // 记录当前房间编号
        const roomName = `Bot Room ${this.fleetId} #${this.roomsCreated}`;
        
        try {
            // [DEBUG] 打印关键状态（仅调试模式）
            if (this.settings.debug_mode) {
                this.log(`🔧 [创建前状态] roomsCreated=${this.roomsCreated}, currentRoomNumber=${this.currentRoomNumber}, oldLobbyID=${this.currentLobbyId}, oldMemberCount=${this.currentRoomMemberCount}`);
            }

            const gameIdLong = Long.fromString(this.settings.custom_game_id, true);
            const detailsPayload = {
                customGameId: gameIdLong,        
                gameName: roomName,
                serverRegion: this.settings.server_region, 
                gameMode: 15,                    
                customMaxPlayers: this.settings.max_players_per_room || 4,
                customMinPlayers: 1,
                allowSpectating: true,
                allchat: true,
                fillWithBots: false,
                allowCheats: false,
                visibility: 0,
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
            
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
            this.log(`🌱 创建房间: ${roomName}`);
            
            this.state = 'SEEDING';
            this.currentRoomMemberCount = 1; // 重置人数计数（只有自己）
            // [修正] 不在这里清空 lobbyId，避免干扰超时判断
            // this.currentLobbyId = null; // 将在 processLobbyData 中更新
            
            // [关键修复] 立即发送 ReadyUp，激活房间，防止 GC 认为房间无效而删除
            // 连续发送 5 次，每秒一次，确保房间稳定
            let heartbeats = 0;
            const activationInterval = setInterval(() => {
                if (this.state === 'SEEDING') {
                    if (this.settings.debug_mode) {
                        this.log(`🔥 [激活房间 ${heartbeats+1}/5] 发送 ReadyUp 心跳...`);
                    }
                    this.sendReadyUp();
                    heartbeats++;
                    if (heartbeats >= 5) clearInterval(activationInterval);
                    } else {
                    clearInterval(activationInterval);
                }
            }, 1000);
            
            if (this.settings.debug_mode) {
                this.log('⏳ [等待确认] 已发送创建请求，等待 GC 推送 Lobby 数据...');
            }

            // [新增] 创建超时重试机制
            if (this.creationTimeout) clearTimeout(this.creationTimeout);
            this.creationTimeout = setTimeout(() => {
                // 如果 15 秒后还在 SEEDING 状态
                if (this.state === 'SEEDING') {
                    // 只有当确实没有收到正确的房间确认时才重试
                    if (!this.currentLobbyId || this.currentRoomMemberCount === 0) {
                        this.log(`⚠️ 创建房间超时（15秒无确认），重试创建...`);
                        if (this.settings.debug_mode) {
                            this.log(`   [DEBUG] currentLobbyId=${this.currentLobbyId ? this.currentLobbyId.toString() : 'null'}, memberCount=${this.currentRoomMemberCount}`);
                        }
                        
                        // 清空旧状态，强制重新创建
                        this.currentLobbyId = null;
                        this.currentRoomMemberCount = 1;
                        
                        this.roomsCreated--; // 回退计数，重新创建同一个房间
                        this.createLobbyAndSeed();
                    } else if (this.settings.debug_mode) {
                        this.log(`✅ [超时检查] 房间已确认，无需重试`);
                    }
                }
            }, 15000);

        } catch (err) {
            this.error(`播种失败: ${err.message}`);
            }
        }

    // [新增] 主动离开房间
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
        } catch (err) {
            this.error(`离开房间失败: ${err.message}`);
        }
    }

         // [播种模式] 断开重连并创建新房间
    reconnectAndSeed() {
        // 防止重复调用
        if (this.state === 'LEAVING_LOBBY' || this.state === 'RECONNECTING') return;
        
        this.log('🔄 离开房间，准备创建新房间...');
        this.state = 'LEAVING_LOBBY'; // 标记状态，等待 SOCache-25 (Type 18) 移除通知
        
        // 清理所有定时器
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        if (this.poll_interval) {
            clearInterval(this.poll_interval);
            this.poll_interval = null; 
        }
        // [关键修复] 清除创建超时定时器，防止误触发重试
        if (this.creationTimeout) {
            clearTimeout(this.creationTimeout);
            this.creationTimeout = null;
            if (this.settings.debug_mode) {
                this.log('⏱️ 清除创建超时定时器（进入离开流程）');
            }
        }
        
        // [核心] 清除 Manager 中确认的房间
        if (this.manager) {
            if (this.settings.debug_mode) {
                this.log('🗑️ 清除 Manager 中确认的房间...');
            }
            this.manager.clearConfirmedLobby();
        }
                    
        // 发送离开请求
        if (this.is_gc_connected) {
            if (this.settings.debug_mode) {
                this.log('👋 发送离开请求，等待确认...');
            }
            try {
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
            } catch (e) {
                this.error(`发送离开消息失败: ${e.message}`);
            }
        }
        
        // [保底机制] 15秒后如果还没收到确认，强制重连
        setTimeout(() => {
            if (this.state === 'LEAVING_LOBBY') {
                this.log('⚠️ 离开确认超时 (15秒)，强制执行重连...');
                this.performReconnect();
            }
        }, 15000);
    }

    // [核心新增] 执行实际的断开重连操作
    performReconnect() {
        this.state = 'RECONNECTING';
        this.is_gc_connected = false;
        
        // 清空旧状态
        if (this.settings.debug_mode) {
            this.log(`🗑️ 清空旧状态: LobbyID=${this.currentLobbyId}, MemberCount=${this.currentRoomMemberCount}`);
        }
        this.currentLobbyId = null;
        this.currentRoomMemberCount = 1; 
        this.missingRoomCount = 0; 
        
        // 断开 Steam 连接
        this.client.logOff();
                            
        // 增加延时到 5 秒，给 GC 足够时间清理旧房间状态
        setTimeout(() => {
            if (this.settings.debug_mode) {
                this.log('🔌 重新登录，创建新房间...');
            }
            this.start();
        }, 5000);
    }

    joinLobbyDirectly(lobbyIdInput) {
        if (this.state === 'IN_LOBBY') return;
        
        try {
            let lobbyId = lobbyIdInput;
            if (typeof lobbyId === 'string') lobbyId = Long.fromString(lobbyId, true);
            else if (typeof lobbyId === 'number') lobbyId = Long.fromNumber(lobbyId, true);

            if (this.settings.debug_mode) {
                this.log(`🚀 发起定向加入 -> ${lobbyId.toString()}`);
            }

            const payload = {
                lobbyId: lobbyId,
                customGameCrc: Long.fromString(this.knownCrc, true),
                customGameTimestamp: this.knownTimestamp,
                passKey: this.settings.lobby_password
                            };
                            
            const message = CMsgPracticeLobbyJoin.create(payload);
            const buffer = CMsgPracticeLobbyJoin.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyJoin | k_EMsgProtoMask, {}, buffer);
                        } catch (err) {
            this.error(`加入请求构建失败: ${err.message}`);
                        }
    }

    handleGCMessage(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        // [调试模式] 打印所有 GC 消息
        const isImportantMsg = [24, 25, 26, 7055, 7004, 7113, 7170].includes(cleanMsgType);
        const isHighFreq = [7469, 7388, 7036].includes(cleanMsgType);
        
        if (this.settings.debug_mode) {
            if (isImportantMsg) {
                this.log(`🔔 [GC重要消息] ${cleanMsgType} | state=${this.state} | payload.length=${payload.length}`);
            } else if (!isHighFreq) {
                this.log(`🔔 [GC消息] ${cleanMsgType} | state=${this.state}`);
            }
        }

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
             if (!this.is_gc_connected) {
                 if (this.settings.debug_mode) {
                     this.log('✅ GC 连接确认');
                 }
                 this.is_gc_connected = true;
                 this.startArcadeFlow();
                        }
        }
        // 监听房间列表响应 (7469)
        else if (cleanMsgType === k_EMsgGCJoinableCustomLobbiesResponse) {
            try {
                const response = CMsgJoinableCustomLobbiesResponse.decode(payload);
                const targetId = this.settings.custom_game_id;
                
                const myLobbies = (response.lobbies || []).filter(l => 
                    (l.customGameId ? l.customGameId.toString() : '0') === targetId
                );

                // [新增] 共享状态上报：Follower 看到的房间信息是最准确的
                // 将看到的所有车队房间状态上报给 Manager，供 Leader 决策
                if (this.role === 'FOLLOWER' && this.manager) {
                    myLobbies.forEach(l => {
                        if (l.lobbyName && l.lobbyName.includes(this.fleetId)) {
                            this.manager.updateRoomState(l.lobbyName, l.lobbyId, l.memberCount);
                            // [调试] 打印上报信息
                            if (this.settings.debug_mode) {
                                this.log(`🔔 [上报] 房间 "${l.lobbyName}" ID:${l.lobbyId} 人数: ${l.memberCount}`);
                            }
                        }
                    });
                    }
                    
                // [调试打印] 打印所有扫描到的房间详情
                if (this.settings.debug_mode) {
                    this.log(`📊 [DEBUG] 扫描到 ${myLobbies.length} 个相关房间:`);
                    myLobbies.forEach((l, idx) => {
                        this.log(`   [${idx+1}] ID:${l.lobbyId} | Name:"${l.lobbyName}" | Leader:${l.leaderAccountId} | Mem:${l.memberCount}/${l.maxPlayerCount}`);
                    });
                    if (this.role === 'LEADER') {
                        this.log(`   🎯 Leader当前目标: ID=${this.currentLobbyId ? this.currentLobbyId.toString() : 'null'} | Name="Bot Room ${this.fleetId} #${this.currentRoomNumber}"`);
                    }
                }

                if (this.role === 'FOLLOWER') {
                    // [新增] 健康检查：如果已经在房间里，检查房间是否还存在
                    if (this.state === 'IN_LOBBY' && this.currentLobbyId) {
                        const myRoomStillExists = myLobbies.find(l => 
                            l.lobbyId && l.lobbyId.toString() === this.currentLobbyId.toString()
                        );
                
                        if (myRoomStillExists) {
                            // 房间还在，重置计数器
                            this.myRoomMissingCount = 0;
                            this.myRoomLastSeen = Date.now();
                        } else {
                            // 房间不见了，累加计数
                            this.myRoomMissingCount++;
                            
                            if (this.myRoomMissingCount >= 5) {
                                this.log(`💀 房间已解散（连续 ${this.myRoomMissingCount} 次未找到），退出并重新寻找...`);
                                
                                // 清理状态
                                this.state = 'ONLINE';
                                this.currentLobbyId = null;
                                this.myRoomMissingCount = 0;
                                
                                if (this.ready_up_heartbeat) {
                                    clearInterval(this.ready_up_heartbeat);
                                    this.ready_up_heartbeat = null;
                                }
                                
                                // 发送离开消息（虽然房间可能已不存在，但保险起见）
                                try {
                                    this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                                } catch(e) {}
                                
                                // 继续轮询（poll_interval 应该还在运行）
                                this.log(`🔄 重新进入轮询模式...`);
                                return; // 跳过后续逻辑
                            }
                        }
                    }
                    
                     // [修改] 移除了自动加入逻辑，完全依赖 Manager 分配
                    if (this.state !== 'IN_LOBBY') {
                        // [调试模式] 设置每个房间最大Bot数量（给玩家预留观察位）
                        const debugMode = this.settings.debug_mode || false;
                        const maxBotsPerRoom = debugMode ? (this.settings.debug_max_bots_per_room || 3) : this.settings.max_players_per_room;
                        
                        if (this.settings.debug_mode) {
                            this.log(`⏳ [被动模式] 已上报房间信息，等待 Manager 分配...`);
                        }
                    }
                }
                // [Leader 逻辑] - 仅保留调试信息
                else if (this.role === 'LEADER' && this.settings.debug_mode) {
                    // 只是简单打印，不做逻辑判断
                    this.log(`🔍 [DEBUG] Leader 收到了房间列表响应，忽略...`);
                }

            } catch (e) {
                this.error(`解析列表失败: ${e.message}`); 
            }
        }
        // 监听 Lobby Snapshot (7004) - 这是最关键的信息源
        else if (cleanMsgType === 7004) { 
             try {
                 const lobby = CSODOTALobby.decode(payload);
                 if (lobby.lobbyId) {
                    const oldLobbyId = this.currentLobbyId;
                    this.currentLobbyId = lobby.lobbyId;
                    
                    if (this.settings.debug_mode) {
                        this.log(`🆔 [ID更新] 从 ${oldLobbyId ? oldLobbyId.toString() : 'null'} -> ${lobby.lobbyId.toString()}`);
                    }
                    
                    // [播种模式] Leader 混合检测模式：优先使用 Snapshot，轮询作为兜底
                    if (this.role === 'LEADER' && this.isSeeding) {
                        const newMemberCount = (lobby.members && lobby.members.length) || 0;
                        
                        if (this.settings.debug_mode) {
                            this.log(`📩 收到 Lobby Snapshot, 人数=${newMemberCount}`);
                        }
                        
                        // [补丁] 强制发送 ReadyUp 以激活房间状态
                        if (newMemberCount === 1 && this.state === 'SEEDING') {
                             if (this.settings.debug_mode) {
                                 this.log('💓 发送强制心跳以激活新房间...');
                             }
                             this.sendReadyUp(lobby.lobbyId);
                        }

                        // 重置轮询的"找不到房间"计数器，因为我们确信房间存在且我们在里面
                        this.missingRoomCount = 0;

                        if (newMemberCount > this.currentRoomMemberCount) {
                            if (this.settings.debug_mode) {
                                this.log(`👥 检测到新成员 (${this.currentRoomMemberCount} -> ${newMemberCount})`);
                            }
                            this.currentRoomMemberCount = newMemberCount;
             
                            this.reconnectAndSeed();
                        }
                            return;
                        }
                        
                    if (this.settings.debug_mode) {
                        this.log(`📩 收到 Lobby Snapshot, ID=${lobby.lobbyId.toString()}`);
                    }
                    this.onEnterLobby(true);
             }
            } catch(e) {}
        }
        // ============================================
        // [核心新增] 监听 7055 - 房间创建响应
        // ============================================
        else if (cleanMsgType === k_EMsgGCPracticeLobbyResponse) {
            if (this.settings.debug_mode) {
                this.log(`📨 [7055] ===== 收到 PracticeLobbyResponse =====`);
                this.log(`📨 [7055] payload.length = ${payload.length}`);
            }
            
            // 尝试解析响应
            try {
                // 7055 可能包含 DOTAJoinLobbyResult 
                // 尝试读取第一个字节（varint）
                if (payload.length > 0) {
                    // 使用 protobuf varint 解码
                    let resultCode = 0;
                    let shift = 0;
                    for (let i = 0; i < Math.min(payload.length, 10); i++) {
                        const byte = payload[i];
                        resultCode |= (byte & 0x7F) << shift;
                        if ((byte & 0x80) === 0) break;
                        shift += 7;
                    }
                    
                    const resultName = JoinResultName[resultCode] || `UNKNOWN_${resultCode}`;
                    
                    if (this.settings.debug_mode) {
                        this.log(`📨 [7055] Result Code: ${resultCode} (${resultName})`);
                        
                        if (resultCode === DOTAJoinLobbyResult.DOTA_JOIN_RESULT_SUCCESS) {
                            this.log(`📨 [7055] ✅ 房间操作成功！`);
                        } else {
                            this.log(`📨 [7055] ❌ 房间操作失败: ${resultName}`);
                        }
                        
                        // 打印原始 payload 用于调试
                        this.log(`📨 [7055] Raw payload (hex): ${payload.slice(0, 32).toString('hex')}...`);
                    }
                }
                
            } catch (e) {
                if (this.settings.debug_mode) {
                    this.log(`📨 [7055] 解析失败: ${e.message}`);
                }
            }
        }
        // ============================================
        // [核心新增] 监听 SOCache 消息 (24/25/26) 获取 Lobby 信息
        // ============================================
        else if (cleanMsgType === k_EMsgGCSOCacheSubscribed) {
            if (this.settings.debug_mode) {
                this.log(`📦 [SOCache-24] ===== 收到 CMsgSOCacheSubscribed =====`);
            }
            try {
                const msg = CMsgSOCacheSubscribed.decode(payload);
                if (this.settings.debug_mode) {
                    this.log(`📦 [SOCache-24] objects.length = ${msg.objects?.length || 0}`);
                }
                
                // 遍历所有类型的对象
                (msg.objects || []).forEach((typeObj, idx) => {
                    if (this.settings.debug_mode) {
                        this.log(`📦 [SOCache-24]   [${idx}] typeId=${typeObj.typeId}, objectData.length=${typeObj.objectData?.length || 0}`);
                    }
                    
                    if (typeObj.typeId === SOCACHE_TYPE_LOBBY) {
                        if (this.settings.debug_mode) {
                            this.log(`📦 [SOCache-24]   🎯 发现 CSODOTALobby 类型!`);
                        }
                        (typeObj.objectData || []).forEach((data, dataIdx) => {
                            this.processLobbyData(data, `SOCache-24[${idx}][${dataIdx}]`);
                        });
                    }
                });
            } catch (e) {
                this.log(`📦 [SOCache-24] 解析失败: ${e.message}`);
            }
        }
        else if (cleanMsgType === k_EMsgGCSOSingleObject) {
            if (this.settings.debug_mode) {
                this.log(`📦 [SOCache-25] ===== 收到 CMsgSOSingleObject ===== (payload: ${payload.length} bytes)`);
            }
            let typeId = 0;
            
            try {
                // 尝试安全解码
                const msg = CMsgSOSingleObject.decode(payload);
                typeId = msg.typeId;
                if (this.settings.debug_mode) {
                    this.log(`📦 [SOCache-25] ✅ 解析成功! typeId = ${typeId}`);
                    this.log(`📦 [SOCache-25]   objectData.length = ${msg.objectData ? msg.objectData.length : 0}`);
                }
                
                if (typeId === SOCACHE_TYPE_LOBBY) {
                    if (this.settings.debug_mode) {
                        this.log(`📦 [SOCache-25] 🎯 发现 CSODOTALobby 类型!`);
                    }
                    this.processLobbyData(msg.objectData, 'SOCache-25');
                }
            } catch (e) {
                if (this.settings.debug_mode) {
                    this.log(`📦 [SOCache-25] ❌ 解析失败: ${e.message}`);
                }
                
                // [补丁] 如果是 13 字节的短消息，尝试直接读取 typeId (varint)
                if (payload.length < 20) {
                    try {
                        let shift = 0;
                        for (let i = 0; i < 5 && i < payload.length; i++) {
                            const b = payload[i];
                            typeId |= (b & 0x7F) << shift;
                            if ((b & 0x80) === 0) break;
                            shift += 7;
                        }
                        if (this.settings.debug_mode) {
                            this.log(`📦 [SOCache-25] [RawRead] 尝试直接读取 typeId: ${typeId}`);
                        }
                    } catch (err) {}
                }
            }

            // [核心] 处理 Type 18 作为离开确认
            if (typeId === 18) {
                if (this.settings.debug_mode) {
                    this.log(`📦 [SOCache-25] 🔍 收到 Type 18 (Party/Team Update)`);
                }
                
                // 如果正在等待离开确认
                if (this.role === 'LEADER' && this.state === 'LEAVING_LOBBY') {
                    this.log('✅ 离开确认成功');
                    this.performReconnect();
                }
            }
        }
        else if (cleanMsgType === k_EMsgGCSOMultipleObjects) {
            if (this.settings.debug_mode) {
                this.log(`📦 [SOCache-26] ===== 收到 CMsgSOMultipleObjects =====`);
            }
            try {
                const msg = CMsgSOMultipleObjects.decode(payload);
                const modified = msg.objectsModified || [];
                const added = msg.objectsAdded || [];
                const removed = msg.objectsRemoved || [];
                
                if (this.settings.debug_mode) {
                    this.log(`📦 [SOCache-26] modified=${modified.length}, added=${added.length}, removed=${removed.length}`);
                }
                
                // 详细打印 removed 对象
                if (removed.length > 0 && this.settings.debug_mode) {
                    this.log(`📦 [SOCache-26] 🗑️ ===== 检测到 ${removed.length} 个对象被移除 =====`);
                    removed.forEach((obj, idx) => {
                        this.log(`📦 [SOCache-26]   移除[${idx}] typeId=${obj.typeId}`);
                        if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                            this.log(`📦 [SOCache-26]   ✅ Lobby 对象(2004)已移除！`);
                        }
                    });
                }
                
                [...modified, ...added].forEach((obj, idx) => {
                    if (this.settings.debug_mode) {
                        this.log(`📦 [SOCache-26]   [${idx}] typeId=${obj.typeId}`);
                    }
                    
                    if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                        if (this.settings.debug_mode) {
                            this.log(`📦 [SOCache-26]   🎯 发现 CSODOTALobby 类型!`);
                        }
                        this.processLobbyData(obj.objectData, `SOCache-26[${idx}]`);
                    }
                });
            } catch (e) {
                this.log(`📦 [SOCache-26] 解析失败: ${e.message}`);
            }
        }
         // 监听加入结果 (7113)
        else if (cleanMsgType === k_EMsgGCPracticeLobbyJoinResponse) {
             try {
                const response = CMsgPracticeLobbyJoinResponse.decode(payload);
                const resultCode = response.result || 0;
                const resultName = JoinResultName[resultCode] || `UNKNOWN_${resultCode}`;
                
                if (resultCode === DOTAJoinLobbyResult.DOTA_JOIN_RESULT_SUCCESS) {
                    if (this.settings.debug_mode) {
                        this.log('✅ 加入成功 (7113)');
                    }
                    this.onEnterLobby();
                } else {
                    // 详细打印失败原因
                    this.log(`❌ 加入失败: ${resultName}`);
                    
                    if (this.settings.debug_mode) {
                        // 根据错误码给出更详细的说明
                        switch (resultCode) {
                            case DOTAJoinLobbyResult.DOTA_JOIN_RESULT_INVALID_LOBBY:
                                this.log(`   ⚠️ 房间无效/不存在 - GC 可能还未同步或房间已解散`);
                                break;
                            case DOTAJoinLobbyResult.DOTA_JOIN_RESULT_LOBBY_FULL:
                                this.log(`   ⚠️ 房间已满`);
                                break;
                            case DOTAJoinLobbyResult.DOTA_JOIN_RESULT_INCORRECT_PASSWORD:
                                this.log(`   ⚠️ 密码错误`);
                                break;
                            case DOTAJoinLobbyResult.DOTA_JOIN_RESULT_CUSTOM_GAME_INCORRECT_VERSION:
                                this.log(`   ⚠️ 自定义游戏版本不匹配`);
                                break;
                        }
                    }
                    
                    // 如果是 Leader 失败，可能需要重试创建
                    if (this.role === 'LEADER') {
                         setTimeout(() => this.createLobby(), 5000);
                    }
                }
             } catch(e) {
                 if (this.settings.debug_mode) {
                     this.log(`❌ [7113] 解析响应失败: ${e.message}`);
                 }
             }
        }
        // 监听 Lobby Update (7430/7367)
        else if (cleanMsgType === 7430 || cleanMsgType === 7367) {
             if (this.state !== 'IN_LOBBY') {
                 // 补丁：确认已进房
                 this.onEnterLobby(true);
             }
        }
        // 监听 ReadyUpStatus (7170) - 自动接受
        else if (cleanMsgType === k_EMsgGCReadyUpStatus) {
             try {
                 const status = CMsgReadyUpStatus.decode(payload);
                if (status.lobbyId) this.currentLobbyId = status.lobbyId;
                
                // [修复] Leader 在播种模式下，收到 ReadyUpStatus 确认我们在房间里
                if (this.role === 'LEADER' && this.isSeeding && this.state === 'SEEDING') {
                     // 如果此时还没确认房间 ID，可以利用这个消息来确认（虽然通常 SOCache 更早）
                     if (!this.currentLobbyId && status.lobbyId && this.settings.debug_mode) {
                         this.log(`🔍 [ReadyUpStatus] 确认房间 ID: ${status.lobbyId}`);
                     }
                }
                
                setTimeout(() => this.sendReadyUp(this.currentLobbyId), 200);
            } catch(e) {}
        }
    }

    // ============================================
    // [核心新增] 处理从 SOCache 获取的 Lobby 数据
    // ============================================
    processLobbyData(objectData, source) {
        if (!objectData || objectData.length === 0) {
            if (this.settings.debug_mode) {
                this.log(`📦 [${source}] objectData 为空，跳过`);
            }
            return;
        }
        
        try {
            const lobby = CSODOTALobby.decode(objectData);
            
            // 获取关键信息
            const lobbyId = lobby.lobbyId;
            const gameName = lobby.gameName || '';
            const leaderId = lobby.leaderId;
            const state = lobby.state; // 0=UI, 1=SERVERSETUP, 2=RUN, 3=POSTGAME, 4=READYUP, 5=NOTREADY, 6=SERVERASSIGN
            const allMembers = lobby.allMembers || [];
            const memberCount = allMembers.length;
            const customGameId = lobby.customGameId;
            
            if (this.settings.debug_mode) {
                this.log(`📦 [${source}] ========== Lobby 解析成功 ==========`);
                this.log(`📦 [${source}]   lobbyId: ${lobbyId ? lobbyId.toString() : 'null'}`);
                this.log(`📦 [${source}]   gameName: "${gameName}"`);
                this.log(`📦 [${source}]   leaderId: ${leaderId ? leaderId.toString() : 'null'}`);
                this.log(`📦 [${source}]   state: ${state}`);
                this.log(`📦 [${source}]   memberCount: ${memberCount}`);
                this.log(`📦 [${source}]   customGameId: ${customGameId ? customGameId.toString() : 'null'}`);
            
                // 详细打印成员列表
                if (allMembers.length > 0) {
                    this.log(`📦 [${source}]   👥 房间成员列表 (${allMembers.length}人):`);
                    const mySteamId = this.steamClient?.steamID?.getSteamID64();
                    allMembers.forEach((member, idx) => {
                        const memberId = member.id ? member.id.toString() : 'unknown';
                        const isMe = mySteamId && memberId === mySteamId;
                        this.log(`📦 [${source}]      [${idx}] id=${memberId}${isMe ? ' 👈 (我)' : ''}`);
                    });
                    
                    // 检查自己是否还在房间
                    const imInRoom = allMembers.some(m => m.id && m.id.toString() === mySteamId);
                    this.log(`📦 [${source}]   🔍 我是否在房间内: ${imInRoom ? '✅ 是' : '❌ 否'}`);
                }
                
                this.log(`📦 [${source}] =====================================`);
            }
            
            // 如果有 lobbyId，更新当前状态
            if (lobbyId) {
                const oldLobbyId = this.currentLobbyId;
                this.currentLobbyId = lobbyId;
                
                if (this.settings.debug_mode && (!oldLobbyId || oldLobbyId.toString() !== lobbyId.toString())) {
                    this.log(`📦 [${source}] 🆔 更新 currentLobbyId: ${oldLobbyId ? oldLobbyId.toString() : 'null'} -> ${lobbyId.toString()}`);
                }
                
                // [核心] Leader 在播种模式下，确认房间创建成功
                if (this.role === 'LEADER' && this.isSeeding && this.state === 'SEEDING') {
                    // 检查房间名是否匹配当前正在创建的房间
                    const expectedRoomName = `Bot Room ${this.fleetId} #${this.currentRoomNumber}`;
                    
                    if (gameName === expectedRoomName || gameName.includes(this.fleetId)) {
                        // ✅ 房间名匹配，现在才清除重试定时器
                        if (this.creationTimeout) {
                            clearTimeout(this.creationTimeout);
                            this.creationTimeout = null;
                            if (this.settings.debug_mode) {
                                this.log(`📦 [${source}] ⏱️ 清除创建超时定时器`);
                            }
                        }
                        
                        this.log(`✅ 房间 "${gameName}" 创建成功 (人数: ${memberCount})`);
                        if (this.settings.debug_mode) {
                            this.log(`📦 [${source}]    房间ID: ${lobbyId.toString()}`);
                        }
                        
                        // 更新成员计数
                        this.currentRoomMemberCount = memberCount;
                        
                        // 重置 missingRoomCount，因为我们确认房间存在
                        this.missingRoomCount = 0;
                        
                        // 通知 FleetManager 设置确认的房间
                        if (this.manager) {
                            this.manager.setConfirmedLobby(lobbyId, gameName, this.currentRoomNumber, memberCount);
                        }
                        
                        // 检测人数变化（有人加入）
                        if (memberCount > 1) {
                            this.log(`👥 Follower 已加入 (${memberCount}人)`);
                            
                            // 清除确认的房间（因为我们要离开了）
                            if (this.manager) {
                                this.manager.clearConfirmedLobby();
                            }
                            
                            // 触发重连
                            this.reconnectAndSeed();
                        }
                    } else if (this.settings.debug_mode) {
                        this.log(`📦 [${source}] ⚠️ 房间名不匹配: 期望"${expectedRoomName}", 实际"${gameName}"`);
                    }
                }
                
                // Follower 也可以通过 SOCache 确认加入成功
                if (this.role === 'FOLLOWER' && this.state !== 'IN_LOBBY') {
                    // 检查是否是我们车队的房间
                    if (gameName.includes(this.fleetId)) {
                        this.log(`✅ 成功加入房间: "${gameName}"`);
                        this.onEnterLobby(true);
                    }
                }
            }
            
        } catch (e) {
            this.log(`📦 [${source}] CSODOTALobby 解析失败: ${e.message}`);
            if (this.settings.debug_mode) {
                // 打印部分原始数据用于调试
                this.log(`📦 [${source}] Raw data (hex, first 64 bytes): ${objectData.slice(0, 64).toString('hex')}`);
            }
        }
    }

    onEnterLobby(isSnapshot = false) {
        // [修正] Leader 在播种模式下，必须保持 SEEDING 状态，不能变成 IN_LOBBY
        // 否则会导致 7004 消息处理逻辑中无法启动轮询
        if (this.role === 'LEADER' && this.isSeeding) {
            if (this.settings.debug_mode) {
                this.log('🏁 [播种模式] 保持 SEEDING 状态，执行进房初始化...');
            }
        } else {
            if (this.state === 'IN_LOBBY') return;
            this.state = 'IN_LOBBY';
            if (this.settings.debug_mode) {
                this.log('🏁 进入房间状态维护模式');
            }
                 }
                 
        // 设置队伍 & 初始 Ready
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
        if (this.poll_interval) clearInterval(this.poll_interval); // 清理轮询定时器
        if (this.is_gc_connected) {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        }
        this.client.logOff();
    }
}

// --- Main ---
// [新增] 解析命令行参数
const args = process.argv.slice(2);
const isDebugMode = args.includes('debug');

let config;
             try {
    const rawContent = fs.readFileSync('./config.json', 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(rawContent);
             } catch (e) {
    console.error("❌ 读取配置失败: " + e.message);
    process.exit(1);
}

const fleets = config.fleets || [];
const globalSettings = config.global_settings;

// [新增] 强制覆盖 debug_mode 配置，使用命令行参数
globalSettings.debug_mode = isDebugMode;

if (fleets.length === 0) {
    console.error("❌ 未找到车队配置 (config.fleets)");
    process.exit(1);
}

if (isDebugMode) {
    console.log(`[System] 🚀 启动模式: 调试模式 (详细日志)`);
    console.log(`[System] 加载了 ${fleets.length} 个车队配置`);
} else {
    console.log(`[System] 🚀 Dota2 Arcade Bot 启动 (生产模式)`);
    console.log(`[System] 车队数量: ${fleets.length}`);
    
    // 统计总 Bot 数量
    const totalBots = fleets.reduce((sum, f) => sum + 1 + (f.followers?.length || 0), 0);
    console.log(`[System] Bot 总数: ${totalBots} (${fleets.reduce((sum, f) => sum + 1, 0)} Leaders + ${fleets.reduce((sum, f) => sum + (f.followers?.length || 0), 0)} Followers)`);
    console.log(`[System] 开始连接 Steam 并创建房间...\n`);
}

const fleetManagers = [];

fleets.forEach(fleetConfig => {
    const fleet = new FleetManager(fleetConfig, globalSettings);
    fleetManagers.push(fleet);
    fleet.start();
});

process.on('SIGINT', () => {
    if (!isDebugMode) {
        process.stdout.write('\n'); // 清除进度条
    }
    console.log("\n[System] 正在退出...");
    fleetManagers.forEach(f => f.cleanup());
    setTimeout(() => process.exit(0), 2000);
});

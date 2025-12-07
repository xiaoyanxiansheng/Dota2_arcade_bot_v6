const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

// [新增] 读取代理列表
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

// 服务器区域名称映射
const RegionNameMap = {
    0: "Auto", 1: "US West", 2: "US East", 3: "Europe", 5: "Singapore", 
    6: "Dubai", 7: "Australia", 8: "Stockholm", 9: "Austria", 
    10: "Brazil", 11: "South Africa", 12: "PW Telecom", 13: "PW Unicom", 
    14: "Chile", 15: "Peru", 16: "India", 17: "Reg:17", 18: "Reg:18", 
    19: "Japan", 20: "Reg:20", 25: "PW Tianjin"
};

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
    constructor(fleetConfig, globalSettings, globalAccountOffset = 0) {
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
        
        // [新增] 全局账号偏移量（用于多车队代理分配）
        this.globalAccountOffset = globalAccountOffset;
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

    start(leaderIndex = 0) {
        if (this.settings.debug_mode) {
            console.log(`\n[Fleet:${this.id}] 🚀 车队启动! Leader: ${this.config.leader.username}`);
        }

        // [新增] 代理分配参数
        const accountsPerProxy = this.settings.accounts_per_proxy;
        if (proxies.length > 0 && this.settings.debug_mode && this.globalAccountOffset === 0) {
            console.log(`[System] 代理分配策略: 主号固定 IP，小号每 ${accountsPerProxy} 个账号使用 1 个 IP`);
        }

        // 1. 启动 Leader (传入 fleetId 和 manager)
        // [关键修改] Leader 固定使用对应编号的代理（leaderIndex 对应 proxyIndex）
        let leaderProxy = null;
        let leaderProxyIndex = leaderIndex;
        if (proxies.length > 0) {
            leaderProxy = proxies[leaderIndex]; // 主号1用代理1，主号2用代理2，依此类推
        }
        const leaderBot = new BotClient(this.config.leader, this.settings, 'LEADER', this.id, this, leaderProxy, leaderProxyIndex);
        this.bots.push(leaderBot);
        leaderBot.start();

        // 2. 启动 Followers (错峰，传入 fleetId 和 manager)
        this.config.followers.forEach((acc, idx) => {
            setTimeout(() => {
                if (this.settings.debug_mode) {
                    console.log(`[Fleet:${this.id}] 启动 Follower ${idx+1}: ${acc.username}`);
                }
                
                // [关键修改] Follower 从主号数量之后的代理开始分配
                let followerProxy = null;
                let followerProxyIndex = 0;
                if (proxies.length > 0) {
                    // 全局小号索引（跨车队）
                    const globalFollowerIndex = this.globalAccountOffset + idx;
                    // 从主号数量之后的代理开始，按 accountsPerProxy 分配
                    followerProxyIndex = (leaderIndex + 1) + Math.floor(globalFollowerIndex / accountsPerProxy);
                    followerProxy = proxies[followerProxyIndex % proxies.length];
                }

                const bot = new BotClient(acc, this.settings, 'FOLLOWER', this.id, this, followerProxy, followerProxyIndex % proxies.length);
                this.bots.push(bot);
                bot.start();
            }, idx * 10); // 批量快速启动，10ms间隔
        });
        
        // 3. [已移除] 进度监控现在由全局统一管理，不再在车队级别启动
        // 全局进度监控器会统计所有车队的总进度
    }

    cleanup() {
        this.stopProgressMonitor(); // 停止进度监控
        
        let successCount = 0;
        let totalBots = this.bots.length;
        
        console.log(`\n[Fleet:${this.id}] 🧹 开始清理 ${totalBots} 个账号...`);
        
        this.bots.forEach((bot, idx) => {
            try {
                const cleaned = bot.cleanup();
                if (cleaned) {
                    successCount++;
                    console.log(`  ✅ [${idx + 1}/${totalBots}] ${bot.account.username}`);
                }
            } catch (err) {
                console.log(`  ❌ [${idx + 1}/${totalBots}] ${bot.account.username} - ${err.message}`);
            }
        });
        
        console.log(`[Fleet:${this.id}] 完成: ${successCount}/${totalBots} 个账号已发送退出命令`);
        
        return successCount;
    }
                }
                
// --- Bot Client ---
class BotClient {
    constructor(account, settings, role, fleetId, manager, proxy, proxyIndex = 0) {
        this.account = account;
        this.settings = settings;
        this.role = role; // 'LEADER' | 'FOLLOWER'
        this.fleetId = fleetId; // 车队 ID，用于识别房间
        this.manager = manager; // [新增] 全局管理器引用
        this.proxy = proxy; // [新增] 代理地址
        this.initialProxyIndex = proxyIndex; // [新增] 记录初始代理索引
        this.currentProxyIndex = proxyIndex; // [新增] 当前使用的代理索引

        // [关键修改] 使用共享验证数据目录（项目外部），支持多项目共享
        const sharedDataPath = settings.shared_steam_data_path || "../shared_steam_data";
        const steamDataDir = path.resolve(projectRoot, sharedDataPath);
        
        const steamOptions = {
            dataDirectory: steamDataDir
        };
        
        if (this.proxy) {
            steamOptions.httpProxy = this.proxy;
            if (this.settings.debug_mode) {
                // 简单的代理脱敏显示
                const proxyDisplay = this.proxy.replace(/:[^:@]+@/, ':****@');
                console.log(`[${this.account.username}] 🛡️ 使用代理: ${proxyDisplay}`);
            }
        }

        this.client = new SteamUser(steamOptions);
        
        // [关键] 立即添加永久错误处理器，防止未处理的错误导致程序崩溃
        // 注意：这个处理器应该永远存在，setupListeners() 中不应该移除它
        this.handleClientError = this.handleClientError.bind(this);
        this.client.on('error', this.handleClientError);
        
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
        
        // [新增] 重试计数器
        this.retryCount = 0; // 连接失败重试次数
        this.proxyFailCount = 0; // [新增] 当前代理失败次数
        this.maxProxyRetries = 1; // [新增] 单个代理最大重试次数（1次失败就换）

        this.setupListeners();
    }
    
    // [新增] 切换到下一个代理并重新登录
    switchProxyAndRetry() {
        // [关键] 主号不允许切换代理，因为和 Steam 验证绑定
        if (this.role === 'LEADER') {
            this.log('⚠️ 主号不允许切换代理（IP 与验证绑定），使用原代理重试...');
            
            // [新增] 先尝试断开连接，防止 Already logged on 错误
            try {
                this.client.logOff();
            } catch (e) {}

            // 主号无限重试，直到成功
            this.retryCount = (this.retryCount || 0) + 1;
            
            // 计算延迟时间，最大不超过 30 秒
            const delay = Math.min(this.retryCount * 5000, 60000);
            
            this.log(`🔄 主号第 ${this.retryCount} 次重试登录... (等待 ${delay/1000} 秒)`);
            
            setTimeout(() => {
                this.start();
            }, delay);
            
            return;
        }
        
        if (proxies.length === 0) {
            this.error('❌ 没有可用代理，无法切换');
            return;
        }
        
        // 切换到下一个代理（仅限小号）
        this.currentProxyIndex = (this.currentProxyIndex + 1) % proxies.length;
        const newProxy = proxies[this.currentProxyIndex];
        
        const proxyDisplay = newProxy.replace(/:[^:@]+@/, ':****@');
        this.log(`🔄 切换代理: ${proxyDisplay} (第 ${this.currentProxyIndex + 1}/${proxies.length} 个)`);
        
        // 重置代理失败计数
        this.proxyFailCount = 0;
        
        // 创建新的 Steam 客户端（使用新代理）
        try {
            // 清理旧客户端
            if (this.client) {
                this.client.removeAllListeners();
                try {
                    this.client.logOff();
                } catch (e) {}
            }
            
            // 创建新客户端（使用共享验证数据目录）
            const sharedDataPath = this.settings.shared_steam_data_path || "../shared_steam_data";
            const steamDataDir = path.resolve(projectRoot, sharedDataPath);
            
            const steamOptions = {
                dataDirectory: steamDataDir,
                httpProxy: newProxy
            };
            
            this.client = new SteamUser(steamOptions);
            this.proxy = newProxy;
            
            // [关键] 立即添加统一的错误处理器
            this.client.on('error', this.handleClientError);
            
            // 重新设置监听器（会添加其他事件的处理）
            this.setupListeners();
            
            // 重置状态
            this.state = 'OFFLINE';
            this.currentLobbyId = null;
            this.is_gc_connected = false;
            
            // 立即重新登录
            this.log(`🚀 使用新代理重新登录...`);
            this.start();
            
        } catch (err) {
            this.error(`切换代理失败: ${err.message}`);
        }
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
    
    // [新增] 统一的错误处理方法
    handleClientError(err) {
        // [新增] 收到错误说明有响应，清除登录超时定时器
        if (this.loginTimeout) {
            clearTimeout(this.loginTimeout);
            this.loginTimeout = null;
        }
        
        this.error(`Steam 客户端错误: ${err.message}`);
        
        // 针对 LoggedInElsewhere 的特殊处理
        // [重要] LoggedInElsewhere 说明账号在其他地方登录，重试通常无效
        // 直接放弃该账号，不再尝试
        if (err.message === 'LoggedInElsewhere') {
            this.error(`⛔ 账号在其他地方登录，已放弃（请先运行 clear_all.js 清理）`);
            
            // [关键] 标记为 ABANDONED 状态，阻止所有后续操作
            this.state = 'ABANDONED';
            
            // 清理所有定时器
            if (this.ready_up_heartbeat) {
                clearInterval(this.ready_up_heartbeat);
                this.ready_up_heartbeat = null;
            }
            if (this.poll_interval) {
                clearInterval(this.poll_interval);
                this.poll_interval = null;
            }
            if (this.creationTimeout) {
                clearTimeout(this.creationTimeout);
                this.creationTimeout = null;
            }
            if (this.loginTimeout) {
                clearTimeout(this.loginTimeout);
                this.loginTimeout = null;
            }
            
            this.currentLobbyId = null;
            this.is_gc_connected = false;
            
            // 尝试强制断开
            try {
                this.client.logOff();
            } catch (e) {}
            
            return;
        }
        
        // 针对 RateLimitExceeded 的特殊处理
        if (err.message === 'RateLimitExceeded') {
            this.log(`⚠️ Steam 限流 - 等待 60 秒后重试`);
            
            // 清理状态
            this.state = 'OFFLINE';
            this.currentLobbyId = null;
            this.is_gc_connected = false;
            
            // 等待 60 秒后重试
            setTimeout(() => {
                this.log(`🔄 限流结束，重新登录...`);
                this.start();
            }, 60000);
            return;
        }
        
        // [关键优化] 针对代理严重超时 - 立即切换代理
        if (err.message.includes('Proxy connection timed out')) {
            this.log(`🛑 代理连接严重超时 - 立即废弃当前代理并切换`);
            this.proxyFailCount = this.maxProxyRetries + 1;
            this.switchProxyAndRetry();
            return;
        }
        
        // 针对其他网络/代理错误
        if (err.message.includes('timed out') || err.message.includes('ETIMEDOUT') || err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED')) {
            this.proxyFailCount++;
            this.log(`⚠️ 网络/代理连接不稳定 (${this.proxyFailCount}/${this.maxProxyRetries})`);
            
            // 如果是主号，强制无限重试
            if (this.role === 'LEADER') {
                this.retryCount = (this.retryCount || 0) + 1;
                const delay = Math.min(this.retryCount * 5000, 30000);
                
                setTimeout(() => {
                    try { this.client.logOff(); } catch (e) {} 
                    this.log(`🔄 主号网络波动，第 ${this.retryCount} 次重试登录... (等待 ${delay/1000} 秒)`);
                    this.start();
                }, delay);
                return;
            }

            // 立即切换到下一个代理
            if (proxies.length > 1) {
                this.switchProxyAndRetry();
            } else if (proxies.length === 1) {
                // 只有一个代理，尝试重试
                this.retryCount = (this.retryCount || 0) + 1;
                if (this.retryCount < 3) {
                    setTimeout(() => {
                        try { this.client.logOff(); } catch (e) {} // [新增] 重试前断开
                        this.log(`🔄 第 ${this.retryCount} 次重试登录...`);
                        this.start();
                    }, 5000);
                } else {
                    this.error(`❌ 已重试 3 次仍失败，放弃该账号`);
                }
            } else {
                // 没有代理，直接重试
                this.retryCount = (this.retryCount || 0) + 1;
                if (this.retryCount < 3) {
                    setTimeout(() => {
                        try { this.client.logOff(); } catch (e) {} // [新增] 重试前断开
                        this.log(`🔄 第 ${this.retryCount} 次重试登录...`);
                        this.start();
                    }, 5000);
                } else {
                    this.error(`❌ 已重试 3 次仍失败，放弃该账号`);
                }
            }
        }
    }

    start() {
        // [修复] 如果账号已被放弃，不再尝试登录
        if (this.state === 'ABANDONED') {
            return;
        }
        
        // [新增] 防止重复登录错误
        if (this.client.steamID) {
             // 只有在确实需要重连时才 logOff，但 start() 本意就是发起新的连接
             // 所以这里为了安全，如果已连接则先断开
             try { 
                this.client.logOff(); 
             } catch (e) {}
        }

        this.state = 'LOGGING_IN';
        
        // [新增] 登录超时保护 - 90秒无响应则自动放弃或重试
        if (this.loginTimeout) {
            clearTimeout(this.loginTimeout);
        }
        this.loginTimeout = setTimeout(() => {
            if (this.state === 'LOGGING_IN') {
                this.loginTimeoutCount = (this.loginTimeoutCount || 0) + 1;
                
                if (this.loginTimeoutCount >= 2) {
                    // 超时 2 次，直接放弃
                    this.error(`⏱️ 登录超时 ${this.loginTimeoutCount} 次，放弃该账号`);
                    this.state = 'ABANDONED';
                    try { this.client.logOff(); } catch (e) {}
                } else {
                    // 第一次超时，切换代理重试
                    this.log(`⏱️ 登录超时 (${this.loginTimeoutCount}/2) - 切换代理重试`);
                    this.switchProxyAndRetry();
                }
            }
        }, 90000); // 90秒超时
        
        const logOnOptions = {
            accountName: this.account.username,
            password: this.account.password,
            promptSteamGuardCode: false,
            rememberPassword: true,
            logonID: Math.floor(Math.random() * 1000000),
            shouldRememberPassword: true
        };
        if (this.account.shared_secret && this.account.shared_secret.length > 5) {
            try { logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(this.account.shared_secret); } catch (err) {}
        }
        this.client.logOn(logOnOptions);
    }

    setupListeners() {
        // [关键] 移除特定的监听器，但保留错误处理器（在构造函数中已添加）
        this.client.removeAllListeners('loggedOn');
        this.client.removeAllListeners('appLaunched');
        this.client.removeAllListeners('receivedFromGC');
        
        this.client.on('loggedOn', () => {
            // [新增] 登录成功，清除超时定时器
            if (this.loginTimeout) {
                clearTimeout(this.loginTimeout);
                this.loginTimeout = null;
            }
            
            if (this.settings.debug_mode) {
                this.log('Steam 登录成功');
            }
            
            // [重要] 登录成功后重置错误计数器
            this.loggedInElsewhereCount = 0;
            this.retryCount = 0;
            this.loginTimeoutCount = 0; // [新增] 重置登录超时计数
            
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
    });

        this.client.on('appLaunched', (appid) => {
            if (appid === this.settings.target_app_id) {
                if (this.settings.debug_mode) {
                    this.log('🎮 Dota 2 启动');
                }
                // [修复] 延迟执行时检查账号是否已被放弃
                setTimeout(() => {
                    if (this.state !== 'ABANDONED') {
                        this.connectGC();
                    }
                }, 2000);
            }
        });

        // [注意] 错误处理器已在构造函数中添加（handleClientError），这里不再重复添加

        this.client.on('receivedFromGC', (appid, msgType, payload) => {
            // [修复] 收到 GC 消息时检查账号是否已被放弃
            if (this.state !== 'ABANDONED') {
                this.handleGCMessage(appid, msgType, payload);
            }
        });
    }

    connectGC() {
        // [修复] 检查账号是否已被放弃
        if (this.state === 'ABANDONED') return;
        
        if (this.settings.debug_mode) {
            this.log('开始连接 GC...');
        }
        this.sendHello();
        const helloInterval = setInterval(() => { 
            // [修复] 如果账号被放弃，停止心跳
            if (this.state === 'ABANDONED') {
                clearInterval(helloInterval);
                return;
            }
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

        // 清理残留状态
        this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
        setTimeout(() => {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        }, 500);
        
        // 根据角色行动
        setTimeout(() => {
            if (this.role === 'LEADER') {
                if (this.isSeeding) {
                    this.createLobbyAndSeed();
                } else {
                    this.createLobby();
                }
            } else {
                // [新逻辑] Follower 进入待命池，等待主号分配
                this.enterIdlePool();
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
    
    tryJoinOrPoll() {
        // 向 Manager 申请分配
        if (this.manager && this.role === 'FOLLOWER') {
            const decision = this.manager.requestJoinSlot(this.account.username);
            if (decision.action === 'JOIN') {
                this.joinLobbyDirectly(decision.lobbyId);
                return;
            }
        }
        this.requestLobbyList();
    }

    // [新增] Follower 进入待命池
    enterIdlePool() {
        if (this.role !== 'FOLLOWER') return;
        
        this.state = 'IDLE';
        if (this.settings.debug_mode) {
            this.log('进入待命池，等待主号分配房间');
        }
        // 不再主动轮询，被动等待 joinLobbyDirectly() 调用
    }

    requestLobbyList() {
        if (!this.is_gc_connected) return;

        try {
            const gameId = this.settings.custom_game_id;
            const gameIdLong = Long.fromString(gameId, true);
            const payload = { server_region: 0, custom_game_id: gameIdLong };
            const message = CMsgJoinableCustomLobbiesRequest.create(payload);
            const buffer = CMsgJoinableCustomLobbiesRequest.encode(message).finish();
            
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCJoinableCustomLobbiesRequest | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }
    createLobby() {
        try {
            const gameIdLong = Long.fromString(this.settings.custom_game_id, true);
            
            // 随机选择服务器区域
            const regions = this.settings.server_regions || [this.settings.server_region];
            const selectedRegion = regions[Math.floor(Math.random() * regions.length)];
            
            const detailsPayload = {
                customGameId: gameIdLong,        
                gameName: "", // 空白房间名
                serverRegion: selectedRegion, 
                gameMode: 15,                    
                customMaxPlayers: this.settings.max_players_per_room || 4,
                customMinPlayers: 1,
                allowSpectating: true,
                allchat: true,
                fillWithBots: false,
                allowCheats: false,
                visibility: 0, // Public (公开可见，需要密码才能加入)
                passKey: this.settings.lobby_password, // 房间密码
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
            
            const regionName = RegionNameMap[selectedRegion] || `Reg:${selectedRegion}`;
            this.log(`🌐 创建房间，区域: ${regionName} (${selectedRegion})`);
            
            // [修复死循环] Leader 创建一次后就停止，不再轮询
            this.state = 'CREATING_LOBBY';
        } catch (err) {
            this.error(`创建房间失败: ${err.message}`);
        }
    }

    // [新增] 主号从待命池中分配小号
    assignFollowersFromPool() {
        if (this.role !== 'LEADER') return;
        if (!this.currentLobbyId) return;
        
        // 获取每个房间的小号数量配置
        const maxPerRoom = this.settings.bots_per_room || this.settings.debug_max_bots_per_room || 22;
        
        // 从 manager 中获取所有处于 IDLE 状态的小号
        const idleBots = this.manager.bots.filter(bot => 
            bot.role === 'FOLLOWER' && bot.state === 'IDLE'
        );
        
        // 取前 maxPerRoom 个小号
        const botsToAssign = idleBots.slice(0, maxPerRoom);
        
        if (this.settings.debug_mode) {
            this.log(`从待命池分配 ${botsToAssign.length}/${idleBots.length} 个小号到房间 (LobbyID: ${this.currentLobbyId.toString()})`);
        }
        
        // 逐个通知小号加入
        botsToAssign.forEach((bot, idx) => {
            setTimeout(() => {
                bot.joinLobbyDirectly(this.currentLobbyId);
            }, idx * 50); // 每个小号间隔50ms加入，避免瞬时峰值
        });
    }

        // [播种模式] 创建房间并等待小号加入
    createLobbyAndSeed() {
        this.roomsCreated++;
        this.currentRoomNumber = this.roomsCreated;
        const roomName = ""; // 空白房间名
        
        // [新增] 重置分配标志，允许新房间分配小号
        this.hasAssignedFollowers = false;
        
        try {
            const gameIdLong = Long.fromString(this.settings.custom_game_id, true);
            
            // 随机选择服务器区域
            const regions = this.settings.server_regions || [this.settings.server_region];
            const selectedRegion = regions[Math.floor(Math.random() * regions.length)];
            
            const detailsPayload = {
                customGameId: gameIdLong,        
                gameName: roomName,
                serverRegion: selectedRegion, 
                gameMode: 15,                    
                customMaxPlayers: this.settings.max_players_per_room || 4,
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
            
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
            
            const regionName = RegionNameMap[selectedRegion] || `Reg:${selectedRegion}`;
            this.log(`🌐 创建房间 #${this.currentRoomNumber}，区域: ${regionName}`);
            
            this.state = 'SEEDING';
            this.currentRoomMemberCount = 1;
            
            // 发送心跳激活房间
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
            if (this.creationTimeout) clearTimeout(this.creationTimeout);
            this.creationTimeout = setTimeout(() => {
                if (this.state === 'SEEDING') {
                    this.currentLobbyId = null;
                    this.currentRoomMemberCount = 1;
                    this.roomsCreated--;
                    this.createLobbyAndSeed();
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

    // 断开重连并创建新房间
    reconnectAndSeed() {
        if (this.state === 'LEAVING_LOBBY' || this.state === 'RECONNECTING') return;
        
        this.state = 'LEAVING_LOBBY';
        
        // 清理定时器
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        if (this.poll_interval) {
            clearInterval(this.poll_interval);
            this.poll_interval = null; 
        }
        if (this.creationTimeout) {
            clearTimeout(this.creationTimeout);
            this.creationTimeout = null;
        }
        
        if (this.manager) {
            this.manager.clearConfirmedLobby();
        }
                    
        // 发送离开请求
        if (this.is_gc_connected) {
            try {
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
            } catch (e) {}
        }
        
        // 15秒超时保底
        setTimeout(() => {
            if (this.state === 'LEAVING_LOBBY') {
                this.performReconnect();
            }
        }, 15000);
    }

    performReconnect() {
        this.state = 'RECONNECTING';
        this.is_gc_connected = false;
        this.currentLobbyId = null;
        this.currentRoomMemberCount = 1; 
        this.missingRoomCount = 0; 
        this.client.logOff();
        setTimeout(() => this.start(), 5000);
    }

    joinLobbyDirectly(lobbyIdInput) {
        if (this.state === 'IN_LOBBY') return;
        
        try {
            let lobbyId = lobbyIdInput;
            if (typeof lobbyId === 'string') lobbyId = Long.fromString(lobbyId, true);
            else if (typeof lobbyId === 'number') lobbyId = Long.fromNumber(lobbyId, true);

            const payload = {
                lobbyId: lobbyId,
                customGameCrc: Long.fromString(this.knownCrc, true),
                customGameTimestamp: this.knownTimestamp,
                passKey: this.settings.lobby_password
            };
            const message = CMsgPracticeLobbyJoin.create(payload);
            const buffer = CMsgPracticeLobbyJoin.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyJoin | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    handleGCMessage(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        // [精简] 移除了大量 GC 消息日志，只保留核心处理

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
             if (!this.is_gc_connected) {
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

                // 共享状态上报：Follower 看到的房间信息上报给 Manager
                if (this.role === 'FOLLOWER' && this.manager) {
                    myLobbies.forEach(l => {
                        if (l.lobbyName && l.lobbyName.includes(this.fleetId)) {
                            this.manager.updateRoomState(l.lobbyName, l.lobbyId, l.memberCount);
                        }
                    });
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
                                // 房间解散，重新轮询
                                this.state = 'ONLINE';
                                this.currentLobbyId = null;
                                this.myRoomMissingCount = 0;
                                
                                if (this.ready_up_heartbeat) {
                                    clearInterval(this.ready_up_heartbeat);
                                    this.ready_up_heartbeat = null;
                                }
                                
                                try {
                                    this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                                } catch(e) {}
                                return;
                            }
                        }
                    }
                    
                }
            } catch (e) {}
        }
        // 监听 Lobby Snapshot (7004)
        else if (cleanMsgType === 7004) { 
             try {
                 const lobby = CSODOTALobby.decode(payload);
                 if (lobby.lobbyId) {
                    this.currentLobbyId = lobby.lobbyId;
                    
                    // 播种模式：Leader 检测成员变化
                    if (this.role === 'LEADER' && this.isSeeding) {
                        const newMemberCount = (lobby.members && lobby.members.length) || 0;
                        
                        // 发送心跳激活房间
                        if (newMemberCount === 1 && this.state === 'SEEDING') {
                             this.sendReadyUp(lobby.lobbyId);
                        }
                        this.missingRoomCount = 0;
                        if (newMemberCount > this.currentRoomMemberCount) {
                            this.currentRoomMemberCount = newMemberCount;
                            this.reconnectAndSeed();
                        }
                        return;
                    }
                    this.onEnterLobby(true);
                 }
            } catch(e) {}
        }
        // 监听 7055 - 房间创建响应 (静默处理，不打印日志)
        else if (cleanMsgType === k_EMsgGCPracticeLobbyResponse) {
            // 7055 响应通常由 SOCache 消息确认，这里不做额外处理
        }
        // ============================================
        // 监听 SOCache 消息 (24/25/26) 获取 Lobby 信息
        // [精简] 移除了大量开发调试日志，只保留核心处理逻辑
        // ============================================
        else if (cleanMsgType === k_EMsgGCSOCacheSubscribed) {
            try {
                const msg = CMsgSOCacheSubscribed.decode(payload);
                (msg.objects || []).forEach((typeObj) => {
                    if (typeObj.typeId === SOCACHE_TYPE_LOBBY) {
                        (typeObj.objectData || []).forEach((data) => {
                            this.processLobbyData(data, 'SOCache-24');
                        });
                    }
                });
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOSingleObject) {
            let typeId = 0;
            try {
                const msg = CMsgSOSingleObject.decode(payload);
                typeId = msg.typeId;
                if (typeId === SOCACHE_TYPE_LOBBY) {
                    this.processLobbyData(msg.objectData, 'SOCache-25');
                }
            } catch (e) {
                // 短消息尝试直接读取 typeId
                if (payload.length < 20) {
                    try {
                        let shift = 0;
                        for (let i = 0; i < 5 && i < payload.length; i++) {
                            const b = payload[i];
                            typeId |= (b & 0x7F) << shift;
                            if ((b & 0x80) === 0) break;
                            shift += 7;
                        }
                    } catch (err) {}
                }
            }
            // 处理 Type 18 作为离开确认
            if (typeId === 18 && this.role === 'LEADER' && this.state === 'LEAVING_LOBBY') {
                this.log('✅ 离开确认成功');
                this.performReconnect();
            }
        }
        else if (cleanMsgType === k_EMsgGCSOMultipleObjects) {
            try {
                const msg = CMsgSOMultipleObjects.decode(payload);
                const modified = msg.objectsModified || [];
                const added = msg.objectsAdded || [];
                
                [...modified, ...added].forEach((obj) => {
                    if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                        this.processLobbyData(obj.objectData, 'SOCache-26');
                    }
                });
            } catch (e) {}
        }
         // 监听加入结果 (7113)
        else if (cleanMsgType === k_EMsgGCPracticeLobbyJoinResponse) {
             try {
                const response = CMsgPracticeLobbyJoinResponse.decode(payload);
                const resultCode = response.result || 0;
                const resultName = JoinResultName[resultCode] || `UNKNOWN_${resultCode}`;
                
                if (resultCode === DOTAJoinLobbyResult.DOTA_JOIN_RESULT_SUCCESS) {
                    this.onEnterLobby();
                } else {
                    // 只打印关键的加入失败信息
                    this.log(`❌ 加入失败: ${resultName}`);
                    if (this.role === 'LEADER') {
                         setTimeout(() => this.createLobby(), 5000);
                    }
                }
             } catch(e) {}
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
                     if (!this.currentLobbyId && status.lobbyId) {
                         this.currentLobbyId = status.lobbyId;
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
        if (!objectData || objectData.length === 0) return;
        
        try {
            const lobby = CSODOTALobby.decode(objectData);
            
            // 获取关键信息
            const lobbyId = lobby.lobbyId;
            const gameName = lobby.gameName || '';
            const leaderId = lobby.leaderId;
            const state = lobby.state;
            const allMembers = lobby.allMembers || [];
            const memberCount = allMembers.length;
            const customGameId = lobby.customGameId;
            
            // 如果有 lobbyId，更新当前状态
            if (lobbyId) {
                this.currentLobbyId = lobbyId;
                
                // Leader 在播种模式下，确认房间创建成功
                if (this.role === 'LEADER' && this.isSeeding && this.state === 'SEEDING') {
                    // 空白房间名，只通过 lobbyId 存在来确认房间创建成功
                    if (lobbyId) {
                        if (this.creationTimeout) {
                            clearTimeout(this.creationTimeout);
                            this.creationTimeout = null;
                        }
                        
                        // [重要日志] 房间创建成功
                        this.log(`✅ 房间 "${gameName}" 创建成功 (人数: ${memberCount})`);
                        
                        this.currentRoomMemberCount = memberCount;
                        this.missingRoomCount = 0;
                        
                        if (this.manager) {
                            this.manager.setConfirmedLobby(lobbyId, gameName, this.currentRoomNumber, memberCount);
                        }
                        
                        // [新增] 如果是首次确认房间（人数为1，即只有主号），立即从池子分配小号
                        if (memberCount === 1 && !this.hasAssignedFollowers) {
                            this.hasAssignedFollowers = true;
                            this.assignFollowersFromPool();
                        }
                        
                        if (memberCount > 1) {
                            if (this.manager) {
                                this.manager.clearConfirmedLobby();
                            }
                            this.reconnectAndSeed();
                        }
                    }
                }
                
                // Follower 确认加入成功
                if (this.role === 'FOLLOWER' && this.state !== 'IN_LOBBY') {
                    if (gameName.includes(this.fleetId)) {
                        this.onEnterLobby(true);
                    }
                }
            }
            
        } catch (e) {
            // 解析失败时不打印，避免日志噪音
        }
    }

    onEnterLobby(isSnapshot = false) {
        // Leader 在播种模式下保持 SEEDING 状态
        if (this.role === 'LEADER' && this.isSeeding) {
            // 保持 SEEDING 状态
        } else {
            if (this.state === 'IN_LOBBY') return;
            this.state = 'IN_LOBBY';
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
        
        // [优化] 强制发送退出命令（不管 GC 是否连接）
        try {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        } catch (err) {
            // 忽略错误（GC 未连接时会报错，但不影响）
        }
        
        try {
            this.client.logOff();
        } catch (err) {
            // 忽略登出错误
        }
        
        return true; // 返回清理成功标记
    }
}

// --- Main ---
// [新增] 解析命令行参数
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

let fleets = config.fleets || [];
const globalSettings = config.global_settings;

// [新增] 强制覆盖 debug_mode 配置，使用命令行参数
globalSettings.debug_mode = isDebugMode;

// [新增] 确保共享验证数据目录存在
const sharedDataPath = globalSettings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
    if (isDebugMode) {
        console.log(`[System] 📁 创建共享验证数据目录: ${steamDataDir}`);
    }
} else {
    if (isDebugMode) {
        console.log(`[System] 📁 使用共享验证数据目录: ${steamDataDir}`);
    }
}

// [新增] 自动分配车队逻辑
// 检查是否使用新格式（leader 和 followers 是数组）
if (fleets.length > 0 && Array.isArray(fleets[0].leader)) {
    const sourceFleet = fleets[0];
    const leaders = sourceFleet.leader || [];
    const followers = sourceFleet.followers || [];
    
    if (leaders.length === 0) {
        console.error("❌ 未找到任何主号配置 (fleets[0].leader)");
        process.exit(1);
    }
    
    // 计算每个车队分配的小号数量
    const followersPerFleet = Math.floor(followers.length / leaders.length);
    const remainingFollowers = followers.length % leaders.length;
    
    if (isDebugMode) {
        console.log(`[System] 🔄 自动分配车队:`);
        console.log(`[System]    主号数量: ${leaders.length}`);
        console.log(`[System]    小号数量: ${followers.length}`);
        console.log(`[System]    每个车队: ${followersPerFleet} 个小号`);
        if (remainingFollowers > 0) {
            console.log(`[System]    前 ${remainingFollowers} 个车队额外分配 1 个小号`);
        }
    }
    
    // 重新构建 fleets 数组
    fleets = [];
    let followerIndex = 0;
    
    leaders.forEach((leaderAccount, idx) => {
        // 计算当前车队的小号数量（前几个车队可能多分配1个）
        const currentFollowerCount = followersPerFleet + (idx < remainingFollowers ? 1 : 0);
        const currentFollowers = followers.slice(followerIndex, followerIndex + currentFollowerCount);
        followerIndex += currentFollowerCount;
        
        fleets.push({
            id: `fleet_${idx + 1}`,
            leader: leaderAccount,  // 单个对象
            followers: currentFollowers
        });
    });
    
    if (isDebugMode) {
        console.log(`[System] ✅ 已创建 ${fleets.length} 个车队\n`);
    }
}

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

// [新增] 计算全局账号偏移量（只计算 Followers，不包括 Leaders）
let globalFollowerOffset = 0;

fleets.forEach((fleetConfig, leaderIndex) => {
    const fleet = new FleetManager(fleetConfig, globalSettings, globalFollowerOffset);
    fleetManagers.push(fleet);
    fleet.start(leaderIndex); // 传入 leaderIndex 用于固定代理分配
    
    // 更新全局偏移量：只累加当前车队的 Followers
    globalFollowerOffset += (fleetConfig.followers?.length || 0);
});

// [新增] 全局进度监控器（合并所有车队）
let globalProgressInterval = null;
const totalBots = fleets.reduce((sum, f) => sum + 1 + (f.followers?.length || 0), 0);

// 延迟 10 秒后启动全局进度监控
setTimeout(() => {
    globalProgressInterval = setInterval(() => {
        let totalBotsInLobby = 0;
        let totalLoggingIn = 0;
        let totalOffline = 0;
        let totalConnectingGC = 0;
        const globalRoomSet = new Set();
        
        // 统计所有车队的 Bot
        fleetManagers.forEach(fleet => {
            fleet.bots.forEach(bot => {
                // 统计各状态的 Bot 数量
                if (bot.state === 'IN_LOBBY' || bot.state === 'SEEDING') {
                    totalBotsInLobby++;
                    if (bot.currentLobbyId) {
                        globalRoomSet.add(bot.currentLobbyId.toString());
                    }
                } else if (bot.state === 'LOGGING_IN') {
                    totalLoggingIn++;
                } else if (bot.state === 'OFFLINE') {
                    totalOffline++;
                } else if (bot.state === 'CONNECTED_TO_GC' || bot.state === 'CREATING_LOBBY') {
                    totalConnectingGC++;
                }
            });
        });
        
        const totalRooms = globalRoomSet.size;
        const percentage = Math.floor((totalBotsInLobby / totalBots) * 100);
        
        if (!isDebugMode) {
            // 生产模式：进度条
            const barLength = 40;
            const filledLength = Math.floor((percentage / 100) * barLength);
            const emptyLength = barLength - filledLength;
            const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
            const info = `房间: ${totalRooms} | Bot: ${totalBotsInLobby}/${totalBots}`;
            
            // 使用 \r 覆盖当前行
            process.stdout.write(`\r[${bar}] ${percentage}% | ${info}`);
            
            // 如果达到100%，换行并停止
            if (percentage === 100 && totalBotsInLobby === totalBots) {
                process.stdout.write('\n');
                clearInterval(globalProgressInterval);
                globalProgressInterval = null;
            }
        } else {
            // Debug 模式：详细统计（每 10 秒输出一次）
            if (Date.now() % 10000 < 1000) { // 近似每 10 秒
                console.log('\n' + '='.repeat(70));
                console.log(`📊 [状态统计] ${new Date().toLocaleTimeString()}`);
                console.log('='.repeat(70));
                console.log(`✅ 已进房间: ${totalBotsInLobby}/${totalBots} (${percentage}%)`);
                console.log(`🏠 创建房间: ${totalRooms} 个`);
                console.log(`🔄 正在登录: ${totalLoggingIn} 个`);
                console.log(`🌐 连接 GC: ${totalConnectingGC} 个`);
                console.log(`⏸️  离线/待重试: ${totalOffline} 个`);
                console.log('='.repeat(70) + '\n');
            }
            
            // 达到100%后停止
            if (percentage === 100 && totalBotsInLobby === totalBots) {
                console.log('\n🎉 所有 Bot 已成功进入房间！\n');
                clearInterval(globalProgressInterval);
                globalProgressInterval = null;
            }
        }
    }, 1000);
}, 10000);

// [新增] 全局未捕获异常处理器 - 防止程序因为网络错误崩溃
process.on('uncaughtException', (err) => {
    // 忽略退出时的网络错误
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EPIPE' || err.code === 'ECONNREFUSED') {
        // 这些是网络断开时的正常错误，静默忽略
        return;
    }
    // 其他未知错误打印出来
    console.error('\n[System] ⚠️ 未捕获的异常:', err.message);
});

// [新增] 未处理的 Promise 拒绝
process.on('unhandledRejection', (reason, promise) => {
    // 忽略网络相关的 Promise 拒绝
    if (reason && reason.code && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(reason.code)) {
        return;
    }
    console.error('\n[System] ⚠️ 未处理的 Promise 拒绝:', reason);
});

process.on('SIGINT', () => {
    // 停止全局进度监控
    if (globalProgressInterval) {
        clearInterval(globalProgressInterval);
        globalProgressInterval = null;
    }
    
    if (!isDebugMode) {
        process.stdout.write('\n'); // 清除进度条
    }
    console.log("\n" + "=".repeat(60));
    console.log("[System] 🛑 收到退出信号 (Ctrl+C)");
    console.log("=".repeat(60));
    
    let totalCleaned = 0;
    fleetManagers.forEach(f => {
        const cleaned = f.cleanup();
        totalCleaned += cleaned;
    });
    
    console.log("\n" + "=".repeat(60));
    console.log(`[System] 📊 清理统计`);
    console.log("=".repeat(60));
    console.log(`✅ 已发送退出命令: ${totalCleaned} 个账号`);
    console.log(`⏱️  等待 5 秒以确保命令发送完成...`);
    console.log("=".repeat(60));
    
    setTimeout(() => {
        console.log(`\n[System] ✅ 程序已安全退出`);
        console.log(`💡 提示: 如需确保所有账号完全退出，请运行: node clear_all.js\n`);
        process.exit(0);
    }, 5000); // 增加到 5 秒，确保命令发送
});

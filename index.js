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

// --- Fleet Manager ---
class FleetManager {
    constructor(fleetConfig, globalSettings) {
        this.id = fleetConfig.id || 'unknown_fleet';
        this.config = fleetConfig;
        this.settings = globalSettings;
        this.bots = [];
        // [新增] 共享房间状态表 (Key: RoomName, Value: { count: number, time: number })
        this.roomStates = new Map();
    }

    updateRoomState(roomName, count) {
        this.roomStates.set(roomName, {
            count: count,
            time: Date.now()
        });
    }

    getRoomState(roomName) {
        return this.roomStates.get(roomName);
    }

    start() {
        console.log(`\n[Fleet:${this.id}] 🚀 车队启动! Leader: ${this.config.leader.username}`);

        // 1. 启动 Leader (传入 fleetId 和 manager)
        const leaderBot = new BotClient(this.config.leader, this.settings, 'LEADER', this.id, this);
        this.bots.push(leaderBot);
        leaderBot.start();

        // 2. 启动 Followers (错峰，传入 fleetId 和 manager)
        this.config.followers.forEach((acc, idx) => {
            setTimeout(() => {
                console.log(`[Fleet:${this.id}] 启动 Follower ${idx+1}: ${acc.username}`);
                const bot = new BotClient(acc, this.settings, 'FOLLOWER', this.id, this);
                this.bots.push(bot);
                bot.start();
            }, 5000 + (idx * 3000)); // Leader 先跑5秒，然后每个Follower间隔3秒
        });
    }

    cleanup() {
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
        console.log(`[${this.account.username}|${this.role}] ${msg}`);
            }

    error(msg) {
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
            this.log('Steam 登录成功');
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
    });

        this.client.on('appLaunched', (appid) => {
            if (appid === this.settings.target_app_id) {
                this.log('🎮 Dota 2 启动');
                setTimeout(() => this.connectGC(), 2000);
        }
    });

        this.client.on('receivedFromGC', (appid, msgType, payload) => this.handleGCMessage(appid, msgType, payload));
    }

    connectGC() {
        this.log('开始连接 GC...');
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
                    this.log('🌱 播种模式启动：将持续创建房间...');
                    this.createLobbyAndSeed(); // 播种模式：创建并离开
                } else {
                    this.log('👑 车头模式：创建房间（仅一次）...');
                    this.createLobby(); // 普通模式：创建一次
                }
            } else {
                this.log('💤 乘客模式：启动轮询，寻找车头房间...');
                this.startPolling(); // 启动轮询机制
            }
        }, 1500);
    }

    // [新增] Follower 轮询机制
    startPolling() {
        if (this.role !== 'FOLLOWER') return;
        
        // 立即执行一次
        this.requestLobbyList();
        
        // 每 10 秒轮询一次
        this.poll_interval = setInterval(() => {
            if (this.state !== 'IN_LOBBY') {
                this.requestLobbyList();
            } else {
                // 已经进房了，停止轮询
                clearInterval(this.poll_interval);
                this.poll_interval = null;
            }
        }, 10000);
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
            
            // [优化] 仅在非播种轮询或调试模式下打印请求日志，减少刷屏
            const shouldLog = this.settings.debug_mode || !this.isSeeding || this.role !== 'LEADER';
            
            if (shouldLog) {
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
            // [DEBUG] 打印关键状态
            this.log(`🔧 [创建前状态] roomsCreated=${this.roomsCreated}, currentRoomNumber=${this.currentRoomNumber}, oldLobbyID=${this.currentLobbyId}, oldMemberCount=${this.currentRoomMemberCount}`);

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
            this.log(`🌱 [播种 ${this.roomsCreated}] 创建房间: ${roomName} - 等待小号加入...`);
            
            this.state = 'SEEDING';
            this.currentRoomMemberCount = 1; // 重置人数计数（只有自己）
            
            // [关键修复] 立即发送 ReadyUp，激活房间，防止 GC 认为房间无效而删除
            // 连续发送 5 次，每秒一次，确保房间稳定
            let heartbeats = 0;
            const activationInterval = setInterval(() => {
                if (this.state === 'SEEDING') {
                    this.log(`🔥 [激活房间 ${heartbeats+1}/5] 发送 ReadyUp 心跳...`);
                    this.sendReadyUp();
                    heartbeats++;
                    if (heartbeats >= 5) clearInterval(activationInterval);
                    } else {
                    clearInterval(activationInterval);
                }
            }, 1000);
            
            // [盲轮询] 延迟 2 秒后启动轮询，给 GC 更多时间同步
            setTimeout(() => {
                if (this.state === 'SEEDING' && !this.poll_interval) {
                    this.log('🕶️ 启动盲轮询机制：主动检查房间列表...');
                    this.startLeaderPolling();
                }
            }, 2000);

        } catch (err) {
            this.error(`播种失败: ${err.message}`);
            }
        }

    // [新增] Leader 轮询检测
    startLeaderPolling() {
        if (this.poll_interval) clearInterval(this.poll_interval);
        
        this.log('🔍 启动 Leader 轮询检测 (每 1 秒)');
        this.poll_interval = setInterval(() => {
            if (this.state !== 'SEEDING') {
                clearInterval(this.poll_interval);
                this.poll_interval = null;
                return;
            }
            this.requestLobbyList(); // 主动查询列表
        }, 1000); // 缩短到 1 秒，加快响应 Follower 上报
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
        this.log('🔄 断开连接，准备重新登录...');
        
        // 清理所有定时器
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        if (this.poll_interval) {
            clearInterval(this.poll_interval);
            this.poll_interval = null; // [关键修复] 必须重置为 null，否则下次创建房间时无法启动轮询
                    }
                    
        // [关键修复] 先显式离开房间，确保 GC 清理旧房间的"房主"状态
        // 防止一个账号同时持有多个房间导致冲突
        if (this.is_gc_connected && this.currentLobbyId) {
            this.log('👋 显式发送 AbandonCurrentGame & LeaveLobby，确保彻底退出旧房间...');
            try {
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
            } catch (e) {}
        }
        
        // 标记为重连状态
        this.state = 'RECONNECTING';
        this.is_gc_connected = false;
        
        // [关键修复] 清空所有旧房间状态
        this.log(`🗑️ 清空旧状态: LobbyID=${this.currentLobbyId}, MemberCount=${this.currentRoomMemberCount}, MissingCount=${this.missingRoomCount}`);
        this.currentLobbyId = null;
        this.currentRoomMemberCount = 1; // 重置为初始值
        this.missingRoomCount = 0; // 重置未找到房间计数
        
        // 断开 Steam 连接
        this.client.logOff();
                            
        // 增加延时到 5 秒，给 GC 足够时间清理旧房间状态
                            setTimeout(() => {
            this.log('🔌 重新登录...');
            this.start();
        }, 5000);
            }

    joinLobbyDirectly(lobbyIdInput) {
        if (this.state === 'IN_LOBBY') return;
        
        try {
            let lobbyId = lobbyIdInput;
            if (typeof lobbyId === 'string') lobbyId = Long.fromString(lobbyId, true);
            else if (typeof lobbyId === 'number') lobbyId = Long.fromNumber(lobbyId, true);

            this.log(`🚀 发起定向加入 -> ${lobbyId.toString()}`);

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

        // [临时调试] 打印 Leader 收到的所有 GC 消息（排除高频消息）
        if (this.role === 'LEADER' && ![7469, 7388, 7036].includes(cleanMsgType)) {
            this.log(`🔔 [DEBUG] 收到消息 ${cleanMsgType}, state=${this.state}, isSeeding=${this.isSeeding}`);
        }

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
             if (!this.is_gc_connected) {
                 this.log('✅ GC 连接确认');
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
                            this.manager.updateRoomState(l.lobbyName, l.memberCount);
                            // [调试] 打印上报信息
                            if (this.settings.debug_mode) {
                                this.log(`🔔 [上报] 房间 "${l.lobbyName}" 人数: ${l.memberCount}`);
                            }
                        }
                    });
                    }
                    
                // [调试打印] 打印所有扫描到的房间详情，方便排查
                if (this.settings.debug_mode) {
                    this.log(`📊 [DEBUG] 扫描到 ${myLobbies.length} 个相关房间:`);
                    myLobbies.forEach((l, idx) => {
                        this.log(`   [${idx+1}] ID:${l.lobbyId} | Name:"${l.lobbyName}" | Leader:${l.leaderAccountId} | Mem:${l.memberCount}/${l.maxPlayerCount}`);
                    });
                    if (this.role === 'LEADER') {
                        this.log(`   🎯 Leader当前目标: ID=${this.currentLobbyId ? this.currentLobbyId.toString() : 'null'} | Name="Bot Room ${this.fleetId} #${this.currentRoomNumber}"`);
                    }
                } else {
                    this.log(`📊 扫描到 ${myLobbies.length} 个相关房间`);
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
                    
                    // [原有逻辑] 如果不在房间，寻找可用房间
                    if (this.state !== 'IN_LOBBY') {
                        // [调试模式] 设置每个房间最大Bot数量（给玩家预留观察位）
                        const debugMode = this.settings.debug_mode || false;
                        const maxBotsPerRoom = debugMode ? (this.settings.debug_max_bots_per_room || 3) : this.settings.max_players_per_room;
                        
                        // [Follower 逻辑] 寻找包含车队 ID 的房间名，且人数未达到Bot上限的
                        const availableRooms = myLobbies.filter(l => {
                            if (!l.lobbyName || !l.lobbyName.includes(this.fleetId)) return false;
                            
                            // 在调试模式下，只要房间人数 < maxBotsPerRoom 就可加入
                            // 在生产模式下，只要房间人数 < maxPlayerCount 就可加入
                            const currentCount = l.memberCount || 0;
                            return currentCount < maxBotsPerRoom;
                        });

                        if (availableRooms.length > 0) {
                            // ⚠️ 按序号从小到大排序，优先加入编号最小的未满房间
                            availableRooms.sort((a, b) => {
                                const aNum = parseInt(a.lobbyName.match(/#(\d+)/)?.[1] || '0');
                                const bNum = parseInt(b.lobbyName.match(/#(\d+)/)?.[1] || '0');
                                return aNum - bNum; // 升序（从小到大）
                            });
                            
                            const targetRoom = availableRooms[0];
                            const debugInfo = debugMode ? ` [调试模式: 最多${maxBotsPerRoom}个Bot]` : '';
                            this.log(`✅ 找到可用房间: ${targetRoom.lobbyName} (${targetRoom.memberCount}/${targetRoom.maxPlayerCount})${debugInfo}`);
                            
                            // 更新版本信息
                            this.knownCrc = targetRoom.customGameCrc.toString();
                            this.knownTimestamp = targetRoom.customGameTimestamp;
                            
                            // 加入房间
                            this.joinLobbyDirectly(targetRoom.lobbyId);
                        } else {
                            const debugInfo = debugMode ? ` (调试模式: Bot上限=${maxBotsPerRoom})` : '';
                            this.log(`⏳ 未找到可用房间，继续等待...${debugInfo}`);
                        }
                    }
                }
                // [Leader 逻辑] 
                else if (this.role === 'LEADER') {
                    // --- [新增] 车队全局状态统计 (仅在变化时打印) ---
                    const fleetRooms = myLobbies.filter(l => l.lobbyName && l.lobbyName.includes(this.fleetId));
                    // 按房间号排序
                    fleetRooms.sort((a, b) => {
                        const aNum = parseInt(a.lobbyName.match(/#(\d+)/)?.[1] || '0');
                        const bNum = parseInt(b.lobbyName.match(/#(\d+)/)?.[1] || '0');
                        return aNum - bNum;
                    });

                    // 生成快照字符串用于比对
                    const currentSnapshot = fleetRooms.map(r => `${r.lobbyName}=${r.memberCount}`).join('|');
                
                    if (currentSnapshot !== this.lastFleetSnapshot && fleetRooms.length > 0) {
                        this.log(`\n📊 === [车队兵力分布] ===`);
                        fleetRooms.forEach(r => {
                             const isFull = r.memberCount >= (this.settings.max_players_per_room || 4);
                             const status = isFull ? "✅ 满员" : "⏳ 等待";
                             this.log(`   🏠 ${r.lobbyName}: ${r.memberCount}/${r.maxPlayerCount} 人 [${status}]`);
                        });
                        this.log(`========================\n`);
                        this.lastFleetSnapshot = currentSnapshot;
                    }
                    // ---------------------------------------------

                    // 1. 创建初期确认
                    if (this.state === 'CREATING_LOBBY') {
                        const mySteamId = this.client.steamID ? this.client.steamID.accountid : null;
                        if (!mySteamId) {
                            this.log('⚠️ 无法获取 SteamID，跳过检测');
                            return;
                        }
                        const selfHostedLobby = myLobbies.find(l => l.leaderAccountId === mySteamId);
                        
                        if (selfHostedLobby) {
                            this.log(`✅ 房间创建成功! ID=${selfHostedLobby.lobbyId}`);
                            this.currentLobbyId = selfHostedLobby.lobbyId;
                            
                            if (this.isSeeding) {
                                this.state = 'SEEDING'; // 进入播种检测状态
                                this.startLeaderPolling(); // 启动主动轮询
                            } else {
                                this.onEnterLobby(true);
                            }
                        }
                    }
                    // 2. 播种模式下检测人数变化
                    else if (this.state === 'SEEDING') {
                        // [千里眼] 优先从 Manager 获取真实人数（由 Follower 上报）
                        // 解决 Leader 处于房间内导致视角滞后，无法看到真实人数的问题
                        if (this.manager) {
                            const targetRoomName = `Bot Room ${this.fleetId} #${this.currentRoomNumber}`;
                            const reportedState = this.manager.getRoomState(targetRoomName);
                            
                            // [调试] 每次都打印检查结果
                            if (this.settings.debug_mode) {
                                this.log(`👁️ [千里眼检查] 房间 "${targetRoomName}" | 上报人数: ${reportedState ? reportedState.count : '未上报'} | Leader记录: ${this.currentRoomMemberCount}`);
            }
                            
                            // 如果 Follower 上报的人数 > Leader 记录的人数
                            if (reportedState && reportedState.count > this.currentRoomMemberCount) {
                                this.log(`👀 [千里眼] 收到 Follower 上报: 房间 ${targetRoomName} 人数已达 ${reportedState.count} (Leader视角: ${this.currentRoomMemberCount})`);
                                
                                // 触发重连逻辑
                                this.log(`👥 检测到小号加入 (${this.currentRoomMemberCount} -> ${reportedState.count})，重新登录并创建新房间...`);
                                this.currentRoomMemberCount = reportedState.count;
                                
                                if (this.poll_interval) {
                                    clearInterval(this.poll_interval);
                                    this.poll_interval = null;
                                }
                                this.reconnectAndSeed();
                                return; // 退出函数，避免重复处理
                            }
                        }

                        // 优先通过 lobbyId 查找（最稳）
                        let myRoom = null;
                        if (this.currentLobbyId) {
                            // 注意：protobuf Long 类型比较需要用 equals 或 toString
                            const targetIdStr = this.currentLobbyId.toString();
                            myRoom = myLobbies.find(l => l.lobbyId && l.lobbyId.toString() === targetIdStr);
                        }
                        
                        // 如果 lobbyId 没找到，再尝试通过名字兜底
                        if (!myRoom) {
                            const targetRoomName = `Bot Room ${this.fleetId} #${this.currentRoomNumber}`;
                            myRoom = myLobbies.find(l => l.lobbyName === targetRoomName);
                        }

                        if (myRoom) {
                            const currentCount = myRoom.memberCount || 0;
                            // [优化] 仅在人数有变化或首次检测时打印，避免刷屏
                            if (currentCount > this.currentRoomMemberCount) {
                                this.log(`📊 [播种检测] 房间 #${this.currentRoomNumber} (ID:${myRoom.lobbyId}) 人数: ${currentCount} (预期 > ${this.currentRoomMemberCount})`);
                            }
                            
                            // 重置"找不到房间"计数器（说明房间还在）
                            this.missingRoomCount = 0;
                            
                            if (currentCount > this.currentRoomMemberCount) {
                                this.log(`👥 检测到小号加入 (${this.currentRoomMemberCount} -> ${currentCount})，重新登录并创建新房间...`);
                                this.currentRoomMemberCount = currentCount;
                                
                                // 停止轮询
                                if (this.poll_interval) {
                                    clearInterval(this.poll_interval);
                                    this.poll_interval = null;
                                }
                                
                                // 断开并重新登录
                                this.reconnectAndSeed();
                 }
                        } else {
                            // 如果找不到房间，有两种情况：
                            // 1. 刚创建还没同步到列表（等待下一次轮询）
                            // 2. 房间已解散（罕见，触发重连）
                            // 为了稳妥，如果连续 10 次都找不到，就认为需要重连 (约 30 秒)
                            if (!this.missingRoomCount) this.missingRoomCount = 0;
                            this.missingRoomCount++;
                            
                            if (this.missingRoomCount >= 10) {
                                this.log(`⚠️ 连续 10 次未找到房间 #${this.currentRoomNumber}，判定为已解散，创建下一个房间...`);
                                this.missingRoomCount = 0;
                                this.reconnectAndSeed();
                            } else {
                                this.log(`⚠️ 列表中未找到房间 #${this.currentRoomNumber} (${this.missingRoomCount}/10)`);
        }
                        }
                    }
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
                    this.log(`🆔 [ID更新] 从 ${oldLobbyId ? oldLobbyId.toString() : 'null'} -> ${lobby.lobbyId.toString()}`);
                    
                    // [播种模式] Leader 混合检测模式：优先使用 Snapshot，轮询作为兜底
                    if (this.role === 'LEADER' && this.isSeeding) {
                        const newMemberCount = (lobby.members && lobby.members.length) || 0;
                        this.log(`📩 收到 Lobby Snapshot, 人数=${newMemberCount}`);
                        
                        // [修正] 无论当前人数多少，只要收到 Snapshot 确认房间已创建，就启动轮询
                        if (!this.poll_interval && this.state === 'SEEDING') {
                             this.log(`🔍 启动 Leader 轮询检测 (每 1 秒) - 当前人数: ${newMemberCount}`);
                             this.startLeaderPolling();
                        }

                        // [补丁] 强制发送 ReadyUp 以激活房间状态
                        if (newMemberCount === 1 && this.state === 'SEEDING') {
                             this.log('💓 发送强制心跳以激活新房间...');
                             this.sendReadyUp(lobby.lobbyId);
                        }

                        // 重置轮询的"找不到房间"计数器，因为我们确信房间存在且我们在里面
                        this.missingRoomCount = 0;

                        if (newMemberCount > this.currentRoomMemberCount) {
                            this.log(`👥 [快照检测] 检测到小号加入 (${this.currentRoomMemberCount} -> ${newMemberCount})，触发重连...`);
                            this.currentRoomMemberCount = newMemberCount;
             
                            // 停止轮询
                            if (this.poll_interval) {
                                clearInterval(this.poll_interval);
                                this.poll_interval = null;
                        }
                        
                            this.reconnectAndSeed();
                        }
                            return;
                        }
                        
                    this.log(`📩 收到 Lobby Snapshot, ID=${lobby.lobbyId.toString()}`);
                    this.onEnterLobby(true);
             }
            } catch(e) {}
        }
        // 监听加入结果 (7113)
        else if (cleanMsgType === k_EMsgGCPracticeLobbyJoinResponse) {
             try {
                const response = CMsgPracticeLobbyJoinResponse.decode(payload);
                if (response.result === 0) {
                    this.log('✅ 加入成功 (7113)');
                    this.onEnterLobby();
                } else {
                    this.log(`❌ 加入失败 (Code: ${response.result}) - 等待 Leader 重试或新信号`);
                    // Followers 这里可以不做处理，等待下一次信号
                    // 如果是 Leader 失败，可能需要重试创建
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
                
                // [修复] Leader 在播种模式下，收到 ReadyUpStatus 也应启动轮询
                // 因为某些情况下 7004 不会到达，但 7170 能确认我们在房间里
                if (this.role === 'LEADER' && this.isSeeding && !this.poll_interval && this.state === 'SEEDING') {
                    this.log(`🔍 [ReadyUpStatus触发] 启动 Leader 轮询检测 (每 1 秒)`);
                    this.startLeaderPolling();
                }
                
                setTimeout(() => this.sendReadyUp(this.currentLobbyId), 200);
            } catch(e) {}
        }
    }

    onEnterLobby(isSnapshot = false) {
        // [修正] Leader 在播种模式下，必须保持 SEEDING 状态，不能变成 IN_LOBBY
        // 否则会导致 7004 消息处理逻辑中无法启动轮询
        if (this.role === 'LEADER' && this.isSeeding) {
            this.log('🏁 [播种模式] 保持 SEEDING 状态，执行进房初始化...');
        } else {
            if (this.state === 'IN_LOBBY') return;
            this.state = 'IN_LOBBY';
            this.log('🏁 进入房间状态维护模式');
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

if (fleets.length === 0) {
    console.error("❌ 未找到车队配置 (config.fleets)");
    process.exit(1);
}

console.log(`[System] 加载了 ${fleets.length} 个车队配置`);
const fleetManagers = [];

fleets.forEach(fleetConfig => {
    const fleet = new FleetManager(fleetConfig, globalSettings);
    fleetManagers.push(fleet);
    fleet.start();
});

process.on('SIGINT', () => {
    console.log("\n[System] 正在退出...");
    fleetManagers.forEach(f => f.cleanup());
    setTimeout(() => process.exit(0), 2000);
});

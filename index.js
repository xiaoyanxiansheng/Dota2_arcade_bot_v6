const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');

console.log("[System] 启动 v6.17 协议修复版 - 使用正确 Proto 结构...");

const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientWelcome = 4007;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgGCAbandonCurrentGame = 7035;            // 放弃当前游戏
const k_EMsgGCPracticeLobbyCreate = 7038;
const k_EMsgGCPracticeLobbyLeave = 7040;            // 离开 Lobby（正确的ID）
const k_EMsgGCPracticeLobbyJoin = 7044;
const k_EMsgGCPracticeLobbyResponse = 7055;         // Lobby 操作响应
const k_EMsgGCPracticeLobbyJoinResponse = 7113;
const k_EMsgGCJoinableCustomLobbiesRequest = 7468;  // 请求可加入的自定义游戏房间列表
const k_EMsgGCJoinableCustomLobbiesResponse = 7469; // 房间列表响应
const k_EMsgGCQuickJoinCustomLobby = 7470;          // 快速加入自定义游戏
const k_EMsgGCQuickJoinCustomLobbyResponse = 7471;  // 快速加入响应
const k_EMsgGCReadyUp = 7070;                       // 准备就绪
const k_EMsgGCReadyUpStatus = 7170;                 // 准备就绪状态更新（房主发起匹配时）
const k_EMsgGCPracticeLobbySetTeamSlot = 7047;      // 设置队伍位置
const k_EMsgProtoMask = 0x80000000;

// Dota 2 枚举定义
const DOTA_GC_TEAM = {
    DOTA_GC_TEAM_GOOD_GUYS: 0, // 天辉 (Radiant)
    DOTA_GC_TEAM_BAD_GUYS: 1,  // 夜魇 (Dire)
    DOTA_GC_TEAM_BROADCASTER: 2,
    DOTA_GC_TEAM_SPECTATOR: 3,
    DOTA_GC_TEAM_PLAYER_POOL: 4,
    DOTA_GC_TEAM_NOTEAM: 5
};

const DOTABotDifficulty = {
    BOT_DIFFICULTY_PASSIVE: 0,
    BOT_DIFFICULTY_EASY: 1,
    BOT_DIFFICULTY_MEDIUM: 2,
    BOT_DIFFICULTY_HARD: 3,
    BOT_DIFFICULTY_UNFAIR: 4
};

// ReadyUp 状态枚举（关键！）
const DOTALobbyReadyState = {
    DOTALobbyReadyState_UNDECLARED: 0,  // 未声明（默认）
    DOTALobbyReadyState_NOT_READY: 1,   // 未准备
    DOTALobbyReadyState_READY: 2        // 已准备 ← 这是我们需要的！
};

let CMsgClientHello, CMsgPracticeLobbyJoin, CMsgPracticeLobbyJoinResponse, CMsgPracticeLobbyCreate, CMsgPracticeLobbySetDetails, CMsgJoinableCustomLobbiesRequest, CMsgJoinableCustomLobbiesResponse, CMsgQuickJoinCustomLobby, CMsgQuickJoinCustomLobbyResponse, CMsgPracticeLobbySetTeamSlot, CMsgReadyUp, CMsgReadyUpStatus, CSODOTALobby, CDOTAClientHardwareSpecs;
let targetLobbyToJoin = null;  // 存储要加入的房间信息
let currentLobbyId = null;     // 存储当前所在的房间ID (Long)

try {
    // 加载所有相关的 proto 文件
    const root = new protobuf.Root();
    
    // 设置解析 import 的根目录，这样 import "google/protobuf/descriptor.proto" 就能找到了
    root.resolvePath = function(origin, target) {
        // 如果是绝对路径，直接返回
        if (fs.existsSync(target)) {
            return target;
        }
        // 尝试在 Protobufs 目录下找
        const pathInProtobufs = "Protobufs/" + target;
        if (fs.existsSync(pathInProtobufs)) {
            return pathInProtobufs;
        }
        // 尝试在 dota2 目录下找 (对于同目录 import)
        const pathInDota2 = "Protobufs/dota2/" + target;
        if (fs.existsSync(pathInDota2)) {
            return pathInDota2;
        }
        return target;
    };

    // 按顺序加载，先加载基础定义
    root.loadSync("Protobufs/google/protobuf/descriptor.proto");
    root.loadSync("Protobufs/dota2/networkbasetypes.proto"); 
    root.loadSync("Protobufs/dota2/network_connection.proto");
    root.loadSync("Protobufs/dota2/steammessages.proto");
    root.loadSync("Protobufs/dota2/gcsdk_gcmessages.proto");
    root.loadSync("Protobufs/dota2/dota_shared_enums.proto");
    root.loadSync("Protobufs/dota2/dota_client_enums.proto");
    root.loadSync("Protobufs/dota2/base_gcmessages.proto"); // CMsgPracticeLobbySetDetails 可能依赖它
    root.loadSync("Protobufs/dota2/dota_gcmessages_common_lobby.proto");
    root.loadSync("Protobufs/dota2/dota_gcmessages_client_match_management.proto");
    root.loadSync("Protobufs/dota2/dota_gcmessages_client.proto");

    // 注意：Dota 2 的 proto 文件没有 package 声明，所有类型在全局命名空间
    CMsgClientHello = root.lookupType("CMsgClientHello");
    CMsgPracticeLobbyJoin = root.lookupType("CMsgPracticeLobbyJoin");
    CMsgPracticeLobbyJoinResponse = root.lookupType("CMsgPracticeLobbyJoinResponse");
    CMsgPracticeLobbyCreate = root.lookupType("CMsgPracticeLobbyCreate");
    CMsgPracticeLobbySetDetails = root.lookupType("CMsgPracticeLobbySetDetails");
    CMsgJoinableCustomLobbiesRequest = root.lookupType("CMsgJoinableCustomLobbiesRequest");
    CMsgJoinableCustomLobbiesResponse = root.lookupType("CMsgJoinableCustomLobbiesResponse");
    CMsgQuickJoinCustomLobby = root.lookupType("CMsgQuickJoinCustomLobby");
    CMsgQuickJoinCustomLobbyResponse = root.lookupType("CMsgQuickJoinCustomLobbyResponse");
    CMsgPracticeLobbySetTeamSlot = root.lookupType("CMsgPracticeLobbySetTeamSlot");
    CMsgReadyUp = root.lookupType("CMsgReadyUp");
    CMsgReadyUpStatus = root.lookupType("CMsgReadyUpStatus");
    CSODOTALobby = root.lookupType("CSODOTALobby");
    CDOTAClientHardwareSpecs = root.lookupType("CDOTAClientHardwareSpecs");
    
    console.log("[Proto] 所有 Proto 文件加载成功");
} catch (e) {
    console.error("❌ Proto 加载失败: " + e.message);
    process.exit(1);
}

// 模拟硬件信息
function getHardwareSpecs() {
    return {
        logical_processors: 8,
        cpu_cycles_per_second: Long.fromNumber(3600000000), // 3.6 GHz
        total_physical_memory: Long.fromNumber(17179869184), // 16 GB
        is_64_bit_os: true,
        upload_measurement: Long.fromNumber(10485760), // 10 MB/s
        prefer_not_host: false
    };
}

let config;
try { 
    const rawContent = fs.readFileSync('./config.json', 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(rawContent); 
} catch (e) { 
    console.error("❌ Config Error: " + e.message);
    setTimeout(() => process.exit(1), 60000);
    return;
}

config.accounts.forEach((account) => {
    const client = new SteamUser();
    let is_gc_connected = false;
    let gc_ready = false;
    let join_interval = null;
    let retry_count = 0;  // 重试计数器
    const MAX_RETRIES = 3;  // 最多重试3次
    let direct_join_fail_count = 0;  // 直接加入失败次数
    const MAX_DIRECT_JOIN_FAILS = 2;  // 最多失败2次后切换到创建房间
    let is_creating_lobby = false;  // 是否正在创建房间
    let ready_up_heartbeat = null;  // ReadyUp 心跳定时器

    // [新增] 显式创建房间函数
    const createLobby = () => {
        try {
            console.log(`[${account.username}] 🔨 开始创建新房间 (7038)...`);
            const gameId = config.cluster_settings.custom_game_id;
            const gameIdLong = Long.fromString(gameId, true);
            
            // [新增] 硬编码当前版本的 CRC 和 Timestamp (从之前的日志中获取)
            // 注意：当游戏更新时，这些值会改变，需要重新获取！
            const knownCrc = "1396649696593898392";
            const knownTimestamp = 1763646905;
            const crcLong = Long.fromString(knownCrc, true);
            
            // 步骤1: 尝试创建 lobbyDetails
            console.log(`[${account.username}] 🔧 步骤1: 创建 lobbyDetails...`);
            console.log(`[${account.username}] 🔍 custom_game_id (Long): ${gameIdLong.toString()}, unsigned=${gameIdLong.unsigned}`);
            
            let lobbyDetails;
            try {
                // 极简版配置，只保留最核心字段
                const detailsPayload = {
                    customGameId: gameIdLong,        
                    gameName: `Bot Room ${Date.now() % 10000}`,
                    serverRegion: 14,                // 14 = Singapore
                    gameMode: 15,                    // 15 = DOTA_GAMEMODE_CUSTOM (修正值)
                    customMaxPlayers: 4,             // 根据 addoninfo.txt，最大通常是 4
                    customMinPlayers: 1,
                    allowSpectating: true,
                    allchat: true,
                    fillWithBots: false,
                    allowCheats: false,
                    visibility: 0,                   // Public
                    customMapName: "zudui_team_map"
                };
                
                console.log(`[${account.username}] 🔍 detailsPayload 准备: ${JSON.stringify(detailsPayload, (k, v) => {
                    if (v && typeof v === 'object' && v.low !== undefined && v.high !== undefined) {
                        return Long.fromValue(v).toString();
                    }
                    return v;
                }, 2)}`);
                
                lobbyDetails = CMsgPracticeLobbySetDetails.create(detailsPayload);
                
                console.log(`[${account.username}] ✅ lobbyDetails 创建成功`);
                console.log(`[${account.username}] 🔍 lobbyDetails 实际内容: ${JSON.stringify(lobbyDetails, (k, v) => {
                    if (v && typeof v === 'object' && v.low !== undefined && v.high !== undefined) {
                        return Long.fromValue(v).toString();
                    }
                    return v;
                }, 2)}`);
            } catch (detailsErr) {
                console.error(`[${account.username}] ❌ lobbyDetails 创建失败: ${detailsErr.message}`);
                throw detailsErr;
            }
            
            // 步骤2: 创建完整的创建请求
            const searchKey = ""; // 留空
            console.log(`[${account.username}] 🔧 步骤2: 创建 createPayload，search_key="${searchKey}"`);
            
            let createPayload;
            try {
                // 外层消息也需要驼峰命名
                createPayload = {
                    searchKey: searchKey,      // search_key -> searchKey
                    passKey: "123",            // pass_key -> passKey (尝试使用密码)
                    clientVersion: 0,          // client_version -> clientVersion
                    lobbyDetails: lobbyDetails // lobby_details -> lobbyDetails
                };
                console.log(`[${account.username}] ✅ createPayload 对象创建成功`);
            } catch (payloadErr) {
                console.error(`[${account.username}] ❌ createPayload 创建失败: ${payloadErr.message}`);
                throw payloadErr;
            }
            
            // 步骤3: Protobuf 编码
            console.log(`[${account.username}] 🔧 步骤3: Protobuf 编码...`);
            let message, buffer;
            try {
                message = CMsgPracticeLobbyCreate.create(createPayload);
                console.log(`[${account.username}] ✅ Protobuf message 创建成功`);
                
                // 验证 message
                const errMsg = CMsgPracticeLobbyCreate.verify(createPayload);
                if (errMsg) {
                    console.error(`[${account.username}] ⚠️ Protobuf 验证失败: ${errMsg}`);
                }
                
                buffer = CMsgPracticeLobbyCreate.encode(message).finish();
                console.log(`[${account.username}] ✅ 编码完成，buffer 长度: ${buffer.length} bytes`);
            } catch (encodeErr) {
                console.error(`[${account.username}] ❌ Protobuf 编码失败: ${encodeErr.message}`);
                console.error(`[${account.username}] 编码错误堆栈: ${encodeErr.stack}`);
                throw encodeErr;
            }
            
            // 步骤4: 发送数据包
            if (buffer.length === 0) {
                console.error(`[${account.username}] ❌ 严重错误：编码后数据包为空！`);
                console.error(`[${account.username}] createPayload 内容: ${JSON.stringify(createPayload, null, 2)}`);
                return;
            }
            
            console.log(`[${account.username}] 📦 数据包Hex (前50字节): ${buffer.slice(0, 50).toString('hex')}`);
            
            client.sendToGC(570, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
            console.log(`[${account.username}] 📤 发送创建房间请求 (7038)`);
            is_creating_lobby = true;
            
        } catch (err) {
            console.error(`[${account.username}] ❌ 创建房间总体失败: ${err.message}`);
            console.error(`[${account.username}] 错误堆栈: ${err.stack}`);
        }
    };

    // 房间列表请求函数（提升到外部作用域）
    const requestLobbyList = () => {
        try {
            const gameId = config.cluster_settings.custom_game_id;
            const gameIdLong = Long.fromString(gameId, true);
            
            const payload = {
                server_region: 0,           // 0 = 不限区域
                custom_game_id: gameIdLong
            };
            
            const message = CMsgJoinableCustomLobbiesRequest.create(payload);
            const buffer = CMsgJoinableCustomLobbiesRequest.encode(message).finish();
            
            console.log(`[${account.username}] 📤 请求可加入的房间列表 (7468) - 游戏ID: ${gameId}`);
            console.log(`[${account.username}] 📦 请求 Payload: ${buffer.toString('hex')}`);
            client.sendToGC(570, k_EMsgGCJoinableCustomLobbiesRequest | k_EMsgProtoMask, {}, buffer);
        } catch (err) {
            console.error(`[${account.username}] ❌ Request Lobby List Error: ${err.message}`);
        }
    };

    // 尝试加入房间（优先直接加入，否则创建新房间）
    const joinOrCreateLobby = () => {
        try {
            // 如果找到了可用房间，直接加入
            if (targetLobbyToJoin && targetLobbyToJoin.lobbyId) {
                console.log(`[${account.username}] 📤 直接加入房间 (7044) - Lobby ID: ${targetLobbyToJoin.lobbyId}`);
                
                // 正确处理字段类型和命名
                // 重要：Protobuf.js 使用驼峰命名（lobbyId），而不是下划线命名（lobby_id）
                
                let lobbyId = targetLobbyToJoin.lobbyId;
                
                // 确保 lobbyId 是 Long 对象（从响应中提取时已经是）
                if (typeof lobbyId === 'string') {
                    lobbyId = Long.fromString(lobbyId, true);
                } else if (typeof lobbyId === 'number') {
                    lobbyId = Long.fromNumber(lobbyId, true);
                }
                
                // CRC: 转换为 Long 对象
                let crcValue = targetLobbyToJoin.customGameCrc;
                if (typeof crcValue === 'string') {
                    crcValue = Long.fromString(crcValue, true);
                } else if (typeof crcValue === 'number') {
                    crcValue = Long.fromNumber(crcValue, true);
                }
                
                // Timestamp: 确保是数字
                let timestampValue = targetLobbyToJoin.customGameTimestamp;
                if (typeof timestampValue === 'string') {
                    timestampValue = parseInt(timestampValue);
                }
                
                // 使用驼峰命名构建请求
                const payload = {
                    lobbyId: lobbyId,
                    customGameCrc: crcValue,
                    customGameTimestamp: timestampValue
                };
                
                console.log(`[${account.username}] 📊 加入请求: Lobby=${lobbyId}, CRC=${crcValue}, TS=${timestampValue}`);
                
                try {
                    const message = CMsgPracticeLobbyJoin.create(payload);
                    const buffer = CMsgPracticeLobbyJoin.encode(message).finish();
                    
                    console.log(`[${account.username}] 📦 数据包长度: ${buffer.length} bytes`);
                    
                    if (buffer.length === 0) {
                        console.error(`[${account.username}] ❌ 错误：数据包为空！`);
                        return;
                    }
                    
                    client.sendToGC(570, k_EMsgGCPracticeLobbyJoin | k_EMsgProtoMask, {}, buffer);
                } catch (encodeError) {
                    console.error(`[${account.username}] ❌ Protobuf 编码失败: ${encodeError.message}`);
                }
                
            } else {
                // 没有可用房间，直接创建
                console.log(`[${account.username}] ⚠️ 没有可用房间 - Bot 将创建新房间`);
                createLobby();
            }
        } catch (err) {
            console.error(`[${account.username}] ❌ Join/Create Error: ${err.message}`);
        }
    };

    const logOnOptions = {
        accountName: account.username,
        password: account.password
    };

    if (account.shared_secret && account.shared_secret.length > 5) {
        try { logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(account.shared_secret); } catch (err) {}
    }

    client.logOn(logOnOptions);

    client.on('loggedOn', () => {
        console.log(`[${account.username}] Steam 登录成功`);
        client.setPersona(SteamUser.EPersonaState.Online);
        client.gamesPlayed([570]);
    });

    client.on('appLaunched', (appid) => {
        if (appid === 570) {
            console.log(`[${account.username}] 🎮 Dota 2 启动`);
            gc_ready = true;
            setTimeout(connectGC, 2000);
        }
    });

    function connectGC() {
        console.log(`[${account.username}] 开始连接 GC...`);
        sendHello();
        setInterval(() => { if(!is_gc_connected) sendHello(); }, 5000);
    }

    function sendHello() {
        try {
            const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
            const message = CMsgClientHello.create(payload);
            const buffer = CMsgClientHello.encode(message).finish();
            client.sendToGC(570, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    function joinArcadeGame() {
        if (join_interval) return;

        console.log(`[${account.username}] 🚀 策略：先清除状态，再查询房间并加入...`);
        
        // 先清除可能存在的"已在游戏中"状态
        console.log(`[${account.username}] 🔄 预防性清除：发送 AbandonCurrentGame (7035)`);
        client.sendToGC(570, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
        
        setTimeout(() => {
            console.log(`[${account.username}] 🔄 预防性清除：发送 LeaveLobby (7040)`);
            client.sendToGC(570, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        }, 500);
        
        // 延迟1.5秒后开始正常流程（等待清除状态完成）
        setTimeout(() => {
            // 先请求列表
            requestLobbyList();
            
            // 2.5秒后尝试加入（给房间列表足够的解析时间）
            setTimeout(joinOrCreateLobby, 2500);
            
            // 每60秒重新查询并尝试加入（只有在未成功加入时才继续）
            join_interval = setInterval(() => {
                if (join_interval) {  // 检查是否仍需要尝试
                    requestLobbyList();
                    setTimeout(joinOrCreateLobby, 1000);
                }
            }, 60000);
        }, 1500);
    }

    client.on('receivedFromGC', (appid, msgType, payload) => {
        if (appid !== 570) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;
        
        // 只打印重要消息，过滤掉心跳等无关消息
        const importantMessages = [4004, 4007, 7035, 7040, 7044, 7113, 7469, 7471, 7055, 7056, 7430, 7367, 7388, 7004, 7170];
        if (importantMessages.includes(cleanMsgType)) {
            console.log(`[${account.username}] 📨 收到 GC 消息: ${cleanMsgType} (0x${cleanMsgType.toString(16)})`);
        }
        
        if (cleanMsgType === k_EMsgGCClientWelcome || cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!is_gc_connected) {
                console.log(`[${account.username}] ✅ GC 连接确认`);
                is_gc_connected = true;
                setTimeout(joinArcadeGame, 2000);
            }
        }
        else if (cleanMsgType === k_EMsgGCJoinableCustomLobbiesResponse) { // 7469
            console.log(`[${account.username}] 📥 收到房间列表响应 (7469)`);
            console.log(`[${account.username}] 📦 原始 Payload (前100字节): ${payload.slice(0, 100).toString('hex')}`);
            console.log(`[${account.username}] 📦 Payload 总长度: ${payload.length} bytes`);
            
            try {
                const response = CMsgJoinableCustomLobbiesResponse.decode(payload);
                const targetGameId = config.cluster_settings.custom_game_id;
                
                // 手动过滤匹配我们游戏 ID 的房间
                const matchingLobbies = response.lobbies ? response.lobbies.filter(lobby => {
                    const lobbyGameId = lobby.customGameId ? lobby.customGameId.toString() : '0';
                    return lobbyGameId === targetGameId;
                }) : [];
                
                console.log(`[${account.username}] 📊 总房间数: ${response.lobbies ? response.lobbies.length : 0}`);
                console.log(`[${account.username}] 🎯 匹配我们游戏 ID (${targetGameId}) 的房间: ${matchingLobbies.length}`);
                
                if (matchingLobbies.length > 0) {
                    console.log(`[${account.username}] ✅ 找到 ${matchingLobbies.length} 个可加入的房间！`);
                    
                    // 寻找一个不满的房间（优先选择人少的）
                    const availableLobbies = matchingLobbies.filter(lobby => {
                        const current = lobby.memberCount || 0;
                        const max = lobby.maxPlayerCount || 10;
                        return current < max && !lobby.hasPassKey;  // 未满且无密码
                    });
                    
                    // 按人数排序，优先加入人多的房间（更活跃）
                    availableLobbies.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
                    
                    matchingLobbies.slice(0, 3).forEach((lobby, idx) => {
                        console.log(`[${account.username}]   房间${idx+1}: 玩家=${lobby.memberCount}/${lobby.maxPlayerCount}, 地图=${lobby.customMapName}, 有密码=${lobby.hasPassKey ? '是' : '否'}`);
                    });
                    
                    if (availableLobbies.length > 0) {
                        targetLobbyToJoin = availableLobbies[0];
                        console.log(`[${account.username}] 🎯 选中目标房间: ID=${targetLobbyToJoin.lobbyId}, 玩家=${targetLobbyToJoin.memberCount}/${targetLobbyToJoin.maxPlayerCount}`);
                        console.log(`[${account.username}] 🔍 房间详细信息:`);
                        console.log(`[${account.username}]    - Leader: ${targetLobbyToJoin.leaderAccountId} (${targetLobbyToJoin.leaderName})`);
                        console.log(`[${account.username}]    - CRC: ${targetLobbyToJoin.customGameCrc}`);
                        console.log(`[${account.username}]    - Timestamp: ${targetLobbyToJoin.customGameTimestamp}`);
                        console.log(`[${account.username}]    - Server Region: ${targetLobbyToJoin.serverRegion}`);
                        console.log(`[${account.username}]    - Lobby Creation Time: ${targetLobbyToJoin.lobbyCreationTime}`);
                        console.log(`[${account.username}]    - Has Pass Key: ${targetLobbyToJoin.hasPassKey}`);
                        
                        // 打印所有字段用于调试
                        console.log(`[${account.username}] 🔍 完整房间对象:`, JSON.stringify(targetLobbyToJoin, (key, value) => {
                            // 处理 Long 类型
                            if (value && typeof value === 'object' && value.low !== undefined && value.high !== undefined) {
                                return Long.fromValue(value).toString();
                            }
                            return value;
                        }, 2));
                    } else {
                        console.log(`[${account.username}] ⚠️ 所有房间都已满或需要密码 - Bot 会创建新房间`);
                        targetLobbyToJoin = null;
                    }
                } else {
                    console.log(`[${account.username}] ⚠️ 当前没有人在玩这个地图 - 这是正常的！Bot 会创建新房间。`);
                    targetLobbyToJoin = null;
                }
            } catch (e) {
                console.log(`[${account.username}] ⚠️ 解析房间列表失败: ${e.message}`);
            }
        }
        else if (cleanMsgType === k_EMsgGCPracticeLobbyJoinResponse) { // 7113 - 直接加入房间的响应
            console.log(`[${account.username}] 📥 收到直接加入响应 (7113)`);
            console.log(`[${account.username}] 📦 Payload Hex: ${payload.toString('hex')}`);
            try {
                const response = CMsgPracticeLobbyJoinResponse.decode(payload);
                const resultCodes = {
                    0: 'SUCCESS - 成功',
                    1: 'ALREADY_IN_GAME - 已经在游戏中',
                    2: 'INVALID_LOBBY - 无效房间',
                    3: 'INCORRECT_PASSWORD - 密码错误',
                    4: 'ACCESS_DENIED - 访问被拒绝',
                    5: 'GENERIC_ERROR - 通用错误',
                    6: 'INCORRECT_VERSION - 版本不正确',
                    7: 'IN_TEAM_PARTY - 在队伍中',
                    8: 'NO_LOBBY_FOUND - 未找到房间',
                    9: 'LOBBY_FULL - 房间已满',
                    10: 'CUSTOM_GAME_INCORRECT_VERSION - 自定义游戏版本不正确',
                    11: 'TIMEOUT - 超时',
                    12: 'CUSTOM_GAME_COOLDOWN - 自定义游戏冷却中',
                    13: 'BUSY - 忙碌',
                    14: 'NO_PLAYTIME - 没有游戏时间'
                };
                const resultMsg = resultCodes[response.result] || `未知错误码: ${response.result}`;
                console.log(`[${account.username}] 📊 直接加入结果: ${response.result} (${resultMsg})`);
                
                if (response.result === 0) {
                    console.log(`[${account.username}] ✅ 成功直接加入房间！`);
                    
                    // 保存当前 Lobby ID
                    if (targetLobbyToJoin && targetLobbyToJoin.lobbyId) {
                        currentLobbyId = targetLobbyToJoin.lobbyId;
                        // 确保是 Long 对象
                        if (typeof currentLobbyId === 'string' || typeof currentLobbyId === 'number') {
                            currentLobbyId = Long.fromValue(currentLobbyId);
                        }
                        console.log(`[${account.username}] 💾 保存当前 Lobby ID: ${currentLobbyId.toString()}`);
                    }

                    retry_count = 0;
                    direct_join_fail_count = 0;  // 重置失败计数
                    targetLobbyToJoin = null;  // 清除目标房间
                    
                    // 停止重复发送加入请求
                    if (join_interval) {
                        clearInterval(join_interval);
                        join_interval = null;
                        console.log(`[${account.username}] 🛑 停止房间查询循环 - Bot 已成功加入`);
                    }
                    
                    // 定义发送 ReadyUp 的函数（用于初始发送和周期性心跳）
                    const sendReadyUp = () => {
                        try {
                            const readyPayload = {
                                state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                                hardware_specs: getHardwareSpecs()
                            };
                            if (currentLobbyId) {
                                readyPayload.ready_up_key = currentLobbyId;
                            }
                            
                            const readyMessage = CMsgReadyUp.create(readyPayload);
                            const readyBuffer = CMsgReadyUp.encode(readyMessage).finish();
                            client.sendToGC(570, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, readyBuffer);
                        } catch (err) {
                            console.error(`[${account.username}] ❌ ReadyUp 心跳失败: ${err.message}`);
                        }
                    };
                    
                    // 关键：发送 ReadyUp，标记为"已准备"状态
                    setTimeout(() => {
                        try {
                            // 步骤1: 设置队伍位置（加入天辉队伍）
                            const teamSlotPayload = {
                                team: DOTA_GC_TEAM.DOTA_GC_TEAM_GOOD_GUYS,  // 0 = 天辉
                                slot: 0  // 第一个位置
                            };
                            
                            const teamSlotMessage = CMsgPracticeLobbySetTeamSlot.create(teamSlotPayload);
                            const teamSlotBuffer = CMsgPracticeLobbySetTeamSlot.encode(teamSlotMessage).finish();
                            
                            console.log(`[${account.username}] 📤 设置队伍位置 (7047) - 加入天辉队`);
                            client.sendToGC(570, k_EMsgGCPracticeLobbySetTeamSlot | k_EMsgProtoMask, {}, teamSlotBuffer);
                            
                            // 步骤2: 500ms后发送初始 ReadyUp
                            setTimeout(() => {
                                sendReadyUp();
                                console.log(`[${account.username}] ✅ Bot 已标记为"准备就绪"状态`);
                                console.log(`[${account.username}] 🎯 现在应该会被计入在线玩家统计！`);
                                
                                // 步骤3: 启动 ReadyUp 心跳（每30秒发送一次，保持在线状态）
                                if (ready_up_heartbeat) {
                                    clearInterval(ready_up_heartbeat);
                                }
                                ready_up_heartbeat = setInterval(() => {
                                    sendReadyUp();
                                    console.log(`[${account.username}] 💓 ReadyUp 心跳发送`);
                                }, 30000);  // 每30秒一次
                            }, 500);
                        } catch (err) {
                            console.error(`[${account.username}] ❌ 发送准备信号失败: ${err.message}`);
                        }
                    }, 1000);
                    
                    console.log(`[${account.username}] 🎮 Bot 正在初始化...`);
                    
                } else if (response.result === 2) {  // INVALID_LOBBY
                    direct_join_fail_count++;
                    console.log(`[${account.username}] ⚠️ 房间无效（可能协议不匹配）`);
                    console.log(`[${account.username}] 📊 直接加入失败次数: ${direct_join_fail_count}/${MAX_DIRECT_JOIN_FAILS}`);
                    
                    targetLobbyToJoin = null;  // 清除目标
                    
                    // 尝试使用 CreateLobby 创建房间
                    if (direct_join_fail_count >= MAX_DIRECT_JOIN_FAILS && !is_creating_lobby) {
                        console.log(`[${account.username}] 🔄 切换策略：直接创建新房间`);
                        createLobby();
                    }
                    
                } else if (response.result === 9) {
                    console.log(`[${account.username}] ⚠️ 房间已满 - 尝试其他房间或创建新房间`);
                    targetLobbyToJoin = null;  // 清除目标，下次尝试创建新房间
                } else {
                    console.log(`[${account.username}] ❌ 直接加入失败: ${resultMsg}`);
                    targetLobbyToJoin = null;  // 清除目标
                }
            } catch (e) {
                console.log(`[${account.username}] ⚠️ 解析直接加入响应失败: ${e.message}`);
            }
        }
        else if (cleanMsgType === k_EMsgGCQuickJoinCustomLobbyResponse) { // 7471
            console.log(`[${account.username}] 📥 收到快速加入响应 (7471)`);
            console.log(`[${account.username}] 📦 Payload Hex: ${payload.toString('hex')}`);
            try {
                const response = CMsgQuickJoinCustomLobbyResponse.decode(payload);
                const resultCodes = {
                    0: 'SUCCESS - 成功',
                    1: 'ALREADY_IN_GAME - 已经在游戏中',
                    2: 'INVALID_LOBBY - 无效房间',
                    3: 'INCORRECT_PASSWORD - 密码错误',
                    4: 'ACCESS_DENIED - 访问被拒绝',
                    5: 'GENERIC_ERROR - 通用错误',
                    6: 'INCORRECT_VERSION - 版本不正确',
                    7: 'IN_TEAM_PARTY - 在队伍中',
                    8: 'NO_LOBBY_FOUND - 未找到房间',
                    9: 'LOBBY_FULL - 房间已满',
                    10: 'CUSTOM_GAME_INCORRECT_VERSION - 自定义游戏版本不正确',
                    11: 'TIMEOUT - 超时',
                    12: 'CUSTOM_GAME_COOLDOWN - 自定义游戏冷却中',
                    13: 'BUSY - 忙碌',
                    14: 'NO_PLAYTIME - 没有游戏时间'
                };
                const resultMsg = resultCodes[response.result] || `未知错误码: ${response.result}`;
                console.log(`[${account.username}] 📊 结果代码: ${response.result} (${resultMsg})`);
                
                // 如果 QuickJoin 失败 (例如 NO_LOBBY_FOUND = 8)，则尝试创建
                if (response.result === 8) { 
                    console.log(`[${account.username}] ⚠️ QuickJoin 未找到房间，尝试直接创建...`);
                    createLobby();
                    return;
                }

                if (response.result === 0) { // DOTA_JOIN_RESULT_SUCCESS - 0 才是成功！
                    console.log(`[${account.username}] ✅ 成功加入房间！`);
                    console.log(`[${account.username}] 🚀 发送后续保活信号...`);
                    
                    // 重置重试计数器
                    retry_count = 0;
                    
                    // 先设置队伍位置，再发送 ReadyUp
                    setTimeout(() => {
                        try {
                            const teamSlotPayload = {
                                team: DOTA_GC_TEAM.DOTA_GC_TEAM_GOOD_GUYS,
                                slot: 0
                            };
                            const teamSlotMessage = CMsgPracticeLobbySetTeamSlot.create(teamSlotPayload);
                            const teamSlotBuffer = CMsgPracticeLobbySetTeamSlot.encode(teamSlotMessage).finish();
                            client.sendToGC(570, k_EMsgGCPracticeLobbySetTeamSlot | k_EMsgProtoMask, {}, teamSlotBuffer);
                            console.log(`[${account.username}] 📤 设置队伍位置 (7047)`);
                            
                            setTimeout(() => {
                                const readyPayload = {
                                    state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                                    hardware_specs: getHardwareSpecs()
                                };
                                if (currentLobbyId) readyPayload.ready_up_key = currentLobbyId;

                                const readyMessage = CMsgReadyUp.create(readyPayload);
                                const readyBuffer = CMsgReadyUp.encode(readyMessage).finish();
                                client.sendToGC(570, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, readyBuffer);
                                console.log(`[${account.username}] 📤 发送 ReadyUp (7070) + HardwareSpecs`);
                            }, 300);
                        } catch (err) {
                            console.error(`[${account.username}] ❌ 设置队伍失败: ${err.message}`);
                        }
                    }, 500);
                    
                } else if (response.result === 1) {
                    if (is_creating_lobby) {
                        console.log(`[${account.username}] ℹ️ Bot 正在创建房间，ALREADY_IN_GAME 是正常的`);
                        console.log(`[${account.username}] 🕐 等待房间创建完成...`);
                        return;  // 不做任何处理，等待创建房间响应
                    }
                    
                    console.log(`[${account.username}] ℹ️ Bot 已经在游戏中 - 可能是刚创建的房间！`);
                    console.log(`[${account.username}] 🕐 等待 3 秒，看是否收到 Lobby 快照...`);
                    
                    // 等待3秒，如果没收到 Lobby 快照，才清除状态
                    setTimeout(() => {
                        if (!join_interval) {
                            // 如果 join_interval 已被清除，说明收到了 Lobby 快照，不需要做任何事
                            console.log(`[${account.username}] ✅ 已确认在 Lobby 中，无需重试`);
                            return;
                        }
                        
                        retry_count++;
                        if (retry_count > MAX_RETRIES) {
                            console.log(`[${account.username}] ❌ 已达最大重试次数 (${MAX_RETRIES})，停止尝试`);
                            console.log(`[${account.username}] 💡 建议：手动启动 Dota 2 客户端，进入并退出一次游戏`);
                            return;
                        }
                        
                        console.log(`[${account.username}] ⚠️ 未收到 Lobby 快照 - 清除状态并重试`);
                        console.log(`[${account.username}] 🔄 步骤1: 放弃当前游戏 (7035)`);
                        
                        // 先发送 AbandonCurrentGame 来彻底清除状态
                        client.sendToGC(570, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                        console.log(`[${account.username}] 📤 发送 AbandonCurrentGame (7035)`);
                        
                        // 500ms 后发送 LeaveLobby
                        setTimeout(() => {
                            console.log(`[${account.username}] 🔄 步骤2: 离开 Lobby (7040)`);
                            client.sendToGC(570, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                            console.log(`[${account.username}] 📤 发送 LeaveLobby (7040)`);
                        }, 500);
                        
                        // 2秒后重新尝试加入
                        setTimeout(() => {
                            console.log(`[${account.username}] 🔄 步骤3: 重新查询房间并尝试加入...`);
                            targetLobbyToJoin = null;  // 清除之前的目标
                            requestLobbyList();
                            setTimeout(joinOrCreateLobby, 1000);
                        }, 2000);
                    }, 3000);
                    
                } else {
                    console.log(`[${account.username}] ❌ 加入失败: ${resultMsg}`);
                }
            } catch (e) {
                console.log(`[${account.username}] ⚠️ 解析响应失败: ${e.message}`);
            }
        }
        else if (cleanMsgType === 7035) { // AbandonCurrentGame 可能的响应
             console.log(`[${account.username}] 📥 收到游戏放弃相关消息 (7035)`);
             console.log(`[${account.username}] ✅ 游戏状态已清除`);
        }
        else if (cleanMsgType === 7040) { // LeaveLobby 相关消息
             console.log(`[${account.username}] 📥 收到离开 Lobby 相关消息 (7040)`);
             // 停止心跳
             if (ready_up_heartbeat) {
                 clearInterval(ready_up_heartbeat);
                 ready_up_heartbeat = null;
                 console.log(`[${account.username}] 🛑 停止 ReadyUp 心跳`);
             }
        }
        else if (cleanMsgType === 7055) { // k_EMsgGCPracticeLobbyResponse - 创建房间响应
             console.log(`[${account.username}] 📥 收到 Lobby 操作响应 (7055)`);
             console.log(`[${account.username}] ✅ Lobby 操作已处理 - 房间创建成功！`);
             
             // 重置计数器和标志
             retry_count = 0;
             direct_join_fail_count = 0;
             is_creating_lobby = false;
             
             // 先设置队伍位置，再发送 ReadyUp
             setTimeout(() => {
                 try {
                     const teamSlotPayload = {
                         team: DOTA_GC_TEAM.DOTA_GC_TEAM_GOOD_GUYS,
                         slot: 0
                     };
                     const teamSlotMessage = CMsgPracticeLobbySetTeamSlot.create(teamSlotPayload);
                     const teamSlotBuffer = CMsgPracticeLobbySetTeamSlot.encode(teamSlotMessage).finish();
                     client.sendToGC(570, k_EMsgGCPracticeLobbySetTeamSlot | k_EMsgProtoMask, {}, teamSlotBuffer);
                     console.log(`[${account.username}] 📤 设置队伍位置 (7047)`);
                     
                     setTimeout(() => {
                         const readyPayload = {
                             state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                             hardware_specs: getHardwareSpecs()
                         };
                         // 如果有 currentLobbyId 加上
                         if (currentLobbyId) readyPayload.ready_up_key = currentLobbyId;

                         const readyMessage = CMsgReadyUp.create(readyPayload);
                         const readyBuffer = CMsgReadyUp.encode(readyMessage).finish();
                         client.sendToGC(570, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, readyBuffer);
                         console.log(`[${account.username}] 📤 发送 ReadyUp (7070) + HardwareSpecs`);
                     }, 300);
                 } catch (err) {
                     console.error(`[${account.username}] ❌ 设置队伍失败: ${err.message}`);
                 }
             }, 500);
        }
        else if (cleanMsgType === 7056) { // Broadcast Notification
             console.log(`[${account.username}] 📥 收到广播通知 (7056)`);
        }
        else if (cleanMsgType === 7430 || cleanMsgType === 7367) { // Lobby Update
             console.log(`[${account.username}] 🎮 收到 Lobby 更新! (消息ID: ${cleanMsgType})`);
             console.log(`[${account.username}] 🎮 这证明 Bot 确实在 Lobby 中！`);
             console.log(`[${account.username}] 📦 Payload 长度: ${payload.length} bytes`);
        }
        else if (cleanMsgType === 7004) { // Lobby Snapshot - 完整的 Lobby 状态
             console.log(`[${account.username}] 📸 收到 Lobby 快照 (7004) - Bot 成功进入房间！`);
             
             try {
                 const lobby = CSODOTALobby.decode(payload);
                 if (lobby.lobbyId) {
                     currentLobbyId = lobby.lobbyId;
                     console.log(`[${account.username}] 💾 更新 Lobby ID: ${currentLobbyId.toString()}`);
                 }
             } catch (e) {
                 console.error(`[${account.username}] ⚠️ 解析 Lobby Snapshot 失败: ${e.message}`);
             }

             console.log(`[${account.username}] ✅ 这意味着游戏在线人数应该已经增加！`);
             
             // 重置所有标志和计数器
             retry_count = 0;
             direct_join_fail_count = 0;
             is_creating_lobby = false;
             
             // 停止重复发送快速加入请求
             if (join_interval) {
                 clearInterval(join_interval);
                 join_interval = null;
                 console.log(`[${account.username}] 🛑 停止快速加入循环 - Bot 已稳定在房间中`);
             }
             
             // [新增] 收到 Lobby Snapshot 后，也启动心跳（双重保险）
             const sendReadyUp = () => {
                 try {
                     const readyPayload = {
                         state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                         hardware_specs: getHardwareSpecs()
                     };
                     if (currentLobbyId) {
                         readyPayload.ready_up_key = currentLobbyId;
                     }
                     const readyMessage = CMsgReadyUp.create(readyPayload);
                     const readyBuffer = CMsgReadyUp.encode(readyMessage).finish();
                     client.sendToGC(570, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, readyBuffer);
                 } catch (err) {
                     console.error(`[${account.username}] ❌ ReadyUp 心跳失败: ${err.message}`);
                 }
             };
             
             if (!ready_up_heartbeat) {
                 sendReadyUp();
                 ready_up_heartbeat = setInterval(() => {
                     sendReadyUp();
                     console.log(`[${account.username}] 💓 ReadyUp 心跳发送`);
                 }, 30000);
             }
        }
        else if (cleanMsgType === 7388) { // 可能是事件点数或其他游戏数据
             console.log(`[${account.username}] 📊 收到游戏数据更新 (7388)`);
        }
        else if (cleanMsgType === k_EMsgGCReadyUpStatus) { // 7170 - 房主发起"开始比赛"
             console.log(`[${account.username}] 🚨 收到 ReadyUp 状态更新 (7170) - 房主可能点击了"开始比赛"！`);
             
             try {
                 const status = CMsgReadyUpStatus.decode(payload);
                 console.log(`[${account.username}] 🔍 ReadyCheck 详情: ID=${status.lobbyId}, LocalState=${status.localReadyState}`);
                 
                 if (status.lobbyId) {
                     currentLobbyId = status.lobbyId;
                 }
                 
                 // 立即发送 ReadyUp 响应，接受匹配
                 setTimeout(() => {
                     try {
                         const readyPayload = {
                             state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                             hardware_specs: getHardwareSpecs()
                         };
                         if (currentLobbyId) {
                             readyPayload.ready_up_key = currentLobbyId;
                         }
                         
                         const readyMessage = CMsgReadyUp.create(readyPayload);
                         const readyBuffer = CMsgReadyUp.encode(readyMessage).finish();
                         
                         client.sendToGC(570, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, readyBuffer);
                         console.log(`[${account.username}] ✅ 自动接受匹配 - 发送 ReadyUp (READY)${currentLobbyId ? ' + Key' : ''} + HardwareSpecs`);
                     } catch (err) {
                         console.error(`[${account.username}] ❌ 自动接受匹配失败: ${err.message}`);
                     }
                 }, 200);
             } catch (e) {
                 console.error(`[${account.username}] ⚠️ 解析 ReadyUpStatus 失败: ${e.message}`);
                 // 降级：尝试盲发
                 const readyPayload = { 
                     state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                     hardware_specs: getHardwareSpecs()
                 };
                 if (currentLobbyId) readyPayload.ready_up_key = currentLobbyId;
                 const readyMessage = CMsgReadyUp.create(readyPayload);
                 const readyBuffer = CMsgReadyUp.encode(readyMessage).finish();
                 client.sendToGC(570, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, readyBuffer);
             }
        }
    });
});

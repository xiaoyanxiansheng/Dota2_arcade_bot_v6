const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

console.log("=".repeat(60));
console.log("   🏠 公开房间创建工具");
console.log("   用途: 让大号创建一个无密码的公开房间");
console.log("=".repeat(60) + "\n");

// 项目根目录
const projectRoot = path.join(__dirname, '..');

// [新增] 读取代理列表
let proxies = [];
try {
    const proxiesPath = path.join(projectRoot, 'data', 'proxies.txt');
    if (fs.existsSync(proxiesPath)) {
        const content = fs.readFileSync(proxiesPath, 'utf8');
        proxies = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        if (proxies.length > 0) {
            console.log(`✅ 加载了 ${proxies.length} 个代理 IP\n`);
        }
    }
} catch (e) {
    console.error("⚠️ 读取代理文件失败: " + e.message);
}

// 消息 ID 定义
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgGCPracticeLobbyCreate = 7038;
const k_EMsgGCPracticeLobbyLeave = 7040;
const k_EMsgGCReadyUp = 7070;
const k_EMsgProtoMask = 0x80000000;

// SOCache 消息 ID
const k_EMsgGCSOCacheSubscribed = 24;
const k_EMsgGCSOSingleObject = 25;
const k_EMsgGCSOMultipleObjects = 26;
const SOCACHE_TYPE_LOBBY = 2004;

const DOTALobbyReadyState = {
    DOTALobbyReadyState_UNDECLARED: 0,
    DOTALobbyReadyState_NOT_READY: 1,
    DOTALobbyReadyState_READY: 2
};

// 自然的房间名称列表（随机选择）
const NATURAL_ROOM_NAMES = [
    "来玩啊",
    "开黑",
    "休闲局",
    "新手友好",
    "轻松玩",
    "随便玩玩",
    "等人中",
    "快乐游戏",
    "一起玩",
    "欢迎加入",
    "开心局",
    "练习",
    "娱乐",
    "组队",
    "来一局",
    "萌新局",
    "大家来玩",
    "有人吗",
    "进来玩",
    "休闲"
];

// 全局 Proto 定义
let CMsgClientHello, CMsgPracticeLobbyCreate, CMsgPracticeLobbySetDetails, CMsgReadyUp, CSODOTALobby;
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
    CMsgPracticeLobbyCreate = root.lookupType("CMsgPracticeLobbyCreate");
    CMsgPracticeLobbySetDetails = root.lookupType("CMsgPracticeLobbySetDetails");
    CMsgReadyUp = root.lookupType("CMsgReadyUp");
    CSODOTALobby = root.lookupType("CSODOTALobby");
    CMsgSOSingleObject = root.lookupType("CMsgSOSingleObject");
    CMsgSOMultipleObjects = root.lookupType("CMsgSOMultipleObjects");
    CMsgSOCacheSubscribed = root.lookupType("CMsgSOCacheSubscribed");
    
    console.log("✅ Proto 文件加载成功\n");
} catch (e) {
    console.error("❌ Proto 加载失败: " + e.message);
    process.exit(1);
}

function getHardwareSpecs() {
    // 随机化硬件配置，避免检测
    const cpuOptions = [4, 6, 8, 12, 16];
    const memOptions = [8, 16, 32];
    return {
        logical_processors: cpuOptions[Math.floor(Math.random() * cpuOptions.length)],
        cpu_cycles_per_second: Long.fromNumber(2500000000 + Math.random() * 2000000000),
        total_physical_memory: Long.fromNumber(memOptions[Math.floor(Math.random() * memOptions.length)] * 1073741824),
        is_64_bit_os: true,
        upload_measurement: Long.fromNumber(5000000 + Math.random() * 10000000),
        prefer_not_host: false
    };
}

// 读取配置
let config;
try {
    const configPath = path.join(projectRoot, 'config', 'config.json');
    const rawContent = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(rawContent);
} catch (e) {
    console.error("❌ 读取配置失败: " + e.message);
    process.exit(1);
}

if (!config.fleets || config.fleets.length === 0) {
    console.error("❌ 未找到车队配置");
    process.exit(1);
}

// 获取主号列表
let leaders = [];
if (Array.isArray(config.fleets[0].leader)) {
    leaders = config.fleets[0].leader;
} else {
    config.fleets.forEach((fleet) => {
        leaders.push(fleet.leader);
    });
}

console.log(`📋 可用的大号列表:\n`);
leaders.forEach((leader, idx) => {
    console.log(`   [${idx + 1}] ${leader.username}`);
});

// 从命令行参数获取要使用的大号编号 (默认第一个)
const args = process.argv.slice(2);
let leaderIndex = 0;

if (args.length > 0) {
    const userInput = parseInt(args[0]);
    if (isNaN(userInput) || userInput < 1 || userInput > leaders.length) {
        console.error(`\n❌ 无效的大号编号: ${args[0]}`);
        console.log(`💡 用法: node create_public_lobby.js [大号编号]`);
        console.log(`   例如: node create_public_lobby.js 1   (使用第一个大号)`);
        console.log(`   例如: node create_public_lobby.js 2   (使用第二个大号)\n`);
        process.exit(1);
    }
    leaderIndex = userInput - 1;
}

const leader = leaders[leaderIndex];
const globalSettings = config.global_settings;

// 房间名称为空（避免机械化描述）
const roomName = "";

console.log(`\n${"=".repeat(60)}`);
console.log(`🎯 使用大号: ${leader.username}`);
console.log(`🏠 房间名称: (空)`);
console.log(`🔓 房间类型: 公开 (无密码)`);
console.log(`${"=".repeat(60)}\n`);

// 创建 Steam 客户端
const sharedDataPath = globalSettings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

const steamOptions = {
    dataDirectory: steamDataDir
};

// [关键] 主号使用固定代理：主号1用代理1，主号2用代理2，依此类推（与 index.js 保持一致）
if (proxies.length > 0) {
    steamOptions.httpProxy = proxies[leaderIndex];
    const proxyDisplay = proxies[leaderIndex].replace(/:[^:@]+@/, ':****@');
    console.log(`🛡️ 使用固定代理 (代理 #${leaderIndex + 1}): ${proxyDisplay}\n`);
} else {
    console.log(`ℹ️ 未配置代理，使用本地 IP\n`);
}

const client = new SteamUser(steamOptions);

// 状态变量
let is_gc_connected = false;
let currentLobbyId = null;
let ready_up_heartbeat = null;

// CRC 数据
const knownCrc = "1396649696593898392";
const knownTimestamp = 1763646905;

function log(msg) {
    console.log(`[${leader.username}] ${msg}`);
}

function sendHello() {
    try {
        const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
        const message = CMsgClientHello.create(payload);
        const buffer = CMsgClientHello.encode(message).finish();
        client.sendToGC(globalSettings.target_app_id, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
    } catch (err) {}
}

function createPublicLobby() {
    log(`🏠 正在创建公开房间...`);
    log(`   自定义游戏ID: ${globalSettings.custom_game_id}`);
    log(`   服务器区域: ${globalSettings.server_region}`);
    
    try {
        const gameIdLong = Long.fromString(globalSettings.custom_game_id, true);
        
        // 关键：公开房间配置
        const detailsPayload = {
            customGameId: gameIdLong,
            gameName: roomName,                    // 空名称
            serverRegion: globalSettings.server_region,
            gameMode: 15,
            customMaxPlayers: globalSettings.max_players_per_room || 24,
            customMinPlayers: 1,
            allowSpectating: true,
            allchat: true,
            fillWithBots: false,
            allowCheats: false,
            visibility: 0,                         // 公开可见
            passKey: "",                           // ✅ 无密码！
            customMapName: "zudui_team_map",
            customGameCrc: Long.fromString(knownCrc, true),
            customGameTimestamp: knownTimestamp
        };
        
        const lobbyDetails = CMsgPracticeLobbySetDetails.create(detailsPayload);

        const createPayload = {
            searchKey: "",
            passKey: "",                           // ✅ 无密码！
            clientVersion: 0,
            lobbyDetails: lobbyDetails
        };

        const message = CMsgPracticeLobbyCreate.create(createPayload);
        const buffer = CMsgPracticeLobbyCreate.encode(message).finish();
        
        log(`📤 发送创建房间请求 (消息ID: 7038)...`);
        client.sendToGC(globalSettings.target_app_id, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
        log(`✅ 创建房间请求已发送，等待 GC 响应...`);
        
    } catch (err) {
        log(`❌ 创建房间失败: ${err.message}`);
        console.error(err);
    }
}

function sendReadyUp(lobbyId) {
    try {
        const payload = {
            state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
            hardware_specs: getHardwareSpecs()
        };
        if (lobbyId) payload.ready_up_key = lobbyId;
        const message = CMsgReadyUp.create(payload);
        const buffer = CMsgReadyUp.encode(message).finish();
        client.sendToGC(globalSettings.target_app_id, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, buffer);
    } catch (err) {}
}

function processLobbyData(objectData) {
    if (!objectData || objectData.length === 0) {
        log(`⚠️ processLobbyData: 数据为空`);
        return;
    }
    
    log(`🔍 解析 Lobby 数据 (${objectData.length} bytes)...`);
    
    try {
        const lobby = CSODOTALobby.decode(objectData);
        
        log(`   lobbyId: ${lobby.lobbyId ? lobby.lobbyId.toString() : 'null'}`);
        log(`   gameName: "${lobby.gameName || ''}"`);
        log(`   state: ${lobby.state}`);
        log(`   customGameId: ${lobby.customGameId ? lobby.customGameId.toString() : 'null'}`);
        
        if (lobby.lobbyId) {
            currentLobbyId = lobby.lobbyId;
            const gameName = lobby.gameName || '';
            const memberCount = (lobby.allMembers || []).length;
            
            log(`✅ 公开房间创建成功!`);
            log(`   房间名: "${gameName || '(空)'}"`);
            log(`   房间ID: ${currentLobbyId.toString()}`);
            log(`   当前人数: ${memberCount}`);
            console.log(`\n${"=".repeat(60)}`);
            console.log(`🎉 公开房间已创建并保持在线中...`);
            console.log(`   按 Ctrl+C 退出`);
            console.log(`${"=".repeat(60)}\n`);
            
            // 启动心跳
            if (ready_up_heartbeat) clearInterval(ready_up_heartbeat);
            ready_up_heartbeat = setInterval(() => {
                sendReadyUp(currentLobbyId);
                log(`💓 心跳发送`);
            }, 30000);
            
            // 立即发送一次心跳
            sendReadyUp(currentLobbyId);
        }
    } catch (e) {
        log(`❌ 解析 Lobby 数据失败: ${e.message}`);
    }
}

// 常见的 GC 消息 ID 映射（用于调试）
const GC_MSG_NAMES = {
    4004: 'GCClientConnectionStatus',
    7038: 'PracticeLobbyCreate',
    7055: 'PracticeLobbyResponse',
    7040: 'PracticeLobbyLeave',
    7044: 'PracticeLobbyJoin',
    7113: 'PracticeLobbyJoinResponse',
    24: 'SOCacheSubscribed',
    25: 'SOSingleObject',
    26: 'SOMultipleObjects',
    7004: 'LobbySnapshot',
    7070: 'ReadyUp',
    7170: 'ReadyUpStatus'
};

function handleGCMessage(appid, msgType, payload) {
    if (appid !== globalSettings.target_app_id) return;
    const cleanMsgType = msgType & ~k_EMsgProtoMask;
    
    // 打印所有收到的 GC 消息
    const msgName = GC_MSG_NAMES[cleanMsgType] || `Unknown`;
    log(`📩 收到 GC 消息: ${cleanMsgType} (${msgName})`);

    if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
        if (!is_gc_connected) {
            is_gc_connected = true;
            log('✅ 已连接到 Dota 2 GC');
            
            // 延迟创建房间
            setTimeout(() => {
                createPublicLobby();
            }, 2000);
        }
    }
    // 监听 7055 - 房间创建响应
    else if (cleanMsgType === 7055) {
        log(`📬 收到房间创建响应 (7055)`);
        // 解析响应查看结果
        try {
            // 简单打印 payload 长度
            log(`   响应数据长度: ${payload.length} bytes`);
        } catch (e) {}
    }
    // 监听 7004 - Lobby Snapshot
    else if (cleanMsgType === 7004) {
        log(`📬 收到 Lobby Snapshot (7004)`);
        try {
            const lobby = CSODOTALobby.decode(payload);
            if (lobby.lobbyId) {
                log(`   Lobby ID: ${lobby.lobbyId.toString()}`);
                log(`   房间名: "${lobby.gameName || ''}"`);
                processLobbyData(payload);
            }
        } catch (e) {
            log(`   解析失败: ${e.message}`);
        }
    }
    else if (cleanMsgType === k_EMsgGCSOCacheSubscribed) {
        log(`📬 收到 SOCacheSubscribed (24)`);
        try {
            const msg = CMsgSOCacheSubscribed.decode(payload);
            const objects = msg.objects || [];
            log(`   包含 ${objects.length} 个对象`);
            objects.forEach((typeObj) => {
                log(`   - TypeID: ${typeObj.typeId}, 数据数量: ${(typeObj.objectData || []).length}`);
                if (typeObj.typeId === SOCACHE_TYPE_LOBBY) {
                    log(`   🎯 发现 Lobby 数据!`);
                    (typeObj.objectData || []).forEach((data) => {
                        processLobbyData(data);
                    });
                }
            });
        } catch (e) {
            log(`   解析失败: ${e.message}`);
        }
    }
    else if (cleanMsgType === k_EMsgGCSOSingleObject) {
        try {
            const msg = CMsgSOSingleObject.decode(payload);
            log(`📬 收到 SOSingleObject (25), TypeID: ${msg.typeId}`);
            if (msg.typeId === SOCACHE_TYPE_LOBBY) {
                log(`   🎯 发现 Lobby 数据!`);
                processLobbyData(msg.objectData);
            }
        } catch (e) {}
    }
    else if (cleanMsgType === k_EMsgGCSOMultipleObjects) {
        try {
            const msg = CMsgSOMultipleObjects.decode(payload);
            const modified = msg.objectsModified || [];
            const added = msg.objectsAdded || [];
            log(`📬 收到 SOMultipleObjects (26), Modified: ${modified.length}, Added: ${added.length}`);
            
            [...modified, ...added].forEach((obj) => {
                if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                    log(`   🎯 发现 Lobby 数据!`);
                    processLobbyData(obj.objectData);
                }
            });
        } catch (e) {}
    }
}

// 登录
log('正在登录 Steam...');

const logOnOptions = {
    accountName: leader.username,
    password: leader.password,
    promptSteamGuardCode: false,
    rememberPassword: true,
    logonID: Math.floor(Math.random() * 1000000),
    shouldRememberPassword: true
};

if (leader.shared_secret && leader.shared_secret.length > 5) {
    try { 
        logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(leader.shared_secret); 
    } catch (err) {}
}

client.logOn(logOnOptions);

client.on('loggedOn', () => {
    log('✅ Steam 登录成功');
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed([globalSettings.target_app_id]);
});

client.on('appLaunched', (appid) => {
    if (appid === globalSettings.target_app_id) {
        log('🎮 Dota 2 启动');
        setTimeout(() => {
            log('正在连接 GC...');
            sendHello();
            const helloInterval = setInterval(() => { 
                if(!is_gc_connected) sendHello(); 
                else clearInterval(helloInterval);
            }, 5000);
        }, 2000);
    }
});

client.on('error', (err) => {
    log(`❌ Steam 错误: ${err.message}`);
});

client.on('receivedFromGC', (appid, msgType, payload) => {
    handleGCMessage(appid, msgType, payload);
});

// 退出处理
process.on('SIGINT', () => {
    console.log("\n\n🛑 正在退出...");
    
    if (ready_up_heartbeat) {
        clearInterval(ready_up_heartbeat);
    }
    
    // 发送离开房间命令
    try {
        client.sendToGC(globalSettings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
    } catch (e) {}
    
    setTimeout(() => {
        try {
            client.logOff();
        } catch (e) {}
        console.log("✅ 已退出\n");
        process.exit(0);
    }, 2000);
});


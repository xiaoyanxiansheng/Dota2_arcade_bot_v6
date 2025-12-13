/**
 * 挂机主号测试工具
 * 
 * 功能：测试账号是否可以作为挂机房主号
 * - 登录 Steam（支持手动输入验证码）
 * - 连接 GC
 * - 创建一个房间
 * - 等待用户发送 "leave" 或 "exit" 命令退出
 * 
 * 用法：
 * node commands/test_leader.js <username> <password> [proxy] [shared_secret] [gameId]
 */

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');
const readline = require('readline');

console.log("═══════════════════════════════════════════════════════════════");
console.log("║ 挂机主号测试工具 - 验证账号是否可作为房主号");
console.log("═══════════════════════════════════════════════════════════════\n");

// 项目根目录
const projectRoot = path.join(__dirname, '..');

// GC 消息 ID
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgGCAbandonCurrentGame = 7035;
const k_EMsgGCPracticeLobbyCreate = 7038;
const k_EMsgGCPracticeLobbyLeave = 7040;
const k_EMsgProtoMask = 0x80000000;
const k_EMsgGCSOCacheSubscribed = 24;
const k_EMsgGCSOSingleObject = 25;
const k_EMsgGCSOMultipleObjects = 26;
const SOCACHE_TYPE_LOBBY = 2004;

// Proto 定义
let CMsgClientHello, CMsgPracticeLobbyCreate, CMsgPracticeLobbySetDetails, CSODOTALobby;
let CMsgSOSingleObject, CMsgSOMultipleObjects, CMsgSOCacheSubscribed;

try {
    const root = new protobuf.Root();
    root.resolvePath = function(origin, target) {
        if (fs.existsSync(target)) return target;
        const p = path.join(projectRoot, "Protobufs", target);
        if (fs.existsSync(p)) return p;
        const p2 = path.join(projectRoot, "Protobufs", "dota2", target);
        if (fs.existsSync(p2)) return p2;
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
    CSODOTALobby = root.lookupType("CSODOTALobby");
    CMsgSOSingleObject = root.lookupType("CMsgSOSingleObject");
    CMsgSOMultipleObjects = root.lookupType("CMsgSOMultipleObjects");
    CMsgSOCacheSubscribed = root.lookupType("CMsgSOCacheSubscribed");

    console.log("✅ Proto 加载成功\n");
} catch (e) {
    console.error("❌ Proto 加载失败: " + e.message);
    process.exit(1);
}

// 解析参数
const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("用法: node test_leader.js <username> <password> [proxy] [shared_secret]");
    console.log("示例: node test_leader.js myaccount mypassword http://user:pass@ip:port");
    process.exit(1);
}

const username = args[0];
const password = args[1];
const proxy = args[2] && args[2] !== '' ? args[2] : null;  // 空字符串视为无代理
const sharedSecret = args[3] && args[3] !== '' ? args[3] : null;  // 空字符串视为无 secret
const customGameIdArg = args[4] || null;  // 从命令行传入的游戏ID

console.log(`📋 测试账号: ${username}`);
if (proxy) console.log(`📋 使用代理: ${proxy.replace(/:[^:@]+@/, ':***@')}`);
if (sharedSecret) console.log(`📋 已配置 shared_secret (自动2FA)`);
console.log("");

// 加载游戏配置（从 config_leaders.json 获取 custom_game_id 等）
let gameConfig = {
    target_app_id: 570,
    custom_game_id: "3586896069",
    lobby_password: "test123",
    server_regions: [1, 2, 5, 7, 14, 19]
};

try {
    const leadersConfigPath = path.join(projectRoot, 'config', 'config_leaders.json');
    if (fs.existsSync(leadersConfigPath)) {
        const config = JSON.parse(fs.readFileSync(leadersConfigPath, 'utf8').replace(/^\uFEFF/, ''));
        if (config.global_settings) {
            gameConfig = { ...gameConfig, ...config.global_settings };
        }
    }
} catch (e) {
    console.log("⚠️ 无法加载 config_leaders.json，使用默认配置");
}

// 如果命令行传入了游戏ID，覆盖配置
if (customGameIdArg) {
    gameConfig.custom_game_id = customGameIdArg;
    console.log(`📋 使用命令行指定的游戏ID: ${customGameIdArg}`);
}

// 共享数据目录
const sharedDataPath = gameConfig.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);
if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}

// 状态
let is_gc_connected = false;
let currentLobbyId = null;
let state = 'INIT'; // INIT -> LOGGING_IN -> ONLINE -> CREATING -> IN_LOBBY

// CRC 数据（从现有配置获取）
const knownCrc = "1396649696593898392";
const knownTimestamp = 1763646905;

// 创建 Steam 客户端
const steamOptions = { dataDirectory: steamDataDir };
if (proxy) {
    steamOptions.httpProxy = proxy;
}
const client = new SteamUser(steamOptions);

// readline 用于读取验证码
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// 监听 stdin 命令
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
    const cmd = data.toString().trim().toLowerCase();
    
    if (cmd === 'leave' || cmd === 'exit' || cmd === 'quit') {
        console.log("\n🚪 收到退出命令，正在退出房间...");
        leaveAndExit();
    }
});

// Steam 事件
client.on('loggedOn', () => {
    console.log(`✅ Steam 登录成功!`);
    console.log(`   SteamID: ${client.steamID.getSteamID64()}`);
    state = 'ONLINE';
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed([gameConfig.target_app_id]);
});

client.on('appLaunched', (appid) => {
    if (appid === gameConfig.target_app_id) {
        console.log("🎮 Dota 2 已启动");
        setTimeout(connectGC, 2000);
    }
});

client.on('error', (err) => {
    console.error(`❌ Steam 错误: ${err.message}`);
    process.exit(1);
});

// Steam Guard 验证码
client.on('steamGuard', (domain, callback) => {
    console.log(`[STEAM_GUARD]${domain || 'Email'}`);
    console.log(`🔐 需要 Steam Guard 验证码 (${domain || 'Email'})`);
    console.log("请在 Web 界面输入验证码...\n");
    
    rl.question('', (code) => {
        console.log(`📝 收到验证码: ${code.trim()}`);
        callback(code.trim());
    });
});

// GC 消息处理
client.on('receivedFromGC', (appid, msgType, payload) => {
    if (appid !== gameConfig.target_app_id) return;
    const cleanMsgType = msgType & ~k_EMsgProtoMask;

    if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
        if (!is_gc_connected) {
            is_gc_connected = true;
            console.log("✅ GC 连接成功!");
            
            // 清理残留
            client.sendToGC(gameConfig.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
            
            // 创建房间
            setTimeout(createRoom, 2000);
        }
    }
    else if (cleanMsgType === k_EMsgGCSOCacheSubscribed) {
        try {
            const msg = CMsgSOCacheSubscribed.decode(payload);
            (msg.objects || []).forEach((typeObj) => {
                if (typeObj.typeId === SOCACHE_TYPE_LOBBY) {
                    (typeObj.objectData || []).forEach((data) => {
                        processLobbyData(data);
                    });
                }
            });
        } catch (e) {}
    }
    else if (cleanMsgType === k_EMsgGCSOSingleObject) {
        try {
            const msg = CMsgSOSingleObject.decode(payload);
            if (msg.typeId === SOCACHE_TYPE_LOBBY) {
                processLobbyData(msg.objectData);
            }
        } catch (e) {}
    }
    else if (cleanMsgType === k_EMsgGCSOMultipleObjects) {
        try {
            const msg = CMsgSOMultipleObjects.decode(payload);
            [...(msg.objectsModified || []), ...(msg.objectsAdded || [])].forEach((obj) => {
                if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                    processLobbyData(obj.objectData);
                }
            });
        } catch (e) {}
    }
});

function connectGC() {
    console.log("📡 连接 GC...");
    sendHello();
    
    const helloInterval = setInterval(() => {
        if (!is_gc_connected) sendHello();
        else clearInterval(helloInterval);
    }, 5000);
}

function sendHello() {
    try {
        const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
        const message = CMsgClientHello.create(payload);
        const buffer = CMsgClientHello.encode(message).finish();
        client.sendToGC(gameConfig.target_app_id, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
    } catch (err) {}
}

function createRoom() {
    if (state === 'IN_LOBBY') {
        console.log("⚠️ 已在房间中");
        return;
    }
    
    state = 'CREATING';
    console.log("\n🏠 正在创建测试房间...");
    
    try {
        const gameIdLong = Long.fromString(gameConfig.custom_game_id, true);
        const regions = gameConfig.server_regions || [14];
        const selectedRegion = regions[Math.floor(Math.random() * regions.length)];
        
        const detailsPayload = {
            customGameId: gameIdLong,
            gameName: "",
            serverRegion: selectedRegion,
            gameMode: 15,
            customMaxPlayers: 23,
            customMinPlayers: 1,
            allowSpectating: true,
            allchat: true,
            fillWithBots: false,
            allowCheats: false,
            visibility: 0,
            passKey: gameConfig.lobby_password || "test123",
            customMapName: "zudui_team_map",
            customGameCrc: Long.fromString(knownCrc, true),
            customGameTimestamp: knownTimestamp
        };
        const lobbyDetails = CMsgPracticeLobbySetDetails.create(detailsPayload);

        const createPayload = {
            searchKey: "",
            passKey: gameConfig.lobby_password || "test123",
            clientVersion: 0,
            lobbyDetails: lobbyDetails
        };

        const message = CMsgPracticeLobbyCreate.create(createPayload);
        const buffer = CMsgPracticeLobbyCreate.encode(message).finish();
        
        client.sendToGC(gameConfig.target_app_id, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
        
        console.log(`   游戏ID: ${gameConfig.custom_game_id}`);
        console.log(`   区域: ${selectedRegion}`);
        console.log(`   密码: ${gameConfig.lobby_password || "test123"}`);
        
        // 创建超时检测
        setTimeout(() => {
            if (state === 'CREATING') {
                console.log("❌ 创建房间超时 (30秒)");
                console.log("💡 可能原因：游戏ID无效、账号被限制、网络问题");
                leaveAndExit(1);
            }
        }, 30000);
        
    } catch (err) {
        console.error(`❌ 创建房间失败: ${err.message}`);
        leaveAndExit(1);
    }
}

function processLobbyData(objectData) {
    if (!objectData || objectData.length === 0) return;
    
    try {
        const lobby = CSODOTALobby.decode(objectData);
        const lobbyId = lobby.lobbyId;
        const memberCount = (lobby.allMembers || []).length;
        
        if (lobbyId && state === 'CREATING') {
            currentLobbyId = lobbyId;
            state = 'IN_LOBBY';
            
            console.log("✅ 房间创建成功!");
            console.log(`   房间ID: ${lobbyId.toString()}`);
            console.log("\n💡 输入 'leave' 或 'exit' 退出房间并结束测试");
            console.log("   或者在 Web 界面点击「退出房间」按钮\n");
            
            // 输出特殊信号，通知前端触发查询房间
            console.log(`[ROOM_CREATED]${lobbyId.toString()}`);
        }
    } catch (e) {}
}

function leaveAndExit(code = 0) {
    console.log("🧹 清理中...");
    
    try {
        if (currentLobbyId) {
            client.sendToGC(gameConfig.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
            console.log("✅ 已退出房间");
        }
        client.sendToGC(gameConfig.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
    } catch (err) {}
    
    setTimeout(() => {
        try {
            client.logOff();
        } catch (err) {}
        
        console.log("👋 测试结束");
        process.exit(code);
    }, 2000);
}

// 开始登录
console.log("🔐 正在登录 Steam...\n");
state = 'LOGGING_IN';

const logOnOptions = {
    accountName: username,
    password: password,
    rememberPassword: true,
    logonID: Math.floor(Math.random() * 1000000)
};

// 如果有 shared_secret，自动生成 2FA
if (sharedSecret) {
    try {
        logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);
        console.log("🔐 已自动生成 2FA 验证码\n");
    } catch (e) {
        console.error(`❌ 生成 2FA 失败: ${e.message}`);
        console.log("💡 将等待手动输入验证码\n");
    }
}

client.logOn(logOnOptions);

// 异常处理
process.on('uncaughtException', (err) => {
    console.error(`❌ 未捕获异常: ${err.message}`);
    leaveAndExit(1);
});

process.on('SIGINT', () => {
    console.log("\n⚠️ 收到中断信号");
    leaveAndExit(0);
});


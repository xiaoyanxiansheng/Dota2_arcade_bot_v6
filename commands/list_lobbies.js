const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

// 1. 路径配置
const projectRoot = path.join(__dirname, '..');
const configPath = path.join(projectRoot, 'config', 'config.json');

// 2. 读取配置
let config;
try {
    if (fs.existsSync(configPath)) {
        const rawContent = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
        config = JSON.parse(rawContent);
    } else {
        console.error("❌ 找不到配置文件: config/config.json");
        process.exit(1);
    }
} catch (e) {
    console.error("❌ 读取配置失败: " + e.message);
    process.exit(1);
}

// 获取账号
let account;
if (config.fleets[0].followers && config.fleets[0].followers.length > 0) {
    account = config.fleets[0].followers[0];
    console.log("[System] 选择 Follower 账号进行查询 (避免主号令牌验证)");
} else {
    account = config.fleets[0].leader;
    if (Array.isArray(account)) {
        account = account[0];
    }
    console.log("[System] 选择 Leader 账号进行查询");
}

// 解析命令行参数
// 用法: node list_lobbies.js [game_id|all]
// - 不传参数或传 "all": 查询所有游戏
// - 传具体 game_id: 只查询该游戏
const arg = process.argv[2];
let targetGameId = null;
let queryAll = false;

if (!arg || arg.toLowerCase() === 'all') {
    queryAll = true;
    console.log("[System] 模式: 查询所有游廊游戏房间");
} else {
    targetGameId = arg.toString().trim();
    console.log(`[System] 模式: 查询指定游戏 ID: ${targetGameId}`);
}

console.log(`[System] 使用账号: ${account.username} 进行查询...`);

// 3. 消息 ID 定义
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgGCJoinableCustomLobbiesRequest = 7468;
const k_EMsgGCJoinableCustomLobbiesResponse = 7469;
const k_EMsgProtoMask = 0x80000000;

// 4. 加载 Proto
let CMsgClientHello, CMsgJoinableCustomLobbiesRequest, CMsgJoinableCustomLobbiesResponse;

try {
    const root = new protobuf.Root();
    root.resolvePath = function(origin, target) {
        let checkPath = path.join(projectRoot, "Protobufs", target);
        if (fs.existsSync(checkPath)) return checkPath;
        checkPath = path.join(projectRoot, "Protobufs", "dota2", target);
        if (fs.existsSync(checkPath)) return checkPath;
        checkPath = path.join(projectRoot, "Protobufs", "google", "protobuf", target);
        if (fs.existsSync(checkPath)) return checkPath;
        return target;
    };

    root.loadSync(path.join(projectRoot, "Protobufs/google/protobuf/descriptor.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/networkbasetypes.proto")); 
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/gcsdk_gcmessages.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_gcmessages_client_match_management.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_gcmessages_client.proto"));

    CMsgClientHello = root.lookupType("CMsgClientHello");
    CMsgJoinableCustomLobbiesRequest = root.lookupType("CMsgJoinableCustomLobbiesRequest");
    CMsgJoinableCustomLobbiesResponse = root.lookupType("CMsgJoinableCustomLobbiesResponse");

} catch (e) {
    console.error("❌ Proto 加载失败: " + e.message);
    process.exit(1);
}

// 5. 初始化 Steam Client
const sharedDataPath = config.global_settings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}

const client = new SteamUser({
    dataDirectory: steamDataDir
});

// 6. 事件监听
client.on('loggedOn', () => {
    console.log('✅ Steam 登录成功');
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed([570]);
});

client.on('appLaunched', (appid) => {
    if (appid === 570) {
        console.log('🎮 Dota 2 已启动，正在连接 GC...');
        setTimeout(connectGC, 2000);
    }
});

client.on('error', (err) => {
    console.error('❌ Steam 错误:', err.message);
    process.exit(1);
});

let is_gc_connected = false;

// Region ID 映射
const RegionMap = {
    0: "Auto", 1: "US West", 2: "US East", 3: "Europe", 5: "Singapore", 
    6: "Dubai", 7: "Australia", 8: "Stockholm", 9: "Austria", 
    10: "Brazil", 11: "South Africa", 12: "PW Telecom", 13: "PW Unicom", 
    14: "Chile", 15: "Peru", 16: "India", 17: "Reg:17", 18: "Reg:18", 
    19: "Japan", 20: "Reg:20", 25: "PW Tianjin"
};

client.on('receivedFromGC', (appid, msgType, payload) => {
    if (appid !== 570) return;
    const cleanMsgType = msgType & ~k_EMsgProtoMask;

    if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
        if (!is_gc_connected) {
            is_gc_connected = true;
            console.log('✅ GC 连接成功！');
            requestLobbies();
        }
    } 
    else if (cleanMsgType === k_EMsgGCJoinableCustomLobbiesResponse) {
        console.log('\n📡 收到房间列表响应...');
        try {
            const response = CMsgJoinableCustomLobbiesResponse.decode(payload);
            const lobbies = response.lobbies || [];
            
            if (lobbies.length === 0) {
                console.log(`📭 当前没有公开房间。`);
                console.log("\n✅ 查询完成，3秒后退出...");
                setTimeout(() => process.exit(0), 3000);
                return;
            }
            
            // 收集所有唯一的游戏 ID
            const allGameIds = lobbies.map(l => l.customGameId ? l.customGameId.toString() : null).filter(Boolean);
            
            // 统计信息
            const totalPlayers = lobbies.reduce((sum, l) => sum + (l.memberCount || 0), 0);
            const fullRooms = lobbies.filter(l => (l.memberCount || 0) >= 20).length;
            const uniqueGames = new Set(allGameIds).size;
            
            const modeStr = queryAll ? "所有游廊游戏" : `游戏 ID: ${targetGameId}`;
            const header = `查询: ${modeStr} | 房间: ${lobbies.length} | 游戏: ${uniqueGames} | 玩家: ${totalPlayers} | 高人气(>=20): ${fullRooms}\n` +
                         "=".repeat(175) + "\n" +
                         `| ${"Lobby ID".padEnd(18)} | ${"Game ID".padEnd(15)} | ${"Room Name".padEnd(25)} | ${"Map".padEnd(12)} | ${"Region".padEnd(12)} | ${"Memb".padEnd(4)} | ${"Time".padEnd(8)} | ${"Leader (Name/ID)".padEnd(35)} | ${"Pass".padEnd(4)} |\n` +
                         "-".repeat(175);
            
            console.log('\n' + header);
            
            lobbies.forEach(lobby => {
                const lobbyId = lobby.lobbyId ? lobby.lobbyId.toString() : "Unknown";
                
                // 游戏 ID（直接显示，不带前缀）
                const gameId = lobby.customGameId ? lobby.customGameId.toString() : "Unknown";

                // 房间名
                let name = lobby.lobbyName || "Unknown";
                name = name.replace(/[\r\n]/g, '');
                const displayName = name.length > 23 ? name.substring(0, 20) + "..." : name;

                // 地图名
                let mapName = lobby.customMapName || "-";
                if (mapName.length > 11) mapName = mapName.substring(0, 9) + "...";
                
                // 地区
                const regionId = lobby.serverRegion || 0;
                const regionName = RegionMap[regionId] || `Reg:${regionId}`;

                const count = lobby.memberCount || 0;
                
                // 创建时间
                let timeStr = "-";
                if (lobby.lobbyCreationTime) {
                    const now = Math.floor(Date.now() / 1000);
                    const diff = now - lobby.lobbyCreationTime;
                    if (diff < 60) timeStr = `${diff}s`;
                    else if (diff < 3600) timeStr = `${Math.floor(diff / 60)}m`;
                    else timeStr = `${Math.floor(diff / 3600)}h${Math.floor((diff % 3600) / 60)}m`;
                }

                // Leader (Name + ID)
                const leaderId = lobby.leaderAccountId ? lobby.leaderAccountId.toString() : "Unknown";
                let leaderName = lobby.leaderName || "";
                if (leaderName.length > 15) leaderName = leaderName.substring(0, 12) + "...";
                
                let leaderStr = leaderName ? `${leaderName} (${leaderId})` : leaderId;
                if (leaderStr.length > 33) leaderStr = leaderStr.substring(0, 30) + "...";
                
                const hasPass = lobby.hasPassKey ? "Yes" : "No";
                
                const line = `| ${lobbyId.padEnd(18)} | ${gameId.padEnd(15)} | ${displayName.padEnd(25)} | ${mapName.padEnd(12)} | ${regionName.padEnd(12)} | ${count.toString().padEnd(4)} | ${timeStr.padEnd(8)} | ${leaderStr.padEnd(35)} | ${hasPass.padEnd(4)} |`;
                console.log(line);
            });
            console.log("=".repeat(175));
            
            // 保存为 CSV 文件
            const dataDir = path.join(projectRoot, 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            
            // 生成时间戳文件名
            const now = new Date();
            const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
            const csvFile = path.join(dataDir, `lobbies_${timestamp}.csv`);
            
            // 生成 CSV 内容
            const csvHeader = 'Lobby ID,Game ID,Room Name,Map,Region,Members,Time,Leader Name,Leader ID,Has Password\n';
            let csvContent = csvHeader;
            
            lobbies.forEach(lobby => {
                const lobbyId = lobby.lobbyId ? lobby.lobbyId.toString() : "";
                const gameId = lobby.customGameId ? lobby.customGameId.toString() : "";
                const roomName = (lobby.lobbyName || "").replace(/[\r\n,]/g, ' ');
                const mapName = lobby.customMapName || "";
                const regionId = lobby.serverRegion || 0;
                const regionName = RegionMap[regionId] || `Reg:${regionId}`;
                const members = lobby.memberCount || 0;
                
                let timeStr = "";
                if (lobby.lobbyCreationTime) {
                    const nowSec = Math.floor(Date.now() / 1000);
                    const diff = nowSec - lobby.lobbyCreationTime;
                    if (diff < 60) timeStr = `${diff}s`;
                    else if (diff < 3600) timeStr = `${Math.floor(diff / 60)}m`;
                    else timeStr = `${Math.floor(diff / 3600)}h${Math.floor((diff % 3600) / 60)}m`;
                }
                
                const leaderName = (lobby.leaderName || "").replace(/,/g, ' ');
                const leaderId = lobby.leaderAccountId ? lobby.leaderAccountId.toString() : "";
                const hasPass = lobby.hasPassKey ? "Yes" : "No";
                
                csvContent += `${lobbyId},${gameId},"${roomName}",${mapName},${regionName},${members},${timeStr},"${leaderName}",${leaderId},${hasPass}\n`;
            });
            
            fs.writeFileSync(csvFile, '\ufeff' + csvContent, 'utf8'); // 添加 BOM 以支持 Excel 中文
            console.log(`\n📄 结果已保存到: ${csvFile}`);
            
            console.log("\n✅ 查询完成，3秒后退出...");
            setTimeout(() => process.exit(0), 3000);
            
        } catch (e) {
            console.error("❌ 解析响应失败:", e);
        }
    }
});

// 7. 功能函数
function connectGC() {
    const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
    const message = CMsgClientHello.create(payload);
    const buffer = CMsgClientHello.encode(message).finish();
    client.sendToGC(570, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
    
    const helloInterval = setInterval(() => {
        if (!is_gc_connected) {
            client.sendToGC(570, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
        } else {
            clearInterval(helloInterval);
        }
    }, 5000);
}

function requestLobbies() {
    let payload = { server_region: 0 };
    
    if (queryAll) {
        console.log(`🔍 正在查询所有游廊游戏的房间列表...`);
    } else {
        const gameIdLong = Long.fromString(targetGameId, true);
        payload.custom_game_id = gameIdLong;
        console.log(`🔍 正在查询游戏 ID ${targetGameId} 的房间列表...`);
    }

    try {
        const message = CMsgJoinableCustomLobbiesRequest.create(payload);
        const buffer = CMsgJoinableCustomLobbiesRequest.encode(message).finish();
        
        client.sendToGC(570, k_EMsgGCJoinableCustomLobbiesRequest | k_EMsgProtoMask, {}, buffer);
        
        setTimeout(() => {
            console.log("⚠️ 查询超时 (30秒未收到响应)");
            process.exit(0);
        }, 30000);
        
    } catch (err) {
        console.error("❌ 发送请求失败:", err);
    }
}

// 8. 启动登录
const logOnOptions = {
    accountName: account.username,
    password: account.password,
    promptSteamGuardCode: false,
    rememberPassword: true
};

if (account.shared_secret) {
    try {
        logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(account.shared_secret);
    } catch (e) {}
}

console.log("🚀 开始登录 Steam...");
client.logOn(logOnOptions);

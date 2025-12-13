const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

// 1. 路径配置
const projectRoot = path.join(__dirname, '..');
const dataDir = path.join(projectRoot, 'data');

// 2. 辅助定义
const RegionNameMap = {
    0: "Auto", 1: "US West", 2: "US East", 3: "Europe", 5: "Singapore", 
    6: "Dubai", 7: "Australia", 8: "Stockholm", 9: "Austria", 
    10: "Brazil", 11: "South Africa", 12: "PW Telecom", 13: "PW Unicom", 
    14: "Chile", 15: "Peru", 16: "India", 17: "China", 18: "China", 
    19: "Japan", 20: "China", 25: "PW Tianjin"
};

function formatDuration(seconds) {
    if (!seconds || seconds < 0) return "0m";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h${m}m`;
    return `${m}m`;
}

// 帮助函数：读取配置
function loadConfig(filename) {
    try {
        const configPath = path.join(projectRoot, 'config', filename);
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
            return JSON.parse(raw);
        }
    } catch (e) {}
    return null;
}

// 帮助函数：加载代理文件 (简单版)
function loadProxiesFromFile(filename) {
    try {
        const p = path.resolve(projectRoot, filename);
        if (fs.existsSync(p)) {
            return fs.readFileSync(p, 'utf8').split('\n')
                .map(l => l.trim()).filter(l => l.length > 0 && l.startsWith('http'));
        }
    } catch (e) {}
    return [];
}

const showcaseConfig = loadConfig('config_showcase.json');
const farmingConfig = loadConfig('config_farming.json');

if (!showcaseConfig && !farmingConfig) {
    console.error("❌ 未找到任何配置文件");
    process.exit(1);
}

// 2. 获取查询账号 (优先使用 query_account)
let account = null;

// 优先使用 config_showcase.json 中的 query_account
if (showcaseConfig && showcaseConfig.query_account) {
    account = showcaseConfig.query_account;
    console.log(`[System] 使用查询专用账号: ${account.username}`);
}

// 如果没有 query_account，使用小号
if (!account && farmingConfig && farmingConfig.fleets) {
    for (const fleet of farmingConfig.fleets) {
        if (fleet.followers && fleet.followers.length > 0) {
            account = fleet.followers[0];
            // 还需要代理信息
            const globalProxies = farmingConfig.proxies_file ? loadProxiesFromFile(farmingConfig.proxies_file) : [];
            const fleetProxies = fleet.proxies || globalProxies;
            if (!account.proxy && fleetProxies.length > 0) {
                account.proxy = fleetProxies[0];
            }
            break;
        }
    }
}

// 如果还是没有账号，用主号
if (!account) {
    if (showcaseConfig && showcaseConfig.showcase_leaders && showcaseConfig.showcase_leaders.length > 0) {
        account = showcaseConfig.showcase_leaders[0];
    } else if (farmingConfig && farmingConfig.fleets && farmingConfig.fleets.length > 0) {
        account = farmingConfig.fleets[0].leader;
    }
}

if (!account) {
    console.error("❌ 未找到可用账号");
    process.exit(1);
}

// 3. 解析参数
const arg = process.argv[2];
let targetGameId = null;
let queryAll = false;

// 如果参数为空，或者是 'all'，则查询所有
if (!arg || arg.trim() === '' || arg.toLowerCase() === 'all') {
    queryAll = true;
    targetGameId = null; // 显式置空
    console.log("[System] 模式: 查询所有游廊游戏房间");
} else {
    targetGameId = arg.toString().trim();
    console.log(`[System] 模式: 查询指定游戏 ID: ${targetGameId}`);
}

// 4. Proto 加载
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgGCJoinableCustomLobbiesRequest = 7468;
const k_EMsgGCJoinableCustomLobbiesResponse = 7469;
const k_EMsgProtoMask = 0x80000000;

let CMsgClientHello, CMsgJoinableCustomLobbiesRequest, CMsgJoinableCustomLobbiesResponse;

try {
    const root = new protobuf.Root();
    root.resolvePath = function(origin, target) {
        if (fs.existsSync(target)) return target;
        const p = path.join(projectRoot, "Protobufs", target);
        if (fs.existsSync(p)) return p;
        const p2 = path.join(projectRoot, "Protobufs", "dota2", target);
        if (fs.existsSync(p2)) return p2;
        const p3 = path.join(projectRoot, "Protobufs", "google", "protobuf", target);
        if (fs.existsSync(p3)) return p3;
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

// 5. Steam Client
const globalSettings = (showcaseConfig || farmingConfig).global_settings || {};
const sharedDataPath = globalSettings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}

const client = new SteamUser({
    dataDirectory: steamDataDir,
    httpProxy: account.proxy
});

let is_gc_connected = false;

client.on('loggedOn', () => {
    console.log("✅ Steam 登录成功");
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed([570]);
});

client.on('appLaunched', (appid) => {
    if (appid === 570) {
        console.log("🎮 Dota 2 启动，连接 GC...");
        setTimeout(sendHello, 1000);
    }
});

client.on('error', (err) => {
    if (err.message === 'LoggedInElsewhere') {
        console.error("❌ 错误: 账号已在别处登录 (请先停止挂机车队或使用其他账号)");
    } else {
        console.error("❌ Steam 错误: " + err.message);
    }
    process.exit(1);
});

client.on('receivedFromGC', (appid, msgType, payload) => {
    if (appid !== 570) return;
    const cleanMsgType = msgType & ~k_EMsgProtoMask;

    if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
        if (!is_gc_connected) {
            is_gc_connected = true;
            console.log("📡 GC 连接成功，正在查询...");
            queryLobbies();
        }
    } else if (cleanMsgType === k_EMsgGCJoinableCustomLobbiesResponse) {
        try {
            const response = CMsgJoinableCustomLobbiesResponse.decode(payload);
            const lobbies = response.lobbies || [];
            
            console.log(`\n📊 查询结果 (总数: ${lobbies.length})`);
            
            // 过滤和收集数据
            let count = 0;
            const csvRows = ["Lobby ID,Game ID,Room Name,Map,Region,Members,Time,Leader Name,Leader ID,Has Password"];
            
            lobbies.forEach(l => {
                const gid = l.customGameId ? l.customGameId.toString() : "Unknown";
                
                // 过滤逻辑
                if (targetGameId && gid !== targetGameId) return;

                count++;
                
                const lid = l.lobbyId ? l.lobbyId.toString() : "Unknown";
                const roomName = (l.lobbyName || "").toString();
                const mapName = (l.customMapName || "").toString();
                const region = (RegionNameMap[l.serverRegion] || l.serverRegion || "").toString();
                const members = (l.memberCount || 0).toString();
                const hasPass = l.hasPassKey ? "Yes" : "";
                const leaderId = l.leaderAccountId ? l.leaderAccountId.toString() : "Unknown";
                const leaderName = (l.leaderName || "Unknown").toString();
                const time = l.lobbyCreationTime ? formatDuration(Date.now()/1000 - l.lobbyCreationTime) : "";

                // 构造 CSV 行
                csvRows.push(`${lid},${gid},${roomName},${mapName},${region},${members},${time},${leaderName},${leaderId},${hasPass}`);
            });
            
            console.log(`✅ 符合条件的房间: ${count}`);

            // 保存 CSV - 格式化文件名为时间格式
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const hour = String(now.getHours()).padStart(2, '0');
            const minute = String(now.getMinutes()).padStart(2, '0');
            const second = String(now.getSeconds()).padStart(2, '0');
            const filename = `lobbies_${year}${month}${day}_${hour}${minute}${second}.csv`;
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            const filepath = path.join(dataDir, filename);
            
            fs.writeFileSync(filepath, csvRows.join('\n'));
            console.log(`\n💾 [FILE_LINK]${filepath}`);
            
            setTimeout(() => {
                client.logOff();
                process.exit(0);
            }, 1000);

        } catch (e) {
            console.error("解析响应失败: " + e.message);
            process.exit(1);
        }
    }
});

function sendHello() {
    const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
    const message = CMsgClientHello.create(payload);
    const buffer = CMsgClientHello.encode(message).finish();
    client.sendToGC(570, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
}

function queryLobbies() {
    const payload = { server_region: 0 };
    if (targetGameId) {
        payload.custom_game_id = Long.fromString(targetGameId, true);
    }
    
    const message = CMsgJoinableCustomLobbiesRequest.create(payload);
    const buffer = CMsgJoinableCustomLobbiesRequest.encode(message).finish();
    client.sendToGC(570, k_EMsgGCJoinableCustomLobbiesRequest | k_EMsgProtoMask, {}, buffer);
}

client.logOn({
    accountName: account.username,
    password: account.password
});

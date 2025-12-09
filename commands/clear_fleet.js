const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

/**
 * 清理指定车队的所有账号 - 退出组队、退出游戏
 * 用法: node clear_fleet.js <type>
 * type: showcase | farming | all
 */

// 获取参数
const fleetType = process.argv[2] || 'all';

console.log(`--- 车队清理工具 ---`);
console.log(`清理目标: ${fleetType === 'all' ? '所有车队' : fleetType + ' 车队'}\n`);

// 消息 ID 定义
const k_EMsgGCAbandonCurrentGame = 7035;
const k_EMsgGCPracticeLobbyLeave = 7040;
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgProtoMask = 0x80000000;

const projectRoot = path.join(__dirname, '..');

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

// 帮助函数：加载代理文件
function loadProxies(filename) {
    try {
        const proxiesPath = path.resolve(projectRoot, filename);
        if (fs.existsSync(proxiesPath)) {
            const content = fs.readFileSync(proxiesPath, 'utf8');
            return content.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(line => {
                    if (line.startsWith('http')) return line;
                    const parts = line.split(':');
                    if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
                    return null;
                }).filter(p => p);
        }
    } catch (e) {}
    return [];
}

const showcaseConfig = loadConfig('config_showcase.json');
const farmingConfig = loadConfig('config_farming.json');

// 共享验证数据目录
const globalSettings = (showcaseConfig || farmingConfig)?.global_settings || {};
const sharedDataPath = globalSettings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}

// 加载全局代理
let globalProxies = [];
if (farmingConfig && farmingConfig.proxies_file) {
    globalProxies = loadProxies(farmingConfig.proxies_file);
}

// 加载 Proto
let CMsgClientHello;
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
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_gcmessages_client.proto"));

    CMsgClientHello = root.lookupType("CMsgClientHello");
} catch (e) {
    console.error("❌ Proto 加载失败: " + e.message);
    process.exit(1);
}

// 收集需要清理的账号
const allAccounts = [];

// Showcase 车队
if ((fleetType === 'showcase' || fleetType === 'all') && showcaseConfig) {
    // Showcase Leaders (配置字段名: showcase_leaders)
    if (showcaseConfig.showcase_leaders) {
        showcaseConfig.showcase_leaders.forEach(acc => {
            allAccounts.push({ ...acc, source: 'showcase-leader' });
        });
    }
    // 兼容旧字段名
    if (showcaseConfig.leaders) {
        showcaseConfig.leaders.forEach(acc => {
            allAccounts.push({ ...acc, source: 'showcase-leader' });
        });
    }
    // Showcase Followers
    if (showcaseConfig.followers) {
        showcaseConfig.followers.forEach(acc => {
            allAccounts.push({ ...acc, source: 'showcase-follower' });
        });
    }
}

// Farming 车队
if ((fleetType === 'farming' || fleetType === 'all') && farmingConfig && farmingConfig.fleets) {
    farmingConfig.fleets.forEach(fleet => {
        const fleetProxies = fleet.proxies || globalProxies;
        
        // Leaders
        if (fleet.leaders) {
            fleet.leaders.forEach(acc => {
                allAccounts.push({ ...acc, source: 'farming-leader' });
            });
        }
        
        // Followers（随机选择代理）
        if (fleet.followers) {
            fleet.followers.forEach((acc) => {
                let proxy = acc.proxy;
                if (!proxy && fleetProxies.length > 0) {
                    proxy = fleetProxies[Math.floor(Math.random() * fleetProxies.length)];
                }
                allAccounts.push({ ...acc, proxy, source: 'farming-follower' });
            });
        }
    });
}

if (allAccounts.length === 0) {
    console.log("⚠️ 没有找到需要清理的账号");
    process.exit(0);
}

console.log(`[System] 准备清理 ${allAccounts.length} 个账号`);

// 并发清理
let processedCount = 0;
let successCount = 0;

async function startCleanup() {
    console.log(`[System] 开始清理 ${allAccounts.length} 个账号...`);
    
    const promises = allAccounts.map((acc, index) => 
        cleanupOne(acc).then(() => {
            processedCount++;
        })
    );
    
    await Promise.all(promises);
    
    console.log(`✅ ${fleetType} 车队清理完成 (处理: ${processedCount}, 成功: ${successCount})`);
    process.exit(0);
}

function cleanupOne(account) {
    return new Promise((resolve) => {
        try {
            const client = new SteamUser({
                dataDirectory: steamDataDir,
                httpProxy: account.proxy,
                autoRelogin: false
            });

            const timeout = setTimeout(() => {
                client.removeAllListeners();
                try { client.logOff(); } catch(e){}
                resolve();
            }, 15000);

            client.on('loggedOn', () => {
                client.setPersona(SteamUser.EPersonaState.Invisible);
                client.gamesPlayed([570]);
            });

            client.on('appLaunched', (appid) => {
                if (appid === 570) {
                    const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
                    const message = CMsgClientHello.create(payload);
                    const buffer = CMsgClientHello.encode(message).finish();
                    client.sendToGC(570, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
                }
            });

            client.on('receivedFromGC', (appid, msgType, payload) => {
                if (appid !== 570) return;
                const cleanMsgType = msgType & ~k_EMsgProtoMask;

                if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
                    // 发送退出组队和退出游戏指令
                    client.sendToGC(570, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                    client.sendToGC(570, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                    
                    successCount++;
                    clearTimeout(timeout);
                    setTimeout(() => {
                        client.logOff();
                        resolve();
                    }, 500);
                }
            });

            client.on('error', () => {
                clearTimeout(timeout);
                resolve();
            });

            // 登录
            const loginOptions = {
                accountName: account.username,
                password: account.password
            };
            
            // 如果有 shared_secret，自动生成 2FA
            if (account.shared_secret) {
                try {
                    loginOptions.twoFactorCode = SteamTotp.generateAuthCode(account.shared_secret);
                } catch (e) {}
            }
            
            client.logOn(loginOptions);

        } catch (e) {
            resolve();
        }
    });
}

startCleanup();


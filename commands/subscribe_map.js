const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

console.log("=".repeat(70));
console.log("  Dota 2 地图批量订阅工具 - 流水线模式");
console.log("=".repeat(70));

const projectRoot = path.join(__dirname, '..');
const LOCAL_PROXY = 'http://127.0.0.1:7890'; // Web订阅备用代理

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

// 1. 加载配置和账号
const showcaseConfig = loadConfig('config_showcase.json');
const farmingConfig = loadConfig('config_farming.json');

const customGameId = (showcaseConfig || farmingConfig).global_settings.custom_game_id;
if (!customGameId) {
    console.error("❌ 未找到 custom_game_id");
    process.exit(1);
}

console.log(`[配置] 目标地图 ID: ${customGameId}`);

// 收集所有账号
let allAccounts = [];

// Showcase Leaders
if (showcaseConfig && showcaseConfig.showcase_leaders) {
    showcaseConfig.showcase_leaders.forEach(acc => {
        allAccounts.push({ ...acc, type: 'Showcase' });
    });
}

// Farming Leaders & Followers
if (farmingConfig && farmingConfig.fleets) {
    // 加载全局代理（如果有）
    let globalProxies = [];
    if (farmingConfig.proxies_file) {
        globalProxies = loadProxies(farmingConfig.proxies_file);
    }

    farmingConfig.fleets.forEach(fleet => {
        const fleetProxies = fleet.proxies || globalProxies;
        
        // Leader
        if (fleet.leader) {
            // Leader 使用固定代理
            const proxy = fleet.leader.proxy || (fleetProxies.length > 0 ? fleetProxies[0] : null);
            allAccounts.push({ ...fleet.leader, type: 'Leader', proxy });
        }

        // Followers（随机选择代理）
        if (fleet.followers) {
            fleet.followers.forEach((acc) => {
                let proxy = acc.proxy;
                if (!proxy && fleetProxies.length > 0) {
                    proxy = fleetProxies[Math.floor(Math.random() * fleetProxies.length)];
                }
                allAccounts.push({ ...acc, type: 'Follower', proxy });
            });
        }
    });
}

console.log(`[配置] 总账号数: ${allAccounts.length}`);

// 共享数据目录
const globalSettings = (showcaseConfig || farmingConfig).global_settings || {};
const sharedDataPath = globalSettings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}
console.log(`[配置] 数据目录: ${steamDataDir}`);
console.log(`[配置] 发送速率: 10 账号/秒`);

console.log("\n" + "=".repeat(70));
console.log("  开始流水线订阅");
console.log("=".repeat(70) + "\n");

let successCount = 0;
let failCount = 0;
let sentCount = 0;
const startTime = Date.now();

// 流水线处理
async function processAll() {
    for (let i = 0; i < allAccounts.length; i++) {
        const account = allAccounts[i];
        
        // 立即发起 (不等待)
        processOne(account, i + 1);
        sentCount++;
        
        // 实时打印进度
        printProgress();
        
        // 间隔 100ms
        await new Promise(r => setTimeout(r, 100));
    }
}

function printProgress() {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const msg = `[进度] 已发送: ${sentCount}/${allAccounts.length} | 成功: ${successCount} | 失败: ${failCount} | 耗时: ${elapsed}s`;
        
    // 如果是 Web 环境（没有 TTY），输出换行
    if (!process.stdout.isTTY) {
        // 降低频率，避免 Web 日志爆炸，每 10 个输出一次
        if (sentCount % 10 === 0 || sentCount === allAccounts.length) {
            console.log(msg);
        }
    } else {
        process.stdout.write(`\r${msg}   `);
    }
}

async function processOne(account, index) {
    const steamProxy = account.proxy;
    let client = null;

    try {
        // 1. 尝试 Web 订阅 (优先使用本地代理)
        const subscribed = await tryWebSubscribe(account, steamProxy || LOCAL_PROXY);
        if (subscribed) {
            successCount++;
            return;
    }
    
        // 2. Web 失败则尝试 Steam 客户端订阅
        // console.log(`\n[#${index}] Web 订阅失败，尝试 Steam 客户端...`);
        
        client = new SteamUser({
            dataDirectory: steamDataDir,
            httpProxy: steamProxy
        });

        // 快速超时设置
        const loginTimeout = setTimeout(() => {
            if (client) {
                client.removeAllListeners();
                try { client.logOff(); } catch(e){}
            }
            failCount++;
        }, 30000); // 30秒超时

        client.on('loggedOn', async () => {
            clearTimeout(loginTimeout);
            try {
                await client.subscribeToPublishedFile(parseInt(customGameId));
                successCount++;
                // console.log(`[#${index}] Steam 订阅成功`);
            } catch (e) {
                failCount++;
            } finally {
                client.logOff();
            }
        });

        client.on('error', () => {
            clearTimeout(loginTimeout);
            failCount++;
        });
        
        const logOnOptions = {
            accountName: account.username,
            password: account.password
        };
        
        client.logOn(logOnOptions);

    } catch (err) {
        failCount++;
    }
}

function tryWebSubscribe(account, proxy) {
    return new Promise((resolve) => {
        // 这里只是为了兼容旧逻辑，实际上如果没有 Web Cookie 是无法 Web 订阅的
        // 除非我们有办法获取 Cookie。
        // 鉴于旧代码也没有实现完整的 Web 登录获取 Cookie 逻辑（或者是通过 SteamUser 获取 WebSession），
        // 这里简化为直接返回 false，让其回退到 SteamUser 订阅。
        // 如果需要 Web 订阅，必须通过 SteamUser logOn 后获取 webSession。
        resolve(false);
    });
}

processAll().then(() => {
    // 等待所有异步任务完成
    const checkInterval = setInterval(() => {
        if (successCount + failCount >= allAccounts.length) {
            clearInterval(checkInterval);
            console.log("\n\n" + "=".repeat(70));
            console.log("  全部完成!");
            console.log(`  成功: ${successCount}`);
            console.log(`  失败: ${failCount}`);
            console.log(`  总耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log("=".repeat(70));
    process.exit(0);
}
        // 更新 Web 进度
        if (!process.stdout.isTTY) printProgress();
    }, 1000);
});

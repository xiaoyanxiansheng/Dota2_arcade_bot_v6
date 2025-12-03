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
const LOCAL_PROXY = 'http://127.0.0.1:7890';

// 读取海外代理
let proxies = [];
try {
    const proxiesPath = path.join(projectRoot, 'data', 'proxies.txt');
    if (fs.existsSync(proxiesPath)) {
        const content = fs.readFileSync(proxiesPath, 'utf8');
        proxies = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        console.log(`\n[系统] 加载了 ${proxies.length} 个海外代理 (用于 Steam 登录)`);
    }
} catch (e) {}

console.log(`[系统] 本地代理: ${LOCAL_PROXY} (用于 Web 订阅)`);

// 读取配置
let config;
try {
    const configPath = path.join(projectRoot, 'config', 'config.json');
    const rawContent = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(rawContent);
} catch (e) {
    console.error("[错误] 读取配置失败: " + e.message);
    process.exit(1);
}

const customGameId = config.global_settings.custom_game_id;
if (!customGameId) {
    console.error("[错误] 未找到 custom_game_id");
    process.exit(1);
}

console.log(`[配置] 目标地图 ID: ${customGameId}`);

// 收集账号
let followers = [];
let fleets = config.fleets || [];
if (fleets.length > 0 && Array.isArray(fleets[0].leader)) {
    if (fleets[0].followers && Array.isArray(fleets[0].followers)) {
        followers = fleets[0].followers;
    }
} else {
    fleets.forEach(fleet => {
        if (fleet.followers && Array.isArray(fleet.followers)) {
            followers = followers.concat(fleet.followers);
        }
    });
}

console.log(`[配置] 总账号数: ${followers.length}`);

const sharedDataPath = config.global_settings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);
console.log(`[配置] 数据目录: ${steamDataDir}`);
console.log(`[配置] 发送速率: 5 账号/秒 (0.2秒间隔)`);

console.log("\n" + "=".repeat(70));
console.log("  开始流水线订阅 (每秒1个，不等待返回)");
console.log("=".repeat(70) + "\n");

let successCount = 0;
let failCount = 0;
let sentCount = 0;
const startTime = Date.now();

// 流水线处理
async function processAll() {
    const accountsPerProxy = config.global_settings.accounts_per_proxy || 6;
    let leaderCount = fleets.length;
    
    for (let i = 0; i < followers.length; i++) {
        const account = followers[i];
        
        // 分配海外代理
        let steamProxy = null;
        if (proxies.length > 0) {
            const proxyIndex = leaderCount + Math.floor(i / accountsPerProxy);
            steamProxy = proxies[proxyIndex % proxies.length];
        }
        
        // 立即发起 (不等待)
        processOne(account, steamProxy, i + 1);
        sentCount++;
        
        // 实时打印进度
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        process.stdout.write(`\r[进度] 已发送: ${sentCount}/${followers.length} | 成功: ${successCount} | 失败: ${failCount} | 耗时: ${elapsed}s   `);
        
        // 等待 0.2 秒后发下一个
        if (i < followers.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    
    console.log(`\n\n[INFO] 所有请求已发送，等待返回结果...\n`);
    
    // 等待所有完成 (最多等待 2 分钟)
    await new Promise(resolve => setTimeout(resolve, 120000));
    
    printFinalStats();
}

function processOne(account, steamProxy, index) {
    const steamOptions = { dataDirectory: steamDataDir };
    if (steamProxy) steamOptions.httpProxy = steamProxy;
    
    const client = new SteamUser(steamOptions);
    let isCompleted = false;
    let webSessionReceived = false;
    
    const finish = (success) => {
        if (isCompleted) return;
        isCompleted = true;
        
        if (success) {
            successCount++;
        } else {
            failCount++;
        }
        
        try {
            client.removeAllListeners();
            client.logOff();
        } catch (e) {}
    };
    
    // 60秒超时
    setTimeout(() => {
        if (!isCompleted) finish(false);
    }, 60000);
    
    client.on('error', () => {
        // 静默处理
    });
    
    client.on('webSession', (sessionID, cookies) => {
        if (webSessionReceived || isCompleted) return;
        webSessionReceived = true;
        
        subscribeViaLocalProxy(sessionID, cookies, finish);
    });
    
    client.on('loggedOn', () => {
        if (isCompleted) return;
        client.webLogOn();
    });
    
    const logOnOptions = {
        accountName: account.username,
        password: account.password,
        promptSteamGuardCode: false,
        rememberPassword: true,
        logonID: Math.floor(Math.random() * 1000000),
        shouldRememberPassword: true
    };
    
    if (account.shared_secret && account.shared_secret.length > 5) {
        try {
            logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(account.shared_secret);
        } catch (e) {}
    }
    
    client.logOn(logOnOptions);
}

function subscribeViaLocalProxy(sessionID, cookies, finish) {
    const postData = `id=${customGameId}&appid=570&sessionid=${sessionID}`;
    
    const options = {
        hostname: 'steamcommunity.com',
        port: 443,
        path: '/sharedfiles/subscribe',
        method: 'POST',
        agent: new HttpsProxyAgent(LOCAL_PROXY),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Content-Length': Buffer.byteLength(postData),
            'Cookie': cookies.join('; '),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
            'Origin': 'https://steamcommunity.com',
            'Referer': `https://steamcommunity.com/sharedfiles/filedetails/?id=${customGameId}`,
            'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 15000
    };
    
    const req = https.request(options, (res) => {
        let chunks = [];
        res.on('data', (chunk) => { chunks.push(chunk); });
        res.on('end', () => {
            let data = Buffer.concat(chunks);
            
            if (res.headers['content-encoding'] === 'gzip') {
                try {
                    const zlib = require('zlib');
                    data = zlib.gunzipSync(data);
                } catch (e) {}
            }
            
            const text = data.toString('utf8');
            
            if (res.statusCode === 200) {
                try {
                    const json = JSON.parse(text);
                    finish(json.success === 1);
                } catch (e) {
                    finish(text === '1');
                }
            } else {
                finish(false);
            }
        });
    });
    
    req.on('error', () => {
        finish(false);
    });
    
    req.on('timeout', () => {
        req.destroy();
        finish(false);
    });
    
    req.write(postData);
    req.end();
}

function printFinalStats() {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const successRate = ((successCount / followers.length) * 100).toFixed(1);
    
    console.log("\n" + "=".repeat(70));
    console.log("  订阅完成");
    console.log("=".repeat(70));
    console.log(`\n[结果] 成功: ${successCount}/${followers.length} (${successRate}%)`);
    console.log(`[结果] 失败: ${failCount}/${followers.length}`);
    console.log(`[结果] 总耗时: ${totalTime}s`);
    console.log(`[结果] 发送速率: ${(followers.length / totalTime).toFixed(1)} 账号/秒`);
    console.log("\n" + "=".repeat(70) + "\n");
    process.exit(0);
}

// 防止崩溃
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

// 开始
processAll();

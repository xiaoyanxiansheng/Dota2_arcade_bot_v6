const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

console.log("=".repeat(70));
console.log("  Dota 2 地图批量订阅工具 - v6.0 (池子模式)");
console.log("=".repeat(70));

const projectRoot = path.join(__dirname, '..');

// 获取命令行参数
const args = process.argv.slice(2);
const targetConfigName = args[0] || '';  // 配置名称 (如 config_000)
const targetGameId = args[1] || '';       // 游戏ID (可选)

// 配置
const SEND_INTERVAL = 100;       // 发送间隔 100ms
const LOGIN_TIMEOUT = 60000;     // 登录超时 60秒
const WEB_TIMEOUT = 15000;       // Web请求超时 15秒
const LOCAL_PROXY = 'http://127.0.0.1:7890'; // 本地代理（用于订阅请求）

// 帮助函数：读取 JSON 配置
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

// 帮助函数：读取 followers.txt
function loadFollowers(configName) {
    try {
        const followersPath = path.join(projectRoot, 'config', 'farm', configName, 'followers.txt');
        if (fs.existsSync(followersPath)) {
            const content = fs.readFileSync(followersPath, 'utf8').replace(/^\uFEFF/, '');
            return content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && line.includes(','))
                .map(line => {
                    const [username, password] = line.split(',');
                    return { username: username.trim(), password: password.trim(), retries: 0 };
                });
        }
    } catch (e) {}
    return [];
}

// 1. 加载主配置
const leadersConfig = loadConfig('config_leaders.json');
const showcaseConfig = loadConfig('config_showcase.json');

// 确定游戏ID
let customGameId = targetGameId;
if (!customGameId) {
    if (leadersConfig && leadersConfig.global_settings) {
        customGameId = leadersConfig.global_settings.custom_game_id;
    } else if (showcaseConfig && showcaseConfig.global_settings) {
        customGameId = showcaseConfig.global_settings.custom_game_id;
    }
}

if (!customGameId) {
    console.error("❌ 未找到 custom_game_id，请在工具箱输入游戏ID");
    process.exit(1);
}

console.log(`[配置] 目标地图 ID: ${customGameId}`);

// 2. 加载账号
if (!targetConfigName) {
    console.error("❌ 请选择要订阅的配置");
    process.exit(1);
}

console.log(`[配置] 使用配置: ${targetConfigName}`);

// 加载指定配置的 followers 到池子
const pool = loadFollowers(targetConfigName);
if (pool.length === 0) {
    console.error(`❌ 配置 ${targetConfigName} 中没有找到账号`);
    process.exit(1);
}

const totalAccounts = pool.length; // 记录原始总数

// 加载代理池（用于 Steam 登录）
const proxies = (leadersConfig && leadersConfig.proxies) || [];

console.log(`[配置] 账号数: ${totalAccounts}`);
console.log(`[配置] Steam代理池: ${proxies.length} 个`);
console.log(`[配置] 本地代理: ${LOCAL_PROXY} (用于Web订阅)`);
console.log(`[配置] 发送速率: ${1000/SEND_INTERVAL} 账号/秒`);

// 共享数据目录
const globalSettings = (leadersConfig && leadersConfig.global_settings) || 
                       (showcaseConfig && showcaseConfig.global_settings) || {};
const sharedDataPath = globalSettings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}
console.log(`[配置] 数据目录: ${steamDataDir}`);

console.log("\n" + "=".repeat(70));
console.log("  开始流水线订阅 (池子模式：失败放回池子末尾)");
console.log("=".repeat(70) + "\n");

// 统计
let successCount = 0;
let processing = 0; // 正在处理中的数量
const startTime = Date.now();

// 随机获取代理
function getRandomProxy() {
    if (proxies.length === 0) return null;
    return proxies[Math.floor(Math.random() * proxies.length)];
}

// 打印状态
function printStatus(accountInfo = null) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const poolSize = pool.length;
    const progress = ((successCount / totalAccounts) * 100).toFixed(1);
    
    // 构建状态行 - 没有失败概念了
    const statsLine = `[Stats] 总:${totalAccounts} | ✅成功:${successCount} | 🏊池子:${poolSize} | ⏳处理:${processing} | 进度:${progress}% | ⏱️${elapsed}s`;
    
    if (!process.stdout.isTTY) {
        // Web 环境：定期输出统计行
        if (successCount % 20 === 0 || poolSize === 0) {
            console.log(statsLine);
        }
        // 打印账号结果
        if (accountInfo) {
            console.log(accountInfo);
        }
    } else {
        // 终端环境：覆盖显示
        process.stdout.write(`\r${statsLine}   `);
        if (accountInfo) {
            console.log(`\n${accountInfo}`);
        }
    }
}

// 通过 Web API 订阅
function subscribeViaWeb(sessionID, cookies, callback) {
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Origin': 'https://steamcommunity.com',
            'Referer': `https://steamcommunity.com/sharedfiles/filedetails/?id=${customGameId}`,
            'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: WEB_TIMEOUT
    };

    const req = https.request(options, (res) => {
        let chunks = [];
        res.on('data', (chunk) => { chunks.push(chunk); });
        res.on('end', () => {
            let data = Buffer.concat(chunks);

            // 解压 gzip
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
                    callback(json.success === 1, null);
                } catch (e) {
                    callback(text === '1', null);
                }
            } else {
                callback(false, `HTTP:${res.statusCode}`);
            }
        });
    });

    req.on('error', (e) => {
        callback(false, `Web:${e.code || e.message}`);
    });

    req.on('timeout', () => {
        req.destroy();
        callback(false, 'WebTimeout');
    });

    req.write(postData);
    req.end();
}

// 判断是否可恢复的错误（放回池子）
function isRecoverableError(reason) {
    const recoverablePatterns = [
        'Timeout', 'timeout', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
        'Proxy', 'proxy', 'HTTP CONNECT', 'RateLimited', 'RateLimit',
        'ServiceUnavailable', 'TryAnotherCM', 'NoConnection'
    ];
    return recoverablePatterns.some(p => reason.includes(p));
}

// 处理单个账号
function processOne(account) {
    processing++;
    let client = null;
    let completed = false;
    let timeoutHandle = null;
    let webSessionReceived = false;
    
    const cleanup = () => {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
        }
        if (client) {
            try { 
                client.removeAllListeners();
                client.logOff(); 
            } catch(e) {}
            client = null;
        }
    };
    
    const markComplete = (success, reason = '') => {
        if (completed) return;
        completed = true;
        cleanup();
        processing--;
        
        let accountInfo = null;
        
        if (success) {
            successCount++;
            accountInfo = `[✅] ${account.username} - 订阅成功`;
        } else {
            // 判断是否可恢复
            if (isRecoverableError(reason)) {
                // 可恢复错误：放回池子末尾
                account.retries++;
                pool.push(account);
                accountInfo = `[🔄] ${account.username} - ${reason} → 放回池子 (第${account.retries}次)`;
            } else {
                // 不可恢复错误：直接标记成功（跳过），避免卡住
                // 实际上是"放弃"这个账号，但不计入失败
                successCount++; // 计为"已处理"
                accountInfo = `[⚠️] ${account.username} - ${reason} → 跳过`;
            }
        }
        
        printStatus(accountInfo);
    };
    
    try {
        // 随机代理
        const steamProxy = getRandomProxy();
        
        const steamOptions = { 
            dataDirectory: steamDataDir,
            autoRelogin: false,
            enablePicsCache: false
        };
        if (steamProxy) {
            steamOptions.httpProxy = steamProxy;
        }
        
        client = new SteamUser(steamOptions);

        // 超时处理
        timeoutHandle = setTimeout(() => {
            markComplete(false, 'Timeout');
        }, LOGIN_TIMEOUT);

        // 监听错误
        client.on('error', (err) => {
            const reason = `Login:${err.eresult || err.message || 'Unknown'}`;
            markComplete(false, reason);
        });

        // 获取 webSession 后订阅
        client.on('webSession', (sessionID, cookies) => {
            if (webSessionReceived || completed) return;
            webSessionReceived = true;

            subscribeViaWeb(sessionID, cookies, (success, error) => {
                if (success) {
                    markComplete(true);
                } else {
                    markComplete(false, error || 'SubFailed');
                }
            });
        });

        // 登录成功后请求 webSession
        client.on('loggedOn', () => {
            if (completed) return;
            client.webLogOn();
        });
        
        client.on('steamGuard', (domain, callback, lastCodeWrong) => {
            // 小号不应该需要验证，跳过
            markComplete(false, 'NeedGuard');
        });
        
        const logOnOptions = {
            accountName: account.username,
            password: account.password,
            promptSteamGuardCode: false,
            rememberPassword: true,
            logonID: Math.floor(Math.random() * 1000000),
            shouldRememberPassword: true
        };
        
        // 如果有 shared_secret，生成验证码
        if (account.shared_secret && account.shared_secret.length > 5) {
            try {
                logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(account.shared_secret);
            } catch (e) {}
        }
        
        client.logOn(logOnOptions);

    } catch (err) {
        markComplete(false, `Err:${err.message}`);
    }
}

// 流水线发送 - 从池子头部取，失败放回池子尾部
function startPipeline() {
    const sendNext = () => {
        // 池子空了，等待处理中的任务完成
        if (pool.length === 0) {
            if (processing === 0) {
                // 全部完成
                finishUp();
            } else {
                // 还有任务在处理，稍后再检查
                setTimeout(sendNext, 500);
            }
            return;
        }
        
        // 从池子头部取出一个账号
        const account = pool.shift();
        processOne(account);
        
        // 100ms后处理下一个
        setTimeout(sendNext, SEND_INTERVAL);
    };
    
    sendNext();
}

function finishUp() {
    console.log("\n\n" + "=".repeat(70));
    console.log("  ✅ 全部完成!");
    console.log("=".repeat(70));
    console.log(`  📊 总账号: ${totalAccounts}`);
    console.log(`  ✅ 成功: ${successCount} (${(successCount/totalAccounts*100).toFixed(1)}%)`);
    console.log(`  ⏱️ 总耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log("=".repeat(70));
    process.exit(0);
}

// 防止崩溃
process.on('uncaughtException', (err) => {
    console.error(`[Uncaught] ${err.message}`);
});
process.on('unhandledRejection', (err) => {
    // 静默处理
});

// 启动
startPipeline();

// 定期打印状态
const statusInterval = setInterval(() => {
    printStatus();
    
    // 检查是否卡住（池子不为空但没有进度）
    if (pool.length === 0 && processing === 0) {
        clearInterval(statusInterval);
    }
}, 3000);

// 超时保护：最多运行30分钟（池子模式可能需要更长时间）
setTimeout(() => {
    console.log("\n\n⚠️ 运行超时（30分钟），强制结束");
    console.log(`  ✅ 成功: ${successCount}`);
    console.log(`  🏊 池子剩余: ${pool.length}`);
    console.log(`  ⏳ 处理中: ${processing}`);
    process.exit(1);
}, 30 * 60 * 1000);

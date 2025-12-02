const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

/**
 * 清理脚本 - 极速模式
 * 一键退出所有小号并清理房间状态
 * 使用方法: node clear_all.js
 * 
 * 特性：
 * - 不等待服务器返回消息
 * - 高并发处理（100个同时）
 * - 使用原有代理分配规则
 * - 预计速度：10000账号 5-10分钟
 */

// 消息 ID 定义
const k_EMsgGCAbandonCurrentGame = 7035;
const k_EMsgGCPracticeLobbyLeave = 7040;
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004; // [新增] GC 连接状态确认
const k_EMsgProtoMask = 0x80000000;

// 加载配置
const projectRoot = path.join(__dirname, '..');
let config;
try {
    const configPath = path.join(projectRoot, 'config', 'config.json');
    const rawContent = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(rawContent);
} catch (e) {
    console.error("❌ 无法读取 config.json: " + e.message);
    process.exit(1);
}

// [新增] 获取共享验证数据目录
const sharedDataPath = config.global_settings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

// 确保共享目录存在
if (!fs.existsSync(steamDataDir)) {
    console.log(`📁 共享验证数据目录不存在，创建: ${steamDataDir}`);
    fs.mkdirSync(steamDataDir, { recursive: true });
} else {
    console.log(`📁 使用共享验证数据目录: ${steamDataDir}`);
}

// 加载代理列表
let proxies = [];
try {
    const proxiesPath = path.join(projectRoot, 'data', 'proxies.txt');
    if (fs.existsSync(proxiesPath)) {
        const content = fs.readFileSync(proxiesPath, 'utf8');
        proxies = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        console.log(`[System] 加载了 ${proxies.length} 个代理`);
    }
} catch (e) {
    console.log("⚠️ 读取代理文件失败（将不使用代理）: " + e.message);
}

// 加载 Proto
let CMsgClientHello;
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
    
    console.log("[System] Proto 文件加载成功");
} catch (e) {
    console.error("❌ Proto 加载失败: " + e.message);
    process.exit(1);
}

// 收集所有账号（跳过主号）并分配代理
const allAccounts = [];
let skippedLeaders = 0;
const accountsPerProxy = config.global_settings.accounts_per_proxy || 2;

let globalFollowerIndex = 0;
config.fleets.forEach((fleet, fleetIndex) => {
    // [跳过] Leader（主号需要验证，跳过处理）
    let leaderCount = 0;
    if (Array.isArray(fleet.leader)) {
        leaderCount = fleet.leader.length;
        skippedLeaders += leaderCount;
    } else {
        leaderCount = 1;
        skippedLeaders += 1;
    }
    
    // 只添加 Followers（并分配代理，使用与 index.js 相同的逻辑）
    if (fleet.followers) {
        fleet.followers.forEach((acc, idx) => {
            let proxy = null;
            if (proxies.length > 0) {
                // 使用与 index.js 相同的代理分配逻辑
                const proxyIndex = (fleetIndex + 1) + Math.floor(globalFollowerIndex / accountsPerProxy);
                proxy = proxies[proxyIndex % proxies.length];
            }
            
            allAccounts.push({
                account: acc,
                proxy: proxy
            });
            
            globalFollowerIndex++;
        });
    }
});

console.log(`\n🧹 极速清理工具启动`);
console.log(`📋 找到 ${allAccounts.length} 个小号 (已跳过 ${skippedLeaders} 个主号)`);
if (proxies.length > 0) {
    console.log(`🛡️ 使用 ${proxies.length} 个代理 (每 ${accountsPerProxy} 个账号使用 1 个代理)`);
}
console.log(`⚡ 并发数: 1000\n`);

let completedCount = 0;
let successCount = 0;
let failCount = 0;
const failedAccounts = []; // 记录失败的账号
const successfulProxies = []; // 记录成功的代理

// 清理单个账号（极速模式）
function clearAccount(accountData, index, total) {
    return new Promise((resolve) => {
        const account = accountData.account;
        const proxy = accountData.proxy;
        
        const steamOptions = {
            dataDirectory: steamDataDir
        };
        
        if (proxy) {
            steamOptions.httpProxy = proxy;
        }
        
        const client = new SteamUser(steamOptions);
        
        let commandsSent = false;
        let isCompleted = false; // [修复] 防止重复统计
        let isGcConnected = false; // [新增] GC 连接状态
        let timeout;
        
        // 统一结束处理函数
        const finish = (isSuccess) => {
            if (isCompleted) return; // 如果已经结束，直接返回
            isCompleted = true;
            clearTimeout(timeout);
            
            if (isSuccess) {
                successCount++;
                // 记录成功的代理
                if (proxy && !successfulProxies.includes(proxy)) {
                    successfulProxies.push(proxy);
                }
            } else {
                failCount++;
                failedAccounts.push(accountData);
            }
            
            // 确保断开
            try {
                client.logOff();
            } catch (e) {}
            
            resolve();
        };
        
        // 超时保护（20秒，增加到20秒以应对高延迟）
        timeout = setTimeout(() => {
            if (!isCompleted) {
                console.log(`⏱️  [${index}/${total}] ${account.username} - 超时`);
                finish(false);
            }
        }, 20000);
        
        // 错误处理
        client.on('error', (err) => {
            // 忽略常见错误，但如果这是致命错误导致无法继续，应该视为失败
            // 这里保持原有逻辑，依靠超时来处理连接失败
        });
        
        // 登录成功
        client.on('loggedOn', () => {
            if (isCompleted) return;
            client.setPersona(SteamUser.EPersonaState.Online);
            client.gamesPlayed([config.global_settings.target_app_id]);
        });
        
        // [新增] 监听 GC 消息
        client.on('receivedFromGC', (appid, msgType, payload) => {
            if (isCompleted || appid !== config.global_settings.target_app_id) return;
            
            const cleanMsgType = msgType & ~k_EMsgProtoMask;
            
            // 监听 GC 连接状态
            if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
                if (!isGcConnected) {
                    isGcConnected = true;
                    
                    // GC 连接成功后，发送退出命令
                    if (!commandsSent) {
                        try {
                            client.sendToGC(config.global_settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                            client.sendToGC(config.global_settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                            
                            commandsSent = true;
                            console.log(`✅ [${index}/${total}] ${account.username}`);
                            
                            // 等待 500ms 让命令发送出去，然后结束
                            setTimeout(() => {
                                finish(true);
                            }, 500);
                            
                        } catch (err) {}
                    }
                }
            }
        });
        
        // Dota 2 启动
        client.on('appLaunched', (appid) => {
            if (isCompleted) return;
            
            if (appid === config.global_settings.target_app_id) {
                // 发送 Hello 并启动心跳
                try {
                    const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
                    const message = CMsgClientHello.create(payload);
                    const buffer = CMsgClientHello.encode(message).finish();
                    client.sendToGC(config.global_settings.target_app_id, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
                    
                    // 每 5 秒发送一次 Hello（心跳），直到 GC 连接成功
                    const helloInterval = setInterval(() => {
                        if (isCompleted || isGcConnected) {
                            clearInterval(helloInterval);
                            return;
                        }
                        try {
                            client.sendToGC(config.global_settings.target_app_id, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
                        } catch (e) {}
                    }, 5000);
                    
                } catch (err) {}
            }
        });
        
        // 开始登录
        const logOnOptions = {
            accountName: account.username,
            password: account.password,
            promptSteamGuardCode: false,
            rememberPassword: true
        };
        
        if (account.shared_secret && account.shared_secret.length > 5) {
            try { 
                logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(account.shared_secret); 
            } catch (err) {}
        }
        
        try {
            client.logOn(logOnOptions);
        } catch (err) {
            console.log(`❌ [${index}/${total}] ${account.username} - 登录失败: ${err.message}`);
            finish(false);
        }
    });
}

// 批量清理（极速并发）
async function clearAllAccounts() {
    const batchSize = 1000; // 每批 1000 个（超级极速模式）
    const startTime = Date.now();
    
    for (let i = 0; i < allAccounts.length; i += batchSize) {
        const batch = allAccounts.slice(i, i + batchSize);
        const batchStartTime = Date.now();
        
        console.log(`\n⚡ 处理批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(allAccounts.length / batchSize)} (${batch.length} 个账号)`);
        
        const promises = batch.map((accData, idx) => 
            clearAccount(accData, i + idx + 1, allAccounts.length)
        );
        
        await Promise.all(promises);
        
        const batchTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        console.log(`✓ 批次完成，耗时 ${batchTime}s`);
        
        // 每批之间短暂延迟（避免过于激进）
        if (i + batchSize < allAccounts.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // 第一轮统计
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 第一轮完成`);
    console.log(`${'='.repeat(60)}`);
    console.log(`总计: ${allAccounts.length} 个小号`);
    console.log(`✅ 成功: ${successCount} 个 (${((successCount / allAccounts.length) * 100).toFixed(1)}%)`);
    console.log(`❌ 失败/超时: ${failCount} 个`);
    console.log(`⏱️  耗时: ${totalTime}s`);
    
    // 如果有失败的账号，进行重试
    if (failedAccounts.length > 0) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 开始重试失败的账号 (使用成功的代理IP)`);
        console.log(`${'='.repeat(60)}`);
        console.log(`📋 待重试: ${failedAccounts.length} 个`);
        console.log(`🛡️ 可用代理: ${successfulProxies.length} 个\n`);
        
        const retryStartTime = Date.now();
        let retrySuccessCount = 0;
        let retryFailCount = 0;
        
        // 为失败的账号重新分配成功的代理
        const retryAccounts = failedAccounts.map((accData, idx) => {
            let newProxy = null;
            if (successfulProxies.length > 0) {
                // 轮询使用成功的代理
                newProxy = successfulProxies[idx % successfulProxies.length];
            }
            return {
                account: accData.account,
                proxy: newProxy
            };
        });
        
        // 重试（每批 500 个）
        const retryBatchSize = 500;
        for (let i = 0; i < retryAccounts.length; i += retryBatchSize) {
            const batch = retryAccounts.slice(i, i + retryBatchSize);
            
            console.log(`⚡ 重试批次 ${Math.floor(i / retryBatchSize) + 1}/${Math.ceil(retryAccounts.length / retryBatchSize)} (${batch.length} 个账号)`);
            
            const promises = batch.map((accData, idx) => 
                new Promise((resolve) => {
                    clearAccount(accData, i + idx + 1, retryAccounts.length).then(() => {
                        // 统计重试结果（通过检查原始的 successCount 变化）
                        resolve();
                    });
                })
            );
            
            const batchStartTime = Date.now();
            await Promise.all(promises);
            const batchTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
            console.log(`✓ 批次完成，耗时 ${batchTime}s`);
            
            if (i + retryBatchSize < retryAccounts.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        const retryTime = ((Date.now() - retryStartTime) / 1000).toFixed(1);
        const totalTimeWithRetry = ((Date.now() - startTime) / 1000).toFixed(1);
        
        // 最终统计
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🎯 清理完成！`);
        console.log(`${'='.repeat(60)}`);
        console.log(`总计: ${allAccounts.length} 个小号`);
        console.log(`✅ 成功: ${successCount} 个 (${((successCount / allAccounts.length) * 100).toFixed(1)}%)`);
        console.log(`❌ 最终失败: ${allAccounts.length - successCount} 个`);
        console.log(`⏱️  总耗时: ${totalTimeWithRetry}s (重试: ${retryTime}s)`);
        console.log(`⚡ 平均速度: ${(allAccounts.length / totalTimeWithRetry).toFixed(1)} 账号/秒`);
        console.log(`\n💡 提示: 所有小号已发送退出命令 (主号已跳过)`);
    } else {
        // 没有失败的，直接输出最终统计
        console.log(`⚡ 平均速度: ${(allAccounts.length / totalTime).toFixed(1)} 账号/秒`);
        console.log(`\n💡 提示: 所有小号已发送退出命令 (主号已跳过)`);
    }
    
    process.exit(0);
}

// 执行
clearAllAccounts().catch(err => {
    console.error("❌ 发生错误:", err);
    process.exit(1);
});


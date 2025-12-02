const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

console.log("=".repeat(70));
console.log("  Dota 2 地图订阅工具 - 单账号多代理调试版");
console.log("=".repeat(70));

// 项目根目录
const projectRoot = path.join(__dirname, '..');

// 读取代理列表
let proxies = [];
try {
    const proxiesPath = path.join(projectRoot, 'data', 'proxies.txt');
    if (fs.existsSync(proxiesPath)) {
        const content = fs.readFileSync(proxiesPath, 'utf8');
        proxies = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        console.log(`\n[系统] 加载了 ${proxies.length} 个代理`);
    } else {
        console.log(`\n[系统] 未找到代理文件,将直连`);
    }
} catch (e) {
    console.error("\n[错误] 读取代理文件失败: " + e.message);
}

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

const targetAppId = 570;
const customGameId = config.global_settings.custom_game_id;

if (!customGameId) {
    console.error("[错误] 配置中未找到 custom_game_id");
    process.exit(1);
}

console.log(`[配置] 目标地图 ID: ${customGameId}`);

// 收集主号 (Leader)
let leaders = [];
let fleets = config.fleets || [];

if (fleets.length > 0 && Array.isArray(fleets[0].leader)) {
    leaders = fleets[0].leader;
} else {
    fleets.forEach(fleet => {
        if (fleet.leader) {
            leaders.push(fleet.leader);
        }
    });
}

if (leaders.length === 0) {
    console.log("[错误] 没有找到 leader 账号");
    process.exit(1);
}

// 使用第一个主号测试
const testAccount = leaders[0];
console.log(`[配置] 测试账号: ${testAccount.username} (主号)`);

// 共享验证数据目录
const sharedDataPath = config.global_settings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);
console.log(`[配置] 验证数据目录: ${steamDataDir}`);

// Proto 文件路径
const PROTOS = {
    publishedFile: "steammessages_publishedfile.steamclient.proto",
    unifiedBase: "steammessages_unified_base.steamworkssdk.proto" 
};

// [关键] 全局加载 Proto 定义一次,避免重复加载冲突
console.log("[系统] 正在加载 Protobuf 定义...");
const globalRoot = new protobuf.Root();
globalRoot.resolvePath = function(origin, target) {
     if (fs.existsSync(target)) return target;
     
     const pathsToTry = [
         path.join(projectRoot, "Protobufs", target),
         path.join(projectRoot, "Protobufs", "steam", target),
         path.join(projectRoot, "Protobufs", "dota2", target),
         path.join(projectRoot, "Protobufs", "google", "protobuf", target)
     ];
     
     for (const p of pathsToTry) {
         if (fs.existsSync(p)) return p;
     }
     
     if (target.includes("descriptor.proto")) {
         return path.join(projectRoot, "Protobufs", "google", "protobuf", "descriptor.proto");
     }

     return target;
};

try {
    globalRoot.loadSync(PROTOS.publishedFile); // 只加载需要的文件,依赖会自动解析
    console.log("[系统] ✅ Protobuf 定义加载成功");
} catch (e) {
    console.error("[错误] Protobuf 加载失败: " + e.message);
    process.exit(1);
}

const SubscribeRequestType = globalRoot.lookupType("CPublishedFile_Subscribe_Request");

console.log("\n" + "=".repeat(70));
console.log("  开始尝试订阅...");
console.log("=".repeat(70) + "\n");

// 尝试使用不同代理订阅
async function trySubscribeWithProxies() {
    const maxProxies = Math.min(5, proxies.length); // 最多尝试5个代理
    
    for (let proxyIndex = 0; proxyIndex < maxProxies; proxyIndex++) {
        const proxy = proxies.length > 0 ? proxies[proxyIndex] : null;
        const proxyDisplay = proxy ? proxy.replace(/:[^:@]+@/, ':****@') : 'Direct';
        
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`  尝试 #${proxyIndex + 1}/${maxProxies} | 代理: ${proxyDisplay}`);
        console.log(`${'─'.repeat(70)}\n`);
        
        const result = await trySubscribe(testAccount, proxy, proxyIndex + 1);
        
        if (result.success) {
            console.log("\n" + "=".repeat(70));
            console.log(`  ✅ 订阅成功!`);
            console.log("=".repeat(70));
            process.exit(0);
        } else {
            console.log(`\n❌ 失败原因: ${result.reason}\n`);
            if (proxyIndex < maxProxies - 1) {
                console.log(`⏭️  切换到下一个代理重试...\n`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    console.log("\n" + "=".repeat(70));
    console.log(`  ❌ 所有尝试均失败`);
    console.log("=".repeat(70));
    process.exit(1);
}

function trySubscribe(account, proxy, attemptNum) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const log = (msg) => console.log(`  [${((Date.now() - startTime) / 1000).toFixed(1)}s] ${msg}`);
        
        const steamOptions = {
            dataDirectory: steamDataDir
        };
        
        if (proxy) {
            steamOptions.httpProxy = proxy;
        }

        log("📦 创建 SteamUser 客户端...");
        const client = new SteamUser(steamOptions);
        let isCompleted = false;
        let loginTimeout = null;

        const finish = (success, reason = '') => {
            if (isCompleted) return;
            isCompleted = true;
            if (loginTimeout) clearTimeout(loginTimeout);
            
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log(`🏁 结束 | 耗时: ${elapsed}s | 结果: ${success ? '成功' : '失败'}`);
            
            try {
                client.removeAllListeners();
                client.logOff();
            } catch (e) {}
            
            resolve({ success, reason });
        };

        // 60秒超时 - 针对单次尝试
        loginTimeout = setTimeout(() => {
            if (!isCompleted) {
                finish(false, '超时 (60s 无响应)');
            }
        }, 60000);

        // 监听各种事件
        client.on('error', (err) => {
            log(`⚠️  ERROR 事件: ${err.message}`);
            // LoggedInElsewhere 立即失败,其他错误等超时
            if (err.message === 'LoggedInElsewhere') {
                finish(false, '账号在其他地方登录');
            }
        });

        client.on('connected', () => {
            log(`🔗 CONNECTED 事件 - TCP连接已建立`);
        });

        client.on('disconnected', (eresult, msg) => {
            log(`❌ DISCONNECTED 事件 - 断开连接: ${eresult} (${msg})`);
        });

        client.on('loggedOn', () => {
            if (isCompleted) return;
            log(`✅ LOGGED_ON 事件 - Steam 登录成功`);
            
            // 设置在线状态
            log(`📝 设置在线状态...`);
            client.setPersona(SteamUser.EPersonaState.Online);
            
            // 启动 Dota 2
            log(`🎮 启动 Dota 2 (AppID: 570)...`);
            client.gamesPlayed([570]);
            
            // 等待 2 秒让状态同步
            log(`⏳ 等待 2 秒让状态同步...`);
            setTimeout(() => {
                if (isCompleted) return;
                
                log(`📤 准备发送订阅请求...`);
                
                try {
                    // 构造 Unified 消息
                    const k_EMsgServiceMethodCallFromClient = 4401;
                    const header = { 
                        msg: k_EMsgServiceMethodCallFromClient, 
                        proto: { routing_appid: 570 } 
                    };
                    const methodName = "PublishedFile.Subscribe#1";
                    
                    log(`📋 请求参数:`);
                    log(`   - Method: ${methodName}`);
                    log(`   - PublishedFileID: ${customGameId}`);
                    log(`   - AppID: 570`);
                    
                    const reqData = {
                        publishedfileid: Long.fromString(String(customGameId)),
                        appid: 570,
                        notify_client: false
                    };

                    // 使用全局已加载的 Proto 定义
                    log(`📝 创建订阅请求消息...`);
                    const message = SubscribeRequestType.create(reqData);
                    const reqBuffer = SubscribeRequestType.encode(message).finish();
                    log(`✅ 请求消息序列化完成 (${reqBuffer.length} bytes)`);

                    // 构造 ServiceMethodCallFromClient 消息体
                    const methodNameBuf = Buffer.from(methodName, 'utf8');
                    function encodeVarint(num) {
                         const buf = [];
                         while (num > 0x7F) { buf.push((num & 0x7F) | 0x80); num >>>= 7; }
                         buf.push(num);
                         return Buffer.from(buf);
                    }
                    
                    const bodyParts = [
                         Buffer.from([0x0a]), encodeVarint(methodNameBuf.length), methodNameBuf,
                         Buffer.from([0x12]), encodeVarint(reqBuffer.length), reqBuffer
                    ];
                    const body = Buffer.concat(bodyParts);
                    log(`✅ 消息体构造完成 (${body.length} bytes)`);
                    
                    // 发送请求
                    log(`🚀 发送订阅请求到 Steam 服务器...`);
                    log(`   Header: msg=${header.msg}, proto=${JSON.stringify(header.proto)}`);
                    log(`   Body: ${body.length} bytes`);
                    
                    // 设置一个内部超时检测回调是否被调用
                    let callbackCalled = false;
                    const callbackTimeout = setTimeout(() => {
                        if (!callbackCalled && !isCompleted) {
                            log(`⚠️  警告: 30秒内回调未被调用,可能是 _send 实现问题`);
                        }
                    }, 30000);
                    
                    client._send(header, body, (err, resp) => {
                        callbackCalled = true;
                        clearTimeout(callbackTimeout);
                        
                        if (isCompleted) return;
                        
                        log(`📨 回调被调用! err=${!!err}, resp=${!!resp}`);
                        
                        if (err) {
                            log(`❌ 请求失败: ${err.message}`);
                            finish(false, `Steam API 错误: ${err.message}`);
                        } else {
                            log(`✅ 收到服务器响应!`);
                            if (resp && resp.length > 0) {
                                log(`📦 响应数据: ${resp.length} bytes`);
                                // 尝试解析响应
                                try {
                                    const ResponseType = globalRoot.lookupType("CPublishedFile_Subscribe_Response");
                                    const response = ResponseType.decode(resp);
                                    log(`📋 响应内容: ${JSON.stringify(ResponseType.toObject(response))}`);
                                } catch (e) {
                                    log(`⚠️  响应解析失败: ${e.message}`);
                                }
                            } else {
                                log(`📭 响应为空 (可能表示成功)`);
                            }
                            finish(true);
                        }
                    });

                } catch (e) {
                    log(`❌ 构造/发送消息时出错: ${e.message}`);
                    log(`   堆栈: ${e.stack}`);
                    finish(false, `消息构造失败: ${e.message}`);
                }
            }, 2000);
        });

        // 开始登录
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
                log(`🔐 生成 2FA 验证码: ${logOnOptions.twoFactorCode}`);
            } catch (e) {
                log(`⚠️  生成 2FA 验证码失败: ${e.message}`);
            }
        }

        try {
            log(`🔑 调用 client.logOn()...`);
            log(`   - 账号: ${account.username}`);
            log(`   - LogonID: ${logOnOptions.logonID}`);
            client.logOn(logOnOptions);
        } catch (e) {
            log(`❌ logOn() 调用异常: ${e.message}`);
            finish(false, `登录调用失败: ${e.message}`);
        }
    });
}

// 运行
trySubscribeWithProxies();

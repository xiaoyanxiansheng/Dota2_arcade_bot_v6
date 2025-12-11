/**
 * 代理测试工具 v1.0
 * 
 * 测试 config_leaders.json 中的所有代理是否可用
 * 通过连接 Steam API 来验证代理
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const projectRoot = path.join(__dirname, '..');

// 配置
const TEST_URL = 'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/';
const TEST_TIMEOUT = 30000;   // 30秒超时
const SEND_INTERVAL = 100;    // 每0.1秒发送一个

// 统计
let totalProxies = 0;
let completedCount = 0;
let successCount = 0;
let failedCount = 0;
let pendingCount = 0;
let successProxies = [];
const startTime = Date.now();

// 错误统计
const errorStats = {};

function recordError(reason) {
    const key = reason.substring(0, 50);
    errorStats[key] = (errorStats[key] || 0) + 1;
}

function printStatus(detail = '') {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const percent = totalProxies > 0 ? ((completedCount / totalProxies) * 100).toFixed(1) : 0;
    const successRate = completedCount > 0 ? ((successCount / completedCount) * 100).toFixed(1) : 0;
    console.log(`[Stats] 总:${totalProxies} | ✅成功:${successCount} | ❌失败:${failedCount} | ⏳测试中:${pendingCount} | 进度:${percent}% | 成功率:${successRate}% | ⏱️${elapsed}s`);
    if (detail) {
        console.log(detail);
    }
}

// 测试单个代理
function testProxy(proxyUrl) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve({ success: false, error: 'Timeout' });
        }, TEST_TIMEOUT);

        try {
            const agent = new HttpsProxyAgent(proxyUrl);
            const req = https.get(TEST_URL, { agent, timeout: TEST_TIMEOUT }, (res) => {
                clearTimeout(timeout);
                if (res.statusCode === 200) {
                    resolve({ success: true });
                } else {
                    resolve({ success: false, error: `HTTP ${res.statusCode}` });
                }
                res.resume();
            });

            req.on('error', (err) => {
                clearTimeout(timeout);
                resolve({ success: false, error: err.message || err.code || 'Unknown' });
            });

            req.on('timeout', () => {
                clearTimeout(timeout);
                req.destroy();
                resolve({ success: false, error: 'Request Timeout' });
            });
        } catch (err) {
            clearTimeout(timeout);
            resolve({ success: false, error: err.message });
        }
    });
}

// 主函数
async function main() {
    console.log('======================================================================');
    console.log('代理测试工具 v1.0 - Steam API 连接测试');
    console.log('======================================================================');

    // 读取配置
    const configPath = path.join(projectRoot, 'config', 'config_leaders.json');
    let config;
    try {
        const content = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
        config = JSON.parse(content);
    } catch (e) {
        console.error(`❌ 读取配置失败: ${e.message}`);
        process.exit(1);
    }

    const proxies = config.proxies || [];
    totalProxies = proxies.length;

    if (totalProxies === 0) {
        console.log('❌ 代理列表为空');
        process.exit(1);
    }

    console.log(`[配置] 代理数量: ${totalProxies}`);
    console.log(`[配置] 发送间隔: ${SEND_INTERVAL}ms (每秒10个)`);
    console.log(`[配置] 超时时间: ${TEST_TIMEOUT}ms`);
    console.log(`[配置] 测试目标: ${TEST_URL}`);
    console.log('======================================================================');
    console.log('开始流水线测试...');
    console.log('======================================================================');

    // 状态打印定时器
    const statusInterval = setInterval(() => printStatus(), 2000);

    // 流水线测试
    let index = 0;
    
    const sendNext = () => {
        if (index >= proxies.length) {
            return;
        }
        
        const currentIndex = index++;
        const proxy = proxies[currentIndex];
        pendingCount++;
        
        testProxy(proxy).then(result => {
            pendingCount--;
            completedCount++;
            
            if (result.success) {
                successCount++;
                successProxies.push(proxy);
                console.log(`[✅] ${proxy.substring(0, 60)}...`);
            } else {
                failedCount++;
                recordError(result.error);
                console.log(`[❌] ${proxy.substring(0, 50)}... - ${result.error}`);
            }
        });
        
        setTimeout(sendNext, SEND_INTERVAL);
    };
    
    sendNext();
    
    // 等待所有测试完成
    await new Promise(resolve => {
        const checkComplete = setInterval(() => {
            if (completedCount >= totalProxies) {
                clearInterval(checkComplete);
                resolve();
            }
        }, 500);
    });

    clearInterval(statusInterval);

    // 最终统计
    console.log('======================================================================');
    console.log('测试完成');
    console.log('======================================================================');
    printStatus();
    
    const successRate = totalProxies > 0 ? ((successCount / totalProxies) * 100).toFixed(1) : 0;
    console.log(`\n📊 成功率: ${successRate}%`);
    
    if (Object.keys(errorStats).length > 0) {
        console.log('\n📋 错误统计:');
        Object.entries(errorStats)
            .sort((a, b) => b[1] - a[1])
            .forEach(([error, count]) => {
                console.log(`   ${error}: ${count}次`);
            });
    }

    // 保存成功的代理
    if (successProxies.length > 0) {
        const successPath = path.join(projectRoot, 'data', 'success_proxies.json');
        try {
            fs.mkdirSync(path.dirname(successPath), { recursive: true });
            fs.writeFileSync(successPath, JSON.stringify(successProxies, null, 2), 'utf8');
            console.log(`\n💾 成功代理已保存到: ${successPath} (${successProxies.length} 个)`);
            console.log(`\n📋 可通过 Web 界面的"替换代理"按钮将成功代理写入配置`);
        } catch (e) {
            console.log(`\n⚠️ 保存成功代理列表失败: ${e.message}`);
        }
    }

    console.log('\n✅ 测试完成');
}

// 防止未捕获的错误导致程序崩溃
process.on('uncaughtException', (err) => {
    console.error('未捕获的异常:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('未处理的 Promise 拒绝:', reason);
});

main().catch(err => {
    console.error('程序错误:', err);
    process.exit(1);
});

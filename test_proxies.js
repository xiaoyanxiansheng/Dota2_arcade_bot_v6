const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
const fs = require('fs');

/**
 * 代理测试工具
 * 用于批量测试 proxies.txt 中的代理是否可用
 */

const TIMEOUT = 10000; // 10秒超时
const TEST_URL = 'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/';

// 读取代理列表
function loadProxies() {
    try {
        const content = fs.readFileSync('./proxies.txt', 'utf8');
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
    } catch (e) {
        console.error("❌ 无法读取 proxies.txt: " + e.message);
        process.exit(1);
    }
}

// 测试单个代理
function testProxy(proxyUrl, index, total) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        
        try {
            // 判断是 SOCKS5 还是 HTTP 代理
            let agent;
            if (proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://')) {
                agent = new SocksProxyAgent(proxyUrl);
            } else {
                // 假设是 HTTP/HTTPS 代理
                agent = new HttpsProxyAgent(proxyUrl);
            }
            
            const req = https.get(TEST_URL, { 
                agent: agent,
                timeout: TIMEOUT,
                headers: {
                    'User-Agent': 'Mozilla/5.0'
                }
            }, (res) => {
                const latency = Date.now() - startTime;
                if (res.statusCode === 200) {
                    console.log(`✅ [${index}/${total}] ${latency}ms - ${maskProxy(proxyUrl)}`);
                    resolve({ success: true, proxy: proxyUrl, latency });
                } else {
                    console.log(`⚠️ [${index}/${total}] HTTP ${res.statusCode} - ${maskProxy(proxyUrl)}`);
                    resolve({ success: false, proxy: proxyUrl, reason: `HTTP ${res.statusCode}` });
                }
            });
            
            req.on('error', (err) => {
                console.log(`❌ [${index}/${total}] ${err.message} - ${maskProxy(proxyUrl)}`);
                resolve({ success: false, proxy: proxyUrl, reason: err.message });
            });
            
            req.on('timeout', () => {
                req.abort();
                console.log(`⏱️ [${index}/${total}] 超时 - ${maskProxy(proxyUrl)}`);
                resolve({ success: false, proxy: proxyUrl, reason: 'Timeout' });
            });
            
        } catch (err) {
            console.log(`❌ [${index}/${total}] ${err.message} - ${maskProxy(proxyUrl)}`);
            resolve({ success: false, proxy: proxyUrl, reason: err.message });
        }
    });
}

// 脱敏显示代理信息（隐藏密码）
function maskProxy(proxyUrl) {
    return proxyUrl.replace(/:[^:@]+@/, ':****@');
}

// 批量测试代理（并发）
async function testProxiesConcurrent(proxies, concurrency = 10) {
    const results = [];
    const total = proxies.length;
    
    console.log(`\n🔍 开始测试 ${total} 个代理 (并发数: ${concurrency})...\n`);
    
    for (let i = 0; i < proxies.length; i += concurrency) {
        const batch = proxies.slice(i, i + concurrency);
        const batchPromises = batch.map((proxy, idx) => 
            testProxy(proxy, i + idx + 1, total)
        );
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // 每批之间短暂延迟，避免过于激进
        if (i + concurrency < proxies.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    return results;
}

// 保存测试结果
function saveResults(results) {
    const validProxies = results.filter(r => r.success).map(r => r.proxy);
    const invalidProxies = results.filter(r => !r.success);
    
    // 保存可用的代理
    fs.writeFileSync('./proxies_valid.txt', validProxies.join('\n'), 'utf8');
    
    // 保存详细报告
    const report = {
        testTime: new Date().toISOString(),
        total: results.length,
        valid: validProxies.length,
        invalid: invalidProxies.length,
        validRate: ((validProxies.length / results.length) * 100).toFixed(2) + '%',
        details: results
    };
    
    fs.writeFileSync('./proxy_test_report.json', JSON.stringify(report, null, 2), 'utf8');
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 测试完成！`);
    console.log(`${'='.repeat(60)}`);
    console.log(`总计: ${results.length} 个代理`);
    console.log(`✅ 可用: ${validProxies.length} 个 (${report.validRate})`);
    console.log(`❌ 失效: ${invalidProxies.length} 个`);
    console.log(`\n💾 可用代理已保存至: proxies_valid.txt`);
    console.log(`📄 详细报告已保存至: proxy_test_report.json`);
    
    if (validProxies.length > 0) {
        const avgLatency = results
            .filter(r => r.success)
            .reduce((sum, r) => sum + r.latency, 0) / validProxies.length;
        console.log(`⚡ 平均延迟: ${avgLatency.toFixed(0)}ms`);
    }
    
    console.log(`\n💡 提示: 将 proxies_valid.txt 重命名为 proxies.txt 以使用可用代理`);
}

// 主函数
async function main() {
    const proxies = loadProxies();
    
    if (proxies.length === 0) {
        console.error("❌ proxies.txt 中没有找到代理");
        process.exit(1);
    }
    
    console.log(`📋 读取到 ${proxies.length} 个代理`);
    
    const results = await testProxiesConcurrent(proxies, 10);
    
    saveResults(results);
}

// 执行
main().catch(err => {
    console.error("❌ 发生错误:", err);
    process.exit(1);
});


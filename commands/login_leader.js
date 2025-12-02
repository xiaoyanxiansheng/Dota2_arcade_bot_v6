const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const fs = require('fs');
const path = require('path');

console.log("--- Leader 登录验证工具 ---\n");

// 项目根目录
const projectRoot = path.join(__dirname, '..');

// [新增] 读取代理列表
let proxies = [];
try {
    const proxiesPath = path.join(projectRoot, 'data', 'proxies.txt');
    if (fs.existsSync(proxiesPath)) {
        const content = fs.readFileSync(proxiesPath, 'utf8');
        proxies = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        if (proxies.length > 0) {
            console.log(`✅ 加载了 ${proxies.length} 个代理 IP\n`);
        }
    }
} catch (e) {
    console.error("⚠️ 读取代理文件失败: " + e.message);
}

// 读取配置
let config;
try {
    const configPath = path.join(projectRoot, 'config', 'config.json');
    const rawContent = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(rawContent);
} catch (e) {
    console.error("❌ 读取配置失败: " + e.message);
    process.exit(1);
}

if (!config.fleets || config.fleets.length === 0) {
    console.error("❌ 未找到车队配置");
    process.exit(1);
}

// [新增] 检查是否使用新格式（leader 是数组）
let leaders = [];
if (Array.isArray(config.fleets[0].leader)) {
    // 新格式：leader 是数组
    leaders = config.fleets[0].leader;
    console.log(`📋 发现 ${leaders.length} 个主号:\n`);
    leaders.forEach((leader, idx) => {
        console.log(`   [${idx + 1}] ${leader.username}`);
    });
} else {
    // 旧格式：每个 fleet 有一个 leader 对象
    console.log(`📋 发现 ${config.fleets.length} 个车队:\n`);
    config.fleets.forEach((fleet, idx) => {
        console.log(`   [${idx + 1}] ${fleet.id || 'fleet_' + (idx + 1)} - Leader: ${fleet.leader.username}`);
        leaders.push(fleet.leader);
    });
}

// 从命令行参数获取要登录的主号编号 (默认第一个)
const args = process.argv.slice(2);
let leaderIndex = 0;

if (args.length > 0) {
    const userInput = parseInt(args[0]);
    if (isNaN(userInput) || userInput < 1 || userInput > leaders.length) {
        console.error(`\n❌ 无效的主号编号: ${args[0]}`);
        console.log(`💡 用法: node login_leader.js [主号编号]`);
        console.log(`   例如: node login_leader.js 1   (登录第一个主号)`);
        console.log(`   例如: node login_leader.js 2   (登录第二个主号)\n`);
        process.exit(1);
    }
    leaderIndex = userInput - 1;
}

const leader = leaders[leaderIndex];

console.log(`\n🎯 正在登录主号 [${leaderIndex + 1}]: ${leader.username}\n`);

// [关键修改] 使用共享验证数据目录（项目外部），支持多项目共享
// 共享目录路径从配置文件读取，默认为项目父目录下的 shared_steam_data
const sharedDataPath = config.global_settings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

// 确保共享目录存在
if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
    console.log(`📁 创建共享验证数据目录: ${steamDataDir}\n`);
} else {
    console.log(`📁 使用共享验证数据目录: ${steamDataDir}\n`);
}

// [关键修改] 主号使用固定代理：主号1用代理1，主号2用代理2，依此类推
const steamOptions = {
    dataDirectory: steamDataDir
};

if (proxies.length > 0) {
    // 主号固定使用对应编号的代理（与 index.js 保持一致）
    steamOptions.httpProxy = proxies[leaderIndex];
    const proxyDisplay = proxies[leaderIndex].replace(/:[^:@]+@/, ':****@');
    console.log(`🛡️ 使用固定代理登录 (代理 #${leaderIndex + 1}): ${proxyDisplay}\n`);
}

const client = new SteamUser(steamOptions);

const logOnOptions = {
    accountName: leader.username,
    password: leader.password,
    promptSteamGuardCode: true // 关键：允许交互式输入
};

if (leader.shared_secret && leader.shared_secret.length > 5) {
    try { 
        logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(leader.shared_secret);
        console.log("ℹ️ 使用 shared_secret 自动生成验证码");
    } catch (err) {
        console.error("⚠️ shared_secret 无效，将使用手动输入模式");
    }
}

client.logOn(logOnOptions);

client.on('loggedOn', () => {
    console.log(`\n✅✅✅ 登录成功！`);
    console.log(`[${leader.username}] 登录凭证已自动保存到共享目录:`);
    console.log(`   ${steamDataDir}`);
    console.log(`\n💡 提示: 如果您有多个车队，请继续运行：`);
    console.log(`   node login_leader.js 2   (登录第二个车队)`);
    console.log(`   node login_leader.js 3   (登录第三个车队)`);
    console.log(`\n➡️ 所有 Leader 都登录完成后，运行 'node index.js' 启动批量脚本。`);
    console.log(`\n🔄 共享目录说明: 所有使用相同 IP 和此目录的项目将共享验证信息。\n`);
    
    // 稍微等待一下以确保文件写入
    setTimeout(() => process.exit(0), 2000);
});

client.on('error', (err) => {
    console.error(`\n❌ 登录失败: ${err.message}`);
    if (err.eresult === 63 || err.eresult === 6) {
        console.log("👉 请在上方输入您的 Steam 令牌验证码 (Email 或 手机App) 并回车！");
    }
});


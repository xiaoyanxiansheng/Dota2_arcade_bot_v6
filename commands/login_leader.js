const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

console.log("--- Leader 登录验证工具 ---\n");

// 项目根目录
const projectRoot = path.join(__dirname, '..');

// 帮助函数：读取配置
function loadConfig(filename) {
    try {
        const configPath = path.join(projectRoot, 'config', filename);
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error(`⚠️ 读取 ${filename} 失败: ${e.message}`);
    }
    return null;
}

// 1. 加载所有主号
const allLeaders = [];

// 从展示配置加载
const showcaseConfig = loadConfig('config_showcase.json');
if (showcaseConfig && showcaseConfig.showcase_leaders) {
    showcaseConfig.showcase_leaders.forEach(leader => {
        allLeaders.push({ ...leader, type: 'Showcase', source: 'config_showcase.json' });
    });
}

// 从挂机配置加载
const farmingConfig = loadConfig('config_farming.json');
if (farmingConfig && farmingConfig.fleets) {
    farmingConfig.fleets.forEach(fleet => {
        if (fleet.leader) {
            allLeaders.push({ ...fleet.leader, type: 'Farming', source: 'config_farming.json' });
        }
    });
}

if (allLeaders.length === 0) {
    console.error("❌ 未找到任何主号配置");
    process.exit(1);
}

// 2. 显示主号列表
console.log(`📋 发现 ${allLeaders.length} 个主号:\n`);
allLeaders.forEach((leader, idx) => {
    console.log(`   [${idx + 1}] ${leader.username} (${leader.type})`);
});

// 3. 获取要登录的账号
const args = process.argv.slice(2);
let targetLeader = null;

// 检查是否通过 Web API 调用（传入 JSON 参数）
if (args.length >= 2) {
    // Web API 模式: type username
    const type = args[0];
    const username = args[1];
    targetLeader = allLeaders.find(l => 
        l.type.toLowerCase() === type.toLowerCase() && l.username === username
    );
    if (!targetLeader) {
        console.error(`❌ 未找到账号: ${username} (${type})`);
        process.exit(1);
    }
} else if (args.length === 1) {
    // 命令行模式: index
    const userInput = parseInt(args[0]);
    if (!isNaN(userInput) && userInput >= 1 && userInput <= allLeaders.length) {
        targetLeader = allLeaders[userInput - 1];
    }
}

if (!targetLeader) {
    console.log(`\n💡 用法: node login_leader.js [编号] 或 [type] [username]`);
    process.exit(1);
}

console.log(`\n🎯 正在登录主号: ${targetLeader.username} (${targetLeader.type})\n`);

// 4. 准备登录
// 共享数据目录
const globalSettings = (showcaseConfig || farmingConfig).global_settings || {};
const sharedDataPath = globalSettings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);

if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}

const client = new SteamUser({
    dataDirectory: steamDataDir,
    httpProxy: targetLeader.proxy
});

client.on('loggedOn', () => {
    console.log(`✅ [${targetLeader.username}] 登录成功!`);
    console.log(`   SteamID: ${client.steamID.getSteamID64()}`);
    console.log(`   IP Country: ${client.publicIP ? client.publicIP : 'Unknown'}`);
    
    // 尝试获取一下凭证状态
    console.log(`   Machine Auth Token 已更新/验证`);
    
    setTimeout(() => {
        client.logOff();
        process.exit(0);
    }, 2000);
});

client.on('error', (err) => {
    console.error(`❌ 登录错误: ${err.message}`);
    process.exit(1);
});

// 处理 Steam Guard 验证码
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

client.on('steamGuard', (domain, callback) => {
    console.log(`[STEAM_GUARD]${domain || 'Email'}`);
    console.log(`🔐 需要 Steam Guard 验证码 (${domain || 'Email'})`);
    console.log(`请在 Web 界面输入验证码...`);
    
    rl.question('', (code) => {
        callback(code.trim());
    });
});

// 开始登录
const logOnOptions = {
    accountName: targetLeader.username,
    password: targetLeader.password,
    rememberPassword: true
};

// 如果配置了 shared_secret，自动生成 2FA 验证码
if (targetLeader.shared_secret) {
    try {
        logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(targetLeader.shared_secret);
        console.log(`🔐 已自动生成 2FA 验证码`);
    } catch (e) {
        console.error(`❌ 生成 2FA 失败: ${e.message}`);
        console.error(`💡 提示: 请检查 shared_secret 格式是否正确`);
        process.exit(1);
    }
} else {
    console.log(`⚠️ 未配置 shared_secret，将请求手动输入验证码`);
}

client.logOn(logOnOptions);

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const fs = require('fs');

console.log("--- Leader 登录验证工具 ---\n");

// 读取配置
let config;
try {
    const rawContent = fs.readFileSync('./config.json', 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(rawContent);
} catch (e) {
    console.error("❌ 读取配置失败: " + e.message);
    process.exit(1);
}

if (!config.fleets || config.fleets.length === 0) {
    console.error("❌ 未找到车队配置");
    process.exit(1);
}

// 显示所有 Leader 列表
console.log(`📋 发现 ${config.fleets.length} 个车队:\n`);
config.fleets.forEach((fleet, idx) => {
    console.log(`   [${idx + 1}] ${fleet.id || 'fleet_' + (idx + 1)} - Leader: ${fleet.leader.username}`);
});

// 从命令行参数获取要登录的车队编号 (默认第一个)
const args = process.argv.slice(2);
let fleetIndex = 0;

if (args.length > 0) {
    const userInput = parseInt(args[0]);
    if (isNaN(userInput) || userInput < 1 || userInput > config.fleets.length) {
        console.error(`\n❌ 无效的车队编号: ${args[0]}`);
        console.log(`💡 用法: node login_leader.js [车队编号]`);
        console.log(`   例如: node login_leader.js 1   (登录第一个车队的 Leader)`);
        console.log(`   例如: node login_leader.js 2   (登录第二个车队的 Leader)\n`);
        process.exit(1);
    }
    fleetIndex = userInput - 1;
}

const leader = config.fleets[fleetIndex].leader;
const fleetId = config.fleets[fleetIndex].id || `fleet_${fleetIndex + 1}`;

console.log(`\n🎯 正在登录车队 [${fleetId}] 的 Leader: ${leader.username}\n`);

// [修改] 显式指定数据目录，确保凭证保存在本地
const client = new SteamUser({
    dataDirectory: "./steam_data"
});

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
    console.log(`[${leader.username}] 登录凭证 (Sentry File) 已自动保存到 ./steam_data 目录。`);
    console.log(`\n💡 提示: 如果您有多个车队，请继续运行：`);
    console.log(`   node login_leader.js 2   (登录第二个车队)`);
    console.log(`   node login_leader.js 3   (登录第三个车队)`);
    console.log(`\n➡️ 所有 Leader 都登录完成后，运行 'node index.js' 启动批量脚本。\n`);
    
    // 稍微等待一下以确保文件写入
    setTimeout(() => process.exit(0), 2000);
});

client.on('error', (err) => {
    console.error(`\n❌ 登录失败: ${err.message}`);
    if (err.eresult === 63 || err.eresult === 6) {
        console.log("👉 请在上方输入您的 Steam 令牌验证码 (Email 或 手机App) 并回车！");
    }
});


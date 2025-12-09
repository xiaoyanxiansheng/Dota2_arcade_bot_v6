/**
 * Steam 手机令牌绑定工具 (增强版)
 * 使用方法: node commands/enable_2fa_v2.js <用户名> <密码>
 */

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise(resolve => rl.question(prompt, resolve));
}

async function main() {
    const username = process.argv[2];
    const password = process.argv[3];

    if (!username || !password) {
        console.log('使用方法: node commands/enable_2fa_v2.js <用户名> <密码>');
        process.exit(1);
    }

    console.log(`\n🔐 Steam 手机令牌绑定工具 (v2)`);
    console.log(`📧 账号: ${username}`);
    console.log(`─────────────────────────────────────\n`);

    const client = new SteamUser();

    client.on('steamGuard', async (domain, callback) => {
        const code = await question(`📧 请输入邮箱验证码 (来自 ${domain}): `);
        callback(code);
    });

    client.on('loggedOn', async () => {
        console.log(`\n✅ 登录成功！SteamID: ${client.steamID}`);
        console.log(`🔄 正在尝试启用手机令牌...\n`);

        try {
            // 尝试获取现有状态
            const status = await new Promise((resolve) => {
                client.getSteamGuardDetails((err, enabled, timestamp, machineId, canEnable) => {
                    resolve({ err, enabled, timestamp, machineId, canEnable });
                });
            });
            
            console.log('📊 账号状态检查:');
            console.log(`   - 手机令牌已启用: ${status.enabled}`);
            console.log(`   - 可以启用: ${status.canEnable}`);
            
            if (status.enabled) {
                console.log('\n❌ 错误: Steam 返回显示手机令牌已经启用！');
                console.log('建议: 即使网页显示未启用，API 仍认为已启用。请尝试在网页再次"移除验证器"');
            }

            console.log('\n🚀 开始请求绑定...');

            // 使用更详细的选项
            client.enableTwoFactor((err, response) => {
                if (err) {
                    console.log(`\n❌ API 错误: ${err.message}`);
                    if (err.eresult) console.log(`   EResult: ${err.eresult}`);
                    process.exit(1);
                }

                if (response.status === 1) {
                    console.log(`\n${'═'.repeat(50)}`);
                    console.log(`✅ 成功获取 shared_secret！`);
                    console.log(`${'═'.repeat(50)}\n`);
                    
                    console.log(`shared_secret: ${response.shared_secret.toString('base64')}`);
                    console.log(`identity_secret: ${response.identity_secret.toString('base64')}`);
                    console.log(`revocation_code: ${response.revocation_code}`);
                    
                    // 保存逻辑...
                    const outputPath = path.join(__dirname, '..', 'data', `2fa_${username}.json`);
                    // ... (省略保存代码，同上)
                    
                    // 激活步骤
                    activate2FA(client, response);

                } else {
                    console.log(`\n❌ 启用失败 (状态码: ${response.status})`);
                    console.log(`完整响应:`, JSON.stringify(response, null, 2));
                    
                    if (response.status === 2) {
                        console.log('\n🔍 分析: 状态码 2 通常表示通用失败');
                        console.log('可能的深层原因:');
                        console.log('1. IP 风险: 当前 IP 被 Steam 标记');
                        console.log('2. 手机号限制: 该手机号近期绑定过其他账号');
                        console.log('3. Session 问题: 需要重新登录');
                    }
                    process.exit(1);
                }
            });

        } catch (err) {
            console.error(`\n❌ 错误: ${err.message}`);
            process.exit(1);
        }
    });

    client.on('error', (err) => {
        console.error(`\n❌ 登录错误: ${err.message}`);
        rl.close();
        process.exit(1);
    });

    console.log(`🔄 正在登录...`);
    client.logOn({
        accountName: username,
        password: password
    });
}

async function activate2FA(client, response) {
    // ... 激活逻辑
    const code = SteamTotp.generateAuthCode(response.shared_secret);
    console.log(`\n🔢 自动生成的激活码: ${code}`);
    
    const smsCode = await question(`\n📱 请输入短信验证码: `);
    
    client.finalizeTwoFactor(response.shared_secret, smsCode, (err) => {
        if (err) console.log(`❌ 激活失败: ${err.message}`);
        else console.log(`✅ 激活成功！`);
        process.exit(0);
    });
}

main();


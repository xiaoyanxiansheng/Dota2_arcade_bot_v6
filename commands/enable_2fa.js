/**
 * Steam 手机令牌绑定工具
 * 使用方法: node commands/enable_2fa.js <用户名> <密码>
 * 
 * 这个脚本会：
 * 1. 登录 Steam 账号
 * 2. 启用手机令牌（需要邮箱验证码）
 * 3. 输出 shared_secret，保存到配置文件即可
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
        console.log('使用方法: node commands/enable_2fa.js <用户名> <密码>');
        process.exit(1);
    }

    console.log(`\n🔐 Steam 手机令牌绑定工具`);
    console.log(`📧 账号: ${username}`);
    console.log(`─────────────────────────────────────\n`);

    const client = new SteamUser();

    // 监听邮箱验证码请求
    client.on('steamGuard', async (domain, callback) => {
        const code = await question(`📧 请输入邮箱验证码 (来自 ${domain}): `);
        callback(code);
    });

    // 登录成功
    client.on('loggedOn', async () => {
        console.log(`\n✅ 登录成功！SteamID: ${client.steamID}`);
        console.log(`🔄 正在启用手机令牌...\n`);

        try {
            // 启用两步验证
            const response = await new Promise((resolve, reject) => {
                client.enableTwoFactor((err, response) => {
                    if (err) reject(err);
                    else resolve(response);
                });
            });

            if (response.status === 1) {
                // 成功获取到 shared_secret
                console.log(`\n${'═'.repeat(50)}`);
                console.log(`✅ 手机令牌启用成功！`);
                console.log(`${'═'.repeat(50)}\n`);
                
                console.log(`📋 请保存以下信息：\n`);
                console.log(`shared_secret: ${response.shared_secret.toString('base64')}`);
                console.log(`identity_secret: ${response.identity_secret.toString('base64')}`);
                console.log(`revocation_code: ${response.revocation_code}`);
                console.log(`\n⚠️  重要：revocation_code 是恢复代码，请务必保存！\n`);

                // 保存到文件
                const secretData = {
                    username: username,
                    shared_secret: response.shared_secret.toString('base64'),
                    identity_secret: response.identity_secret.toString('base64'),
                    revocation_code: response.revocation_code,
                    created_at: new Date().toISOString()
                };

                const outputPath = path.join(__dirname, '..', 'data', `2fa_${username}.json`);
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, JSON.stringify(secretData, null, 2));
                console.log(`💾 已保存到: ${outputPath}`);

                // 需要确认激活
                console.log(`\n${'─'.repeat(50)}`);
                console.log(`📱 现在需要确认激活手机令牌`);
                console.log(`${'─'.repeat(50)}\n`);

                // 等待短信验证码（如果需要）或使用生成的验证码确认
                const smsCode = await question(`📱 请输入 Steam 发送的短信验证码 (或回车跳过): `);

                if (smsCode) {
                    const finalizeResponse = await new Promise((resolve, reject) => {
                        client.finalizeTwoFactor(response.shared_secret, smsCode, (err, res) => {
                            if (err) reject(err);
                            else resolve(res);
                        });
                    });
                    console.log(`\n✅ 手机令牌激活完成！`);
                } else {
                    // 使用 activationCode 确认
                    const generatedCode = SteamTotp.generateAuthCode(response.shared_secret);
                    console.log(`\n🔢 生成的验证码: ${generatedCode}`);
                    console.log(`请在 Steam 客户端或网页上使用此验证码完成激活`);
                }

            } else if (response.status === 2) {
                console.log(`\n❌ 启用失败 (状态码: 2)`);
                console.log(`\n完整响应信息：`);
                console.log(JSON.stringify(response, null, 2));
                console.log(`\n可能的原因：`);
                console.log(`  1. 账号未绑定手机号 - 请先在 Steam 设置中添加手机号`);
                console.log(`  2. 账号已有手机令牌 - 请先移除现有令牌`);
                console.log(`  3. 账号安全限制 - 新账号或最近更改过密码`);
                console.log(`  4. 刚绑定手机号需要等待一段时间（通常7天）`);
                console.log(`\n请检查 Steam 账户设置`);
            } else if (response.status === 84) {
                console.log(`\n⚠️ 操作太频繁，请稍后再试`);
            } else {
                console.log(`\n❌ 启用失败，状态码: ${response.status}`);
                console.log(response);
            }

        } catch (err) {
            console.error(`\n❌ 错误: ${err.message}`);
        }

        rl.close();
        client.logOff();
        setTimeout(() => process.exit(0), 1000);
    });

    // 错误处理
    client.on('error', (err) => {
        console.error(`\n❌ 登录错误: ${err.message}`);
        rl.close();
        process.exit(1);
    });

    // 开始登录
    console.log(`🔄 正在登录...`);
    client.logOn({
        accountName: username,
        password: password
    });
}

main().catch(console.error);


# Dota 2 Arcade Bot v6.0

自动化 Dota 2 自定义游戏房间创建和管理工具

## 📋 使用步骤

### 1. 安装依赖
```bash
npm install
```

### 2. 配置文件
（已经存在近1000小号）
```bash
编辑 `config/config.json`，填入账号信息和游戏设置
```

**多项目共享验证（可选）**
在 `config.json` 的 `global_settings` 中添加：
```json
"shared_steam_data_path": "../shared_steam_data"
```
多个项目使用相同 IP 时，只需验证一次主号

### 3. 准备代理（可选）
（已经存在近700个代理）
```bash
在 `data/proxies.txt` 中添加代理列表，格式：`ip:port:user:pass`
```

### 4. 运行工具

#### 测试代理
（可以定期运行看看哪些代理已经失效）
```bash
0-test_proxies.bat
```

#### 登录主号验证（必须首次验证）
（运行后填入验证码，后续短时间内不需要再次填入）
```bash
0-login_leader.bat
# 或命令行：0-login_leader.bat 1
```

#### 清理所有账号
（防止异常情况，账号还在线，或者在房间里，又再次登录进房间导致异常）
```bash
0-clear_all.bat
```

#### 启动机器人
```bash
1-1-start.bat          # 正常模式
1-2-start_debug.bat    # 调试模式
```

## 📁 重要文件

| 文件 | 说明 |
|------|------|
| `config/config.json` | 主配置文件 |
| `data/proxies.txt` | 代理列表 |
| `data/proxies_valid.txt` | 可用代理（自动生成） |
| `steam_data/` | Steam 登录凭证（自动生成，默认使用共享目录） |
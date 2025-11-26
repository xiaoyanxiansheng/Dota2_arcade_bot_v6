# Dota 2 挂机机器人

## 🚀 如何运行

### 1. 安装依赖
```bash
npm install
```

### 2. 配置账号 (config.json)

```json
{
  "global_settings": {
    "seeding_mode": true,
    "max_players_per_room": 4,
    "debug_mode": false
  },
  "fleets": [
    {
      "id": "fleet_1",
      "leader": {
        "username": "大号",
        "password": "密码",
        "shared_secret": ""
      },
      "followers": [
        { "username": "小号1", "password": "密码", "shared_secret": "" },
        { "username": "小号2", "password": "密码", "shared_secret": "" }
      ]
    }
  ]
}
```

### 3. 启动

```bash
# 第一次运行先登录大号（只用运行一次，凭证会保存在steam_data中）
node login_leader.js 1

# 启动脚本
node index.js
```

## ✅ 当前功能

- 1个大号持续创建房间，小号检测到后立即加入
- 小号按编号从小到大填满各个房间
- 大号检测到小号加入后自动离开创建下一个房间
- 支持多账号批量运行
- Steam Guard 验证 + 自动保存凭证

## 🔧 待完善

### 1. 密码房
- 现在无法创建密码房，容易被真实玩家加入导致游戏开始，小号失联
- 需要能创建密码房/或者不公开房间
- 房间名 #1 #2 #3 标记太明显，需要隐藏或改名

### 2. 多实例管理
- 手动启动多个脚本会冲突
- 需要实例间通信机制（文件锁或 Redis）

### 3. 掉线补救
- 掉线后自动重连
- 重连后进入未满房间

## 📝 消息ID

- 7044 - 加入房间
- 7047 - 设置队伍位置
- 7070 - 标记准备/接受匹配
- 7170 - 房主发起匹配通知
- 7113 - 加入房间响应
- 7469 - 可加入房间列表
- 7004 - Lobby快照

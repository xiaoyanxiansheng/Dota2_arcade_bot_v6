/**
 * 挂机车队独立程序 v3.0 - 分布式版本
 * 
 * 核心逻辑：
 * 1. 从 config_leaders.json 加载主号配置
 * 2. 从 config/farm/ 目录加载多个小号配置（config_000.json, config_001.json...）
 * 3. 串行处理每个配置：当前配置的小号全部进入房间后，切换到下一个配置
 * 4. 主号在开房间时使用当前配置的代理（按顺序分配）
 * 5. 支持手动跳过当前配置
 * 
 * 使用方法：
 * node src/farming.js
 */

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

// ============================================
// 项目根目录
// ============================================
const projectRoot = path.join(__dirname, '..');

// ============================================
// GC 消息 ID 定义
// ============================================
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgGCAbandonCurrentGame = 7035;
const k_EMsgGCPracticeLobbyCreate = 7038;
const k_EMsgGCPracticeLobbyLeave = 7040;
const k_EMsgGCPracticeLobbyJoin = 7044;
const k_EMsgGCPracticeLobbyJoinResponse = 7113;
const k_EMsgGCReadyUp = 7070;
const k_EMsgGCReadyUpStatus = 7170;
const k_EMsgGCPracticeLobbySetTeamSlot = 7047;
const k_EMsgProtoMask = 0x80000000;

// SOCache 消息 ID
const k_EMsgGCSOCacheSubscribed = 24;
const k_EMsgGCSOSingleObject = 25;
const k_EMsgGCSOMultipleObjects = 26;
const SOCACHE_TYPE_LOBBY = 2004;

// DOTAJoinLobbyResult 枚举
const DOTAJoinLobbyResult = {
    DOTA_JOIN_RESULT_SUCCESS: 0,
    DOTA_JOIN_RESULT_ALREADY_IN_GAME: 1,
    DOTA_JOIN_RESULT_INVALID_LOBBY: 2,
    DOTA_JOIN_RESULT_INCORRECT_PASSWORD: 3,
    DOTA_JOIN_RESULT_ACCESS_DENIED: 4,
    DOTA_JOIN_RESULT_GENERIC_ERROR: 5,
    DOTA_JOIN_RESULT_INCORRECT_VERSION: 6,
    DOTA_JOIN_RESULT_IN_TEAM_PARTY: 7,
    DOTA_JOIN_RESULT_NO_LOBBY_FOUND: 8,
    DOTA_JOIN_RESULT_LOBBY_FULL: 9,
    DOTA_JOIN_RESULT_CUSTOM_GAME_INCORRECT_VERSION: 10,
    DOTA_JOIN_RESULT_TIMEOUT: 11,
    DOTA_JOIN_RESULT_CUSTOM_GAME_COOLDOWN: 12,
    DOTA_JOIN_RESULT_BUSY: 13,
    DOTA_JOIN_RESULT_NO_PLAYTIME: 14
};

const JoinResultName = Object.entries(DOTAJoinLobbyResult).reduce((acc, [k, v]) => {
    acc[v] = k.replace('DOTA_JOIN_RESULT_', '');
    return acc;
}, {});

const DOTA_GC_TEAM = {
    DOTA_GC_TEAM_GOOD_GUYS: 0,
    DOTA_GC_TEAM_BAD_GUYS: 1,
    DOTA_GC_TEAM_SPECTATOR: 3,
    DOTA_GC_TEAM_PLAYER_POOL: 4
};

const DOTALobbyReadyState = {
    DOTALobbyReadyState_READY: 2
};

// ============================================
// Proto 定义加载
// ============================================
let CMsgClientHello, CMsgPracticeLobbyJoin, CMsgPracticeLobbyJoinResponse, CMsgPracticeLobbyCreate, 
    CMsgPracticeLobbySetDetails, CMsgPracticeLobbySetTeamSlot, CMsgReadyUp, CSODOTALobby;
let CMsgSOSingleObject, CMsgSOMultipleObjects, CMsgSOCacheSubscribed;

try {
    const root = new protobuf.Root();
    root.resolvePath = function(origin, target) {
        if (fs.existsSync(target)) return target;
        const pathInProtobufs = path.join(projectRoot, "Protobufs", target);
        if (fs.existsSync(pathInProtobufs)) return pathInProtobufs;
        const pathInDota2 = path.join(projectRoot, "Protobufs", "dota2", target);
        if (fs.existsSync(pathInDota2)) return pathInDota2;
        return target;
    };

    root.loadSync(path.join(projectRoot, "Protobufs/google/protobuf/descriptor.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/networkbasetypes.proto")); 
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/network_connection.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/steammessages.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/gcsdk_gcmessages.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_shared_enums.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_client_enums.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/base_gcmessages.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_gcmessages_common_lobby.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_gcmessages_client_match_management.proto"));
    root.loadSync(path.join(projectRoot, "Protobufs/dota2/dota_gcmessages_client.proto"));

    CMsgClientHello = root.lookupType("CMsgClientHello");
    CMsgPracticeLobbyJoin = root.lookupType("CMsgPracticeLobbyJoin");
    CMsgPracticeLobbyJoinResponse = root.lookupType("CMsgPracticeLobbyJoinResponse");
    CMsgPracticeLobbyCreate = root.lookupType("CMsgPracticeLobbyCreate");
    CMsgPracticeLobbySetDetails = root.lookupType("CMsgPracticeLobbySetDetails");
    CMsgPracticeLobbySetTeamSlot = root.lookupType("CMsgPracticeLobbySetTeamSlot");
    CMsgReadyUp = root.lookupType("CMsgReadyUp");
    CSODOTALobby = root.lookupType("CSODOTALobby");
    CMsgSOSingleObject = root.lookupType("CMsgSOSingleObject");
    CMsgSOMultipleObjects = root.lookupType("CMsgSOMultipleObjects");
    CMsgSOCacheSubscribed = root.lookupType("CMsgSOCacheSubscribed");
    
    console.log("[System] ✅ Proto 文件加载成功");
} catch (e) {
    console.error("❌ Proto 加载失败: " + e.message);
    process.exit(1);
}

function getHardwareSpecs() {
    return {
        logical_processors: 8,
        cpu_cycles_per_second: Long.fromNumber(3600000000),
        total_physical_memory: Long.fromNumber(17179869184),
        is_64_bit_os: true,
        upload_measurement: Long.fromNumber(10485760),
        prefer_not_host: false
    };
}

// ============================================
// 日志工具
// ============================================
function formatTime() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function logSection(title) {
    console.log('\n' + '═'.repeat(70));
    console.log(`║ ${title}`);
    console.log('═'.repeat(70));
}

function logInfo(category, message) {
    console.log(`[${formatTime()}] [${category}] ${message}`);
}

function logSuccess(category, message) {
    console.log(`[${formatTime()}] [${category}] ✅ ${message}`);
}

function logWarning(category, message) {
    console.log(`[${formatTime()}] [${category}] ⚠️ ${message}`);
}

function logError(category, message) {
    console.log(`[${formatTime()}] [${category}] ❌ ${message}`);
}

// ============================================
// 小号状态枚举
// ============================================
const FollowerState = {
    PENDING: 'PENDING',         // 1. 未创建（等待登录）
    LOGGING_IN: 'LOGGING_IN',   // 1.5 正在登录中
    IDLE: 'IDLE',               // 2. 创建未分配（已登录GC，在池子等待）
    ASSIGNED: 'ASSIGNED',       // 3. 创建已分配（已分配给房间，尝试加入中）
    IN_LOBBY: 'IN_LOBBY'        // 4. 创建进入房间（成功进入房间）
};

// ============================================
// FollowerPool - 小号池子
// ============================================
class FollowerPool {
    constructor(manager) {
        this.manager = manager;
        this.idle = [];          // 空闲小号（已登录GC，等待分配）
        this.assigned = new Map(); // lobbyId -> [小号Bot数组]
        this.failed = [];        // 失败的小号（待重试）
        this.all = [];           // 所有小号引用
    }

    // 添加小号到池子（状态2：创建未分配）
    addToIdle(follower) {
        if (!this.idle.includes(follower)) {
            this.idle.push(follower);
            follower.state = FollowerState.IDLE;
            // 每50个打印一次，避免日志太多
            if (this.idle.length % 50 === 0) {
                logInfo('Pool', `📥 池子小号: ${this.idle.length} 个`);
            }
        }
    }

    // 从池子取出N个小号分配给房间（状态2 → 状态3）
    assignToRoom(lobbyId, count) {
        const toAssign = this.idle.splice(0, Math.min(count, this.idle.length));
        
        if (toAssign.length === 0) {
            return [];
        }

        this.assigned.set(lobbyId.toString(), toAssign);
        
        toAssign.forEach(f => {
            f.state = FollowerState.ASSIGNED;
            f.assignedLobbyId = lobbyId;
        });

        logSuccess('Pool', `📤 分配 ${toAssign.length} 个小号 → 房间 ${lobbyId} (池子剩余: ${this.idle.length})`);
        return toAssign;
    }

    // 小号退出房间，回到池子（状态3/4 → 状态2）
    returnToPool(follower) {
        const prevState = follower.state;
        const prevLobby = follower.currentLobbyId || follower.assignedLobbyId;
        
        // 从已分配列表移除
        if (follower.assignedLobbyId) {
            const lobbyId = follower.assignedLobbyId.toString();
            const assigned = this.assigned.get(lobbyId);
            if (assigned) {
                const idx = assigned.indexOf(follower);
                if (idx >= 0) assigned.splice(idx, 1);
                if (assigned.length === 0) this.assigned.delete(lobbyId);
            }
            follower.assignedLobbyId = null;
        }

        // 回到空闲池
        follower.currentLobbyId = null;
        this.addToIdle(follower);
        
        logSuccess('Pool', `✅ ${follower.account.username} 已回到池子 (原房间: ${prevLobby || '无'})`);
    }

    // 获取统计信息
    getStats() {
        let inLobbyCount = 0;
        let assignedCount = 0;
        
        this.assigned.forEach(followers => {
            followers.forEach(f => {
                if (f.state === FollowerState.IN_LOBBY) inLobbyCount++;
                else assignedCount++;
            });
        });

        return {
            idle: this.idle.length,
            assigned: assignedCount,
            inLobby: inLobbyCount,
            failed: this.failed.length,
            total: this.all.length
        };
    }
}

// ============================================
// FollowerBot - 小号Bot
// ============================================
class FollowerBot {
    constructor(account, settings, proxies, pool) {
        this.account = account;
        this.settings = settings;
        this.proxies = proxies;
        this.pool = pool;
        
        this.state = FollowerState.PENDING;
        this.client = null;
        this.proxy = null;
        this.is_gc_connected = false;
        this.currentLobbyId = null;
        this.assignedLobbyId = null;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.ready_up_heartbeat = null;

        // CRC 数据
        this.knownCrc = "1396649696593898392";
        this.knownTimestamp = 1763646905;
    }

    // 选择随机代理
    selectRandomProxy() {
        if (this.proxies.length === 0) return null;
        return this.proxies[Math.floor(Math.random() * this.proxies.length)];
    }

    // 开始登录（状态1 → 登录中）
    start() {
        this.state = FollowerState.LOGGING_IN;
        this.proxy = this.selectRandomProxy();
        
        const sharedDataPath = this.settings.shared_steam_data_path || "../shared_steam_data";
        const steamDataDir = path.resolve(projectRoot, sharedDataPath);
        
        const steamOptions = { dataDirectory: steamDataDir };
        if (this.proxy) {
            steamOptions.httpProxy = this.proxy;
        }

        this.client = new SteamUser(steamOptions);
        this.setupListeners();
        
        const logOnOptions = {
            accountName: this.account.username,
            password: this.account.password,
            promptSteamGuardCode: false,
            rememberPassword: true,
            logonID: Math.floor(Math.random() * 1000000)
        };
        
        if (this.account.shared_secret && this.account.shared_secret.length > 5) {
            try { 
                logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(this.account.shared_secret); 
            } catch (err) {}
        }
        
        this.client.logOn(logOnOptions);
    }

    setupListeners() {
        this.client.on('loggedOn', () => {
            this.retryCount = 0;
            this.loggedInElsewhereRetry = 0;  // 登录成功，重置计数器
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
        });

        this.client.on('appLaunched', (appid) => {
            if (appid === this.settings.target_app_id) {
                setTimeout(() => this.connectGC(), 1000);
            }
        });

        this.client.on('error', (err) => {
            this.handleError(err);
        });

        this.client.on('receivedFromGC', (appid, msgType, payload) => {
            this.handleGCMessage(appid, msgType, payload);
        });
    }

    connectGC() {
        this.sendHello();
        const helloInterval = setInterval(() => { 
            if (!this.is_gc_connected) this.sendHello(); 
            else clearInterval(helloInterval);
        }, 5000);
    }

    sendHello() {
        try {
            const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
            const message = CMsgClientHello.create(payload);
            const buffer = CMsgClientHello.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    handleError(err) {
        const errorMessage = err.message || err.toString();
        
        // LoggedInElsewhere: 账号已在别处登录（可能是之前的请求延迟成功了）
        // 解决：销毁 client，等待 3 秒，然后重新创建并登录，直到成功
        if (errorMessage.includes('LoggedInElsewhere')) {
            this.loggedInElsewhereRetry = (this.loggedInElsewhereRetry || 0) + 1;
            
            // 只在第一次和每 5 次打印日志，避免刷屏
            if (this.loggedInElsewhereRetry === 1 || this.loggedInElsewhereRetry % 5 === 0) {
                logWarning('Follower', `${this.account.username} 账号已在别处登录 → 重建连接 (第${this.loggedInElsewhereRetry}次)`);
            }
            
            // 1. 销毁旧 client
            if (this.client) {
                try { this.client.removeAllListeners(); } catch (e) {}
                this.client = null;
            }
            this.is_gc_connected = false;
            this.state = FollowerState.PENDING;
            
            // 2. 等待 3 秒后重新开始登录（不走失败池，直接重试，直到成功）
            setTimeout(() => {
                if (!this.stopped) {
                    this.start();  // 重新创建 client 并登录
                }
            }, 3000);
            
            return;  // 不放入失败池，直接重试
        }
        
        // 重置 LoggedInElsewhere 计数器（其他错误说明连接状态已改变）
        this.loggedInElsewhereRetry = 0;
        
        // 其他错误：正常流程，放入失败池等待下次轮询
        this.cleanup();
        this.state = FollowerState.PENDING;
        
        if (!this.pool.failed.includes(this)) {
            this.pool.failed.push(this);
        }
        
        // 只打印非网络错误，避免日志刷屏
        if (!['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(err.code)) {
            logWarning('Follower', `${this.account.username} 登录失败: ${errorMessage} → 等待重试`);
        }
    }

    handleGCMessage(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!this.is_gc_connected) {
                this.is_gc_connected = true;
                // 清理残留状态
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                
                // 登录成功 → 进入池子（状态1→状态2）
                setTimeout(() => {
                    this.pool.addToIdle(this);
                }, 1000);
            }
        }
        else if (cleanMsgType === k_EMsgGCPracticeLobbyJoinResponse) {
            try {
                const response = CMsgPracticeLobbyJoinResponse.decode(payload);
                if (response.result === DOTAJoinLobbyResult.DOTA_JOIN_RESULT_SUCCESS) {
                    this.onJoinSuccess();
                } else {
                    this.onJoinFailed(JoinResultName[response.result] || response.result);
                }
            } catch(e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOCacheSubscribed) {
            try {
                const msg = CMsgSOCacheSubscribed.decode(payload);
                (msg.objects || []).forEach((typeObj) => {
                    if (typeObj.typeId === SOCACHE_TYPE_LOBBY) {
                        (typeObj.objectData || []).forEach((data) => {
                            this.processLobbyData(data);
                        });
                    }
                });
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOSingleObject) {
            try {
                const msg = CMsgSOSingleObject.decode(payload);
                if (msg.typeId === SOCACHE_TYPE_LOBBY) {
                    this.processLobbyData(msg.objectData);
                }
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOMultipleObjects) {
            try {
                const msg = CMsgSOMultipleObjects.decode(payload);
                [...(msg.objectsModified || []), ...(msg.objectsAdded || [])].forEach((obj) => {
                    if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                        this.processLobbyData(obj.objectData);
                    }
                });
                // 检查是否有对象被删除（房间解散）
                if (msg.objectsRemoved && msg.objectsRemoved.length > 0) {
                    msg.objectsRemoved.forEach(obj => {
                        if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                            this.onLobbyRemoved();
                        }
                    });
                }
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCReadyUpStatus) {
            setTimeout(() => this.sendReadyUp(), 200);
        }
    }

    processLobbyData(objectData) {
        if (!objectData || objectData.length === 0) {
            if (this.state === FollowerState.IN_LOBBY) {
                this.onLobbyRemoved();
            }
            return;
        }
        
        try {
            const lobby = CSODOTALobby.decode(objectData);
            if (lobby.lobbyId) {
                this.currentLobbyId = lobby.lobbyId;
                if (this.state === FollowerState.ASSIGNED) {
                    this.onJoinSuccess();
                }
            }
        } catch (e) {}
    }

    // 尝试加入分配的房间
    joinAssignedLobby() {
        if (this.stopped) return; // 已停止，不再操作
        if (!this.assignedLobbyId || this.state !== FollowerState.ASSIGNED) return;
        
        try {
            let lobbyIdLong = this.assignedLobbyId;
            if (typeof this.assignedLobbyId === 'string') {
                lobbyIdLong = Long.fromString(this.assignedLobbyId, true);
            }

            const payload = {
                lobbyId: lobbyIdLong,
                customGameCrc: Long.fromString(this.knownCrc, true),
                customGameTimestamp: this.knownTimestamp,
                passKey: this.settings.lobby_password
            };
            
            const message = CMsgPracticeLobbyJoin.create(payload);
            const buffer = CMsgPracticeLobbyJoin.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyJoin | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    onJoinSuccess() {
        // 加入成功（状态3 → 状态4）
        const prevState = this.state;
        this.state = FollowerState.IN_LOBBY;
        this.retryCount = 0;
        
        if (prevState === FollowerState.ASSIGNED) {
            logSuccess('Follower', `${this.account.username} 进入房间 ${this.assignedLobbyId}`);
        }
        
        // 设置队伍
        setTimeout(() => {
            const teamMsg = CMsgPracticeLobbySetTeamSlot.create({ team: DOTA_GC_TEAM.DOTA_GC_TEAM_GOOD_GUYS, slot: 0 });
            const teamBuf = CMsgPracticeLobbySetTeamSlot.encode(teamMsg).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbySetTeamSlot | k_EMsgProtoMask, {}, teamBuf);
            setTimeout(() => this.sendReadyUp(), 500);
        }, 500);

        // 心跳
        if (this.ready_up_heartbeat) clearInterval(this.ready_up_heartbeat);
        this.ready_up_heartbeat = setInterval(() => this.sendReadyUp(), 30000);
    }

    onJoinFailed(reason) {
        // 房间不存在或已满 → 只有这种情况才回到池子
        if (reason === 'NO_LOBBY_FOUND' || reason === 'INVALID_LOBBY') {
            logWarning('Follower', `${this.account.username} 加入失败: ${reason}（房间已解散）→ 回到池子`);
            this.pool.returnToPool(this);
            return;
        }
        
        if (reason === 'LOBBY_FULL') {
            logWarning('Follower', `${this.account.username} 加入失败: ${reason}（房间已满）→ 回到池子`);
            this.pool.returnToPool(this);
            return;
        }

        // 其他错误（网络问题等）→ 换IP继续尝试加入同一个房间
        this.retryCount++;
        logWarning('Follower', `${this.account.username} 加入失败: ${reason} → 换IP重试 (${this.retryCount})`);
        // 断开重连换IP，继续尝试加入同一个房间
        this.reconnectWithNewProxy();
    }

    reconnectWithNewProxy() {
        // 保留 assignedLobbyId，重连后继续加入同一个房间
        const savedLobbyId = this.assignedLobbyId;
        const savedState = this.state;
        
        this.cleanupForReconnect(); // 只断开连接，不清除分配信息
        this.proxy = this.selectRandomProxy();
        
        // 恢复分配信息
        this.assignedLobbyId = savedLobbyId;
        this.state = FollowerState.ASSIGNED; // 保持状态3
        
        setTimeout(() => this.startForReconnect(), 2000);
    }
    
    // 重连专用清理（不清除分配信息）
    cleanupForReconnect() {
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        this.is_gc_connected = false;
        
        try {
            if (this.client) {
                this.client.logOff();
            }
        } catch (err) {}
    }
    
    // 重连专用启动（GC连接后直接尝试加入房间）
    startForReconnect() {
        this.proxy = this.selectRandomProxy();
        
        const sharedDataPath = this.settings.shared_steam_data_path || "../shared_steam_data";
        const steamDataDir = path.resolve(projectRoot, sharedDataPath);
        
        const steamOptions = { dataDirectory: steamDataDir };
        if (this.proxy) {
            steamOptions.httpProxy = this.proxy;
        }

        this.client = new SteamUser(steamOptions);
        this.setupReconnectListeners(); // 使用重连专用监听器
        
        const logOnOptions = {
            accountName: this.account.username,
            password: this.account.password,
            promptSteamGuardCode: false,
            rememberPassword: true,
            logonID: Math.floor(Math.random() * 1000000)
        };
        
        if (this.account.shared_secret && this.account.shared_secret.length > 5) {
            try { 
                logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(this.account.shared_secret); 
            } catch (err) {}
        }
        
        this.client.logOn(logOnOptions);
    }
    
    // 重连专用监听器（GC连接后直接加入房间，不进池子）
    setupReconnectListeners() {
        this.client.on('loggedOn', () => {
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
        });

        this.client.on('appLaunched', (appid) => {
            if (appid === this.settings.target_app_id) {
                setTimeout(() => this.connectGCForReconnect(), 1000);
            }
        });

        this.client.on('error', (err) => {
            // 重连失败，继续重试
            if (!['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(err.code)) {
                logWarning('Follower', `${this.account.username} 重连失败: ${err.message} → 继续重试`);
            }
            this.cleanupForReconnect();
            setTimeout(() => this.startForReconnect(), 3000);
        });

        this.client.on('receivedFromGC', (appid, msgType, payload) => {
            this.handleGCMessageForReconnect(appid, msgType, payload);
        });
    }
    
    connectGCForReconnect() {
        this.sendHello();
        const helloInterval = setInterval(() => { 
            if (!this.is_gc_connected) this.sendHello(); 
            else clearInterval(helloInterval);
        }, 5000);
    }
    
    handleGCMessageForReconnect(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!this.is_gc_connected) {
                this.is_gc_connected = true;
                // 清理残留状态
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                
                // 直接尝试加入分配的房间（不进池子）
                setTimeout(() => {
                    if (this.assignedLobbyId) {
                        this.joinAssignedLobby();
                    }
                }, 1000);
            }
        }
        // 复用其他消息处理
        else {
            this.handleGCMessage(appid, msgType, payload);
        }
    }

    onLobbyRemoved() {
        // 房间解散 → 回到池子（状态4 → 状态2）
        const lobbyId = this.currentLobbyId?.toString() || 'unknown';
        logInfo('Follower', `${this.account.username} 收到房间解散通知 (房间: ${lobbyId})`);
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        this.pool.returnToPool(this);
    }
    
    // 主动退出房间（用于展示车队轮换时解散）
    leaveLobbyForDissolve() {
        if (this.state !== FollowerState.IN_LOBBY) {
            logWarning('Follower', `${this.account.username} 不在房间中，无需退出`);
            return;
        }
        
        const lobbyId = this.currentLobbyId?.toString() || 'unknown';
        logInfo('Follower', `${this.account.username} 主动退出房间 ${lobbyId}...`);
        
        try {
            // 发送退出房间消息
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        } catch (err) {
            logWarning('Follower', `${this.account.username} 发送退出消息失败: ${err.message}`);
        }
        
        // 兜底机制：5秒后检查是否还在房间内，如果GC没通知则手动回池
        setTimeout(() => {
            if (this.state === FollowerState.IN_LOBBY && this.currentLobbyId?.toString() === lobbyId) {
                logWarning('Follower', `${this.account.username} 未收到GC通知，手动回池`);
                this.onLobbyRemoved();
            }
        }, 5000);
    }

    sendReadyUp() {
        try {
            const payload = {
                state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                hardware_specs: getHardwareSpecs()
            };
            if (this.currentLobbyId) payload.ready_up_key = this.currentLobbyId;
            const message = CMsgReadyUp.create(payload);
            const buffer = CMsgReadyUp.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    cleanup() {
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        
        // 标记为已停止，阻止后续操作
        this.stopped = true;
        this.is_gc_connected = false;
        
        try {
            if (this.client) {
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                // 延迟 logOff，确保消息发送出去
                setTimeout(() => {
                    try { this.client.logOff(); } catch (e) {}
                }, 500);
            }
        } catch (err) {}
    }
}

// ============================================
// LeaderBot - 主号Bot
// ============================================
class LeaderBot {
    constructor(account, settings, proxy, pool) {
        this.account = account;
        this.settings = settings;
        this.proxy = proxy;
        this.pool = pool;
        
        this.client = null;
        this.is_gc_connected = false;
        this.currentLobbyId = null;
        this.lastLeftLobbyId = null; // 上一个离开的房间ID，用于忽略旧房间的更新
        this.currentRoomMemberCount = 0;
        this.roomsCreated = 0;
        this.seedingThreshold = settings.seeding_threshold || 5;
        this.ready_up_heartbeat = null;
        this.state = 'OFFLINE';
        this.leaveScheduled = false; // 是否已安排离开

        // CRC 数据
        this.knownCrc = "1396649696593898392";
        this.knownTimestamp = 1763646905;
    }

    log(msg) {
        console.log(`[${formatTime()}] [挂机主号|${this.account.username}] ${msg}`);
    }

    start() {
        this.state = 'LOGGING_IN';
        this.log(`🔐 开始登录...`);
        if (this.proxy) {
            this.log(`   代理: ${this.proxy.replace(/:[^:@]+@/, ':***@')}`);
        }
        
        const sharedDataPath = this.settings.shared_steam_data_path || "../shared_steam_data";
        const steamDataDir = path.resolve(projectRoot, sharedDataPath);
        
        const steamOptions = { dataDirectory: steamDataDir };
        if (this.proxy) {
            steamOptions.httpProxy = this.proxy;
        }

        this.client = new SteamUser(steamOptions);
        this.setupListeners();
        
        const logOnOptions = {
            accountName: this.account.username,
            password: this.account.password,
            promptSteamGuardCode: false,
            rememberPassword: true,
            logonID: Math.floor(Math.random() * 1000000)
        };
        
        if (this.account.shared_secret && this.account.shared_secret.length > 5) {
            try { 
                logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(this.account.shared_secret); 
            } catch (err) {}
        }
        
        this.client.logOn(logOnOptions);
    }

    setupListeners() {
        this.client.on('loggedOn', () => {
            this.log('✅ Steam 登录成功');
            this.client.setPersona(SteamUser.EPersonaState.Online);
            this.client.gamesPlayed([this.settings.target_app_id]);
        });

        this.client.on('appLaunched', (appid) => {
            if (appid === this.settings.target_app_id) {
                this.log('🎮 Dota 2 启动');
                setTimeout(() => this.connectGC(), 2000);
            }
        });

        this.client.on('error', (err) => {
            this.log(`❌ Steam 错误: ${err.message}，5秒后重试...`);
            this.cleanup();
            setTimeout(() => this.start(), 5000);
        });

        this.client.on('receivedFromGC', (appid, msgType, payload) => {
            this.handleGCMessage(appid, msgType, payload);
        });
    }

    connectGC() {
        this.log('📡 连接 GC...');
        this.sendHello();
        const helloInterval = setInterval(() => { 
            if (!this.is_gc_connected) this.sendHello(); 
            else clearInterval(helloInterval);
        }, 5000);
    }

    sendHello() {
        try {
            const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
            const message = CMsgClientHello.create(payload);
            const buffer = CMsgClientHello.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    handleGCMessage(appid, msgType, payload) {
        if (appid !== this.settings.target_app_id) return;
        const cleanMsgType = msgType & ~k_EMsgProtoMask;

        if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
            if (!this.is_gc_connected) {
                this.is_gc_connected = true;
                this.log('✅ GC 连接成功');
                // 清理残留
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                setTimeout(() => this.createRoom(), 1000); // 优化：1.5s → 1s
            }
        }
        else if (cleanMsgType === k_EMsgGCSOCacheSubscribed) {
            try {
                const msg = CMsgSOCacheSubscribed.decode(payload);
                (msg.objects || []).forEach((typeObj) => {
                    if (typeObj.typeId === SOCACHE_TYPE_LOBBY) {
                        (typeObj.objectData || []).forEach((data) => {
                            this.processLobbyData(data);
                        });
                    }
                });
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOSingleObject) {
            try {
                const msg = CMsgSOSingleObject.decode(payload);
                if (msg.typeId === SOCACHE_TYPE_LOBBY) {
                    this.processLobbyData(msg.objectData);
                }
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCSOMultipleObjects) {
            try {
                const msg = CMsgSOMultipleObjects.decode(payload);
                [...(msg.objectsModified || []), ...(msg.objectsAdded || [])].forEach((obj) => {
                    if (obj.typeId === SOCACHE_TYPE_LOBBY) {
                        this.processLobbyData(obj.objectData);
                    }
                });
            } catch (e) {}
        }
        else if (cleanMsgType === k_EMsgGCReadyUpStatus) {
            setTimeout(() => this.sendReadyUp(), 200);
        }
    }

    processLobbyData(objectData) {
        if (!objectData || objectData.length === 0) return;
        
        try {
            const lobby = CSODOTALobby.decode(objectData);
            const lobbyId = lobby.lobbyId;
            const memberCount = (lobby.allMembers || []).length;
            
            if (lobbyId) {
                // 忽略已离开房间的更新（防止把旧房间当成新房间）
                if (this.lastLeftLobbyId && lobbyId.toString() === this.lastLeftLobbyId.toString()) {
                    return;
                }
                
                // 首次收到房间信息 - 房间创建成功
                if (!this.currentLobbyId && this.state === 'CREATING') {
                    this.currentLobbyId = lobbyId;
                    this.currentRoomMemberCount = memberCount;
                    this.state = 'SEEDING';
                    logSuccess('主号', `房间 #${this.roomsCreated} 创建成功: ${lobbyId.toString()}`);
                    
                    // 从池子分配小号给这个房间
                    this.assignFollowersToRoom(lobbyId);
                }
                
                // 只处理当前房间的更新
                if (this.currentLobbyId && lobbyId.toString() === this.currentLobbyId.toString()) {
                    // 更新房间人数
                    this.currentRoomMemberCount = memberCount;
                    
                    // 人数达标立即离开创建新房间
                    if (this.state === 'SEEDING' && memberCount >= this.seedingThreshold) {
                        this.leaveAndCreateNew();
                    }
                }
            }
        } catch (e) {}
    }

    createRoom(isRetry = false) {
        if (this.stopped) return; // 已停止，不再操作
        
        // 只有非重试时才增加序号
        if (!isRetry) {
            this.roomsCreated++;
        }
        
        this.state = 'CREATING';
        this.currentLobbyId = null; // 重置
        // 注意：不清除 lastLeftLobbyId，保留它用于过滤旧房间的延迟消息
        this.leaveScheduled = false; // 重置离开标记
        
        const currentRoomNum = this.roomsCreated; // 记录当前房间号用于超时检测
        this.log(`🏭 创建房间 #${this.roomsCreated}${isRetry ? ' (重试)' : ''}...`);
        
        try {
            const gameIdLong = Long.fromString(this.settings.custom_game_id, true);
            const regions = this.settings.server_regions || [19];
            const selectedRegion = regions[Math.floor(Math.random() * regions.length)];
            
            const detailsPayload = {
                customGameId: gameIdLong,        
                gameName: "",
                serverRegion: selectedRegion, 
                gameMode: 15,                    
                customMaxPlayers: (this.settings.max_players_per_room || 24) - 1, // 最多 max-1 人，防止满员解散
                customMinPlayers: 1,
                allowSpectating: true,
                allchat: true,
                fillWithBots: false,
                allowCheats: false,
                visibility: 0,
                passKey: this.settings.lobby_password,
                customMapName: "zudui_team_map",
                customGameCrc: Long.fromString(this.knownCrc, true),
                customGameTimestamp: this.knownTimestamp
            };
            const lobbyDetails = CMsgPracticeLobbySetDetails.create(detailsPayload);

            const createPayload = {
                searchKey: "",
                passKey: this.settings.lobby_password,
                clientVersion: 0,
                lobbyDetails: lobbyDetails
            };

            const message = CMsgPracticeLobbyCreate.create(createPayload);
            const buffer = CMsgPracticeLobbyCreate.encode(message).finish();
            
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyCreate | k_EMsgProtoMask, {}, buffer);
            
            // 激活心跳
            let heartbeats = 0;
            const activationInterval = setInterval(() => {
                if (this.state === 'CREATING' || this.state === 'SEEDING') {
                    this.sendReadyUp();
                    heartbeats++;
                    if (heartbeats >= 5) clearInterval(activationInterval);
                } else {
                    clearInterval(activationInterval);
                }
            }, 1000);

            // 创建超时重试（只有当前房间号没变且还在创建状态时才重试）
            setTimeout(() => {
                if (this.state === 'CREATING' && !this.currentLobbyId && this.roomsCreated === currentRoomNum) {
                    this.log('⚠️ 房间创建超时，重试...');
                    this.createRoom(true); // 标记为重试，不增加序号
                }
            }, 30000); // 30秒超时

        } catch (err) {
            this.log(`❌ 创建房间失败: ${err.message}，3秒后重试`);
            setTimeout(() => this.createRoom(true), 3000); // 优化：5s → 3s
        }
    }

    assignFollowersToRoom(lobbyId) {
        if (this.stopped) return; // 已停止，不再操作
        
        // 从池子取 (max_players - 2) 个小号
        // max_players_per_room - 1 = 房间实际最大人数（防止满员解散）
        // 再 -1 = 主号占1个位置
        const maxFollowers = (this.settings.max_players_per_room || 24) - 2;
        const followers = this.pool.assignToRoom(lobbyId, maxFollowers);
        
        if (followers.length === 0) {
            this.log(`⏳ 池子为空，等待小号登录... (1分钟后重试)`);
            // 等待后重试
            setTimeout(() => {
                if (this.currentLobbyId && this.state === 'SEEDING' && !this.stopped) {
                    this.assignFollowersToRoom(lobbyId);
                }
            }, 60000); // 1分钟
            return;
        }

        // 打印分配信息（包括是否不足）
        if (followers.length < maxFollowers) {
            logInfo('主号', `🚀 分配 ${followers.length}/${maxFollowers} 个小号 → 房间 #${this.roomsCreated} (池子不足)`);
        } else {
            logInfo('主号', `🚀 分配 ${followers.length} 个小号 → 房间 #${this.roomsCreated}`);
        }
        
        // 一批启动加入（间隔100ms）
        let joinedCount = 0;
        followers.forEach((follower, idx) => {
            setTimeout(() => {
                if (follower.state === FollowerState.ASSIGNED && follower.is_gc_connected) {
                    follower.joinAssignedLobby();
                    joinedCount++;
                } else if (follower.state === FollowerState.ASSIGNED && !follower.is_gc_connected) {
                    // GC未连接，等待连接后自动加入
                    // 在 setupListeners 中已处理
                }
            }, idx * 100);
        });
    }

    leaveAndCreateNew() {
        if (this.stopped) return; // 已停止，不再操作
        
        this.log(`🚪 离开房间 #${this.roomsCreated}，准备创建新房间...`);
        this.leaveLobby();
        setTimeout(() => {
            if (this.state !== 'ABANDONED' && !this.stopped) {
                this.createRoom(false); // 新房间，增加序号
            }
        }, 1000); // 优化：2s → 1s
    }

    leaveLobby() {
        try {
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        } catch (err) {}
        
        // 记录离开的房间ID，用于忽略后续的旧房间更新
        this.lastLeftLobbyId = this.currentLobbyId;
        this.currentLobbyId = null;
        this.state = 'ONLINE';
        
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
    }

    sendReadyUp() {
        try {
            const payload = {
                state: DOTALobbyReadyState.DOTALobbyReadyState_READY,
                hardware_specs: getHardwareSpecs()
            };
            if (this.currentLobbyId) payload.ready_up_key = this.currentLobbyId;
            const message = CMsgReadyUp.create(payload);
            const buffer = CMsgReadyUp.encode(message).finish();
            this.client.sendToGC(this.settings.target_app_id, k_EMsgGCReadyUp | k_EMsgProtoMask, {}, buffer);
        } catch (err) {}
    }

    // 换代理重连（用于配置切换时）
    reconnectWithNewProxy(newProxy) {
        this.log(`🔄 切换代理重连...`);
        
        // 先离开当前房间
        if (this.currentLobbyId) {
            this.leaveLobby();
        }
        
        // 清理当前连接
        if (this.ready_up_heartbeat) {
            clearInterval(this.ready_up_heartbeat);
            this.ready_up_heartbeat = null;
        }
        this.is_gc_connected = false;
        this.stopped = false; // 重置停止标记
        
        try {
            if (this.client) {
                this.client.logOff();
                this.client.removeAllListeners();
                this.client = null;
            }
        } catch (err) {}
        
        // 使用新代理
        this.proxy = newProxy;
        this.state = 'OFFLINE';
        
        // 延迟后重新启动
        setTimeout(() => {
            this.start();
        }, 2000);
    }

    cleanup() {
        if (this.ready_up_heartbeat) clearInterval(this.ready_up_heartbeat);
        
        // 标记为已停止，阻止后续操作
        this.stopped = true;
        this.is_gc_connected = false;
        
        try {
            if (this.client) {
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
                this.client.sendToGC(this.settings.target_app_id, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
                // 延迟 logOff，确保消息发送出去
                setTimeout(() => {
                    try { this.client.logOff(); } catch (e) {}
                }, 500);
            }
        } catch (err) {}
    }
}

// ============================================
// FarmingManager - 挂机车队管理器 v3.0 (分布式版本) v3.0 (分布式版本)
// ============================================
class FarmingManager {
    constructor(leadersConfig, farmConfigNames) {
        this.settings = leadersConfig.global_settings;
        this.leadersConfig = leadersConfig.leaders || [];
        this.farmConfigNames = farmConfigNames; // ['config_000', 'config_001', ...]
        
        // 当前配置状态
        this.currentConfigIndex = 0;
        this.currentConfigName = null;
        this.currentConfig = null;
        this.currentProxies = [];
        
        // 时间统计
        this.startTime = null;       // 总运行开始时间
        this.configStartTime = null; // 当前配置开始时间
        
        // Bot管理
        this.pool = new FollowerPool(this);
        this.leaders = [];
        this.currentFollowers = [];  // 当前配置的小号
        
        // 统计
        this.totalRoomsCreated = 0;
        this.configStats = {};       // 每个配置的统计
        
        // 登录参数
        this.loginInterval = 100;    // 每个小号间隔100ms
        this.retryInterval = 60000;  // 失败重试间隔60秒
        this.retryTimer = null;
        
        // 完成检查
        this.completeCheckTimer = null;
    }

    start() {
        this.startTime = Date.now();
        
        logSection('Dota2 挂机车队 v3.0 (分布式版本)');
        logInfo('System', `模式: 分布式串行处理`);
        logInfo('System', `游戏ID: ${this.settings.custom_game_id}`);
        logInfo('System', `房间密码: ${this.settings.lobby_password}`);
        logInfo('System', `Seeding阈值: ${this.settings.seeding_threshold || 5} 人`);
        logInfo('System', `每房间最大人数: ${this.settings.max_players_per_room || 24} 人`);
        logInfo('System', `主号数量: ${this.leadersConfig.length} 个`);
        logInfo('System', `配置数量: ${this.farmConfigNames.length} 个`);
        
        // 列出所有配置
        this.farmConfigNames.forEach((name, idx) => {
            logInfo('System', `   ${idx + 1}. ${name}`);
        });
        
        // 创建主号Bot（但此时不启动，等加载配置后再启动）
        this.leadersConfig.forEach((leaderAccount, idx) => {
            const leaderBot = new LeaderBot(
                leaderAccount,
                this.settings,
                null,  // 代理稍后设置
                this.pool
            );
            leaderBot.leaderIndex = idx;
            this.leaders.push(leaderBot);
            logInfo('Leaders', `主号 ${idx + 1}: ${leaderAccount.username}`);
        });
        
        // 加载第一个配置
        this.loadNextConfig();
    }

    loadNextConfig() {
        // 清理上一个配置的小号
        this.cleanupCurrentFollowers();
        
        if (this.currentConfigIndex >= this.farmConfigNames.length) {
            logSection('所有配置处理完成');
            const totalElapsed = this.startTime ? Math.round((Date.now() - this.startTime) / 1000 / 60) : 0;
            logSuccess('Farming', `✅ 全部 ${this.farmConfigNames.length} 个配置处理完成，总耗时 ${totalElapsed} 分钟`);
            logInfo('Farming', `   总创建房间: ${this.totalRoomsCreated} 个`);
            return;
        }
        
        const configName = this.farmConfigNames[this.currentConfigIndex];
        this.currentConfigName = configName;
        this.configStartTime = Date.now();
        
        logSection(`开始处理配置: ${configName} (${this.currentConfigIndex + 1}/${this.farmConfigNames.length})`);
        
        // 加载配置目录（新格式：目录下有 followers.txt 和 proxies.txt）
        try {
            const configDir = path.join(projectRoot, 'config', 'farm', configName);
            
            // 读取 followers.txt（格式：用户名,密码）
            const followersPath = path.join(configDir, 'followers.txt');
            const followersContent = fs.readFileSync(followersPath, 'utf8').replace(/^\uFEFF/, '');
            const followers = followersContent
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && line.includes(','))
                .map(line => {
                    const [username, password] = line.split(',');
                    return { username: username.trim(), password: password.trim() };
                });
            
            // 读取 proxies.txt（每行一个代理）
            const proxiesPath = path.join(configDir, 'proxies.txt');
            let proxies = [];
            if (fs.existsSync(proxiesPath)) {
                const proxiesContent = fs.readFileSync(proxiesPath, 'utf8').replace(/^\uFEFF/, '');
                proxies = proxiesContent
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0);
            }
            
            this.currentConfig = { followers, proxies };
            this.currentProxies = proxies;
            
            logInfo(configName, `小号数量: ${followers.length} 个`);
            logInfo(configName, `代理数量: ${proxies.length} 个`);
        } catch (e) {
            logError('System', `加载配置失败: ${configName} - ${e.message}`);
            this.currentConfigIndex++;
            setTimeout(() => this.loadNextConfig(), 1000);
            return;
        }
        
        // 更新主号代理并启动/重连
        this.updateLeadersForNewConfig();
        
        // 创建当前配置的小号Bot
        this.createFollowerBots(this.currentConfig.followers || []);
        
        // 开始登录小号
        this.startSequentialLogin();
        
        // 启动完成检查定时器
        this.startCompleteCheck();
    }

    updateLeadersForNewConfig() {
        logInfo('Leaders', `更新主号代理 (使用 ${this.currentConfigName} 的代理)...`);
        
        this.leaders.forEach((leader, idx) => {
            const proxy = this.currentProxies[idx] || null;
            const proxyDisplay = proxy ? proxy.replace(/:[^:@]+@/, ':***@') : '无';
            
            if (leader.state === 'OFFLINE' || !leader.is_gc_connected) {
                // 首次启动
                leader.proxy = proxy;
                logInfo('Leaders', `   主号 ${idx + 1} (${leader.account.username}) 代理: ${proxyDisplay}`);
                leader.start();
            } else {
                // 已在运行，需要重连换代理
                logInfo('Leaders', `   主号 ${idx + 1} (${leader.account.username}) 换代理重连: ${proxyDisplay}`);
                leader.reconnectWithNewProxy(proxy);
            }
        });
    }

    createFollowerBots(followers) {
        this.currentFollowers = [];
        this.pool.idle = [];
        this.pool.assigned.clear();
        this.pool.failed = [];
        this.pool.all = [];
        
        followers.forEach(acc => {
            const bot = new FollowerBot(acc, this.settings, this.currentProxies, this.pool);
            this.currentFollowers.push(bot);
            this.pool.all.push(bot);
        });
        
        logInfo(this.currentConfigName, `创建 ${this.currentFollowers.length} 个小号Bot`);
    }

    cleanupCurrentFollowers() {
        // 不清理小号，让已登录的继续留着，只切换到新配置
        if (this.currentFollowers.length > 0) {
            logInfo('Farming', `切换配置，${this.currentFollowers.length} 个小号保持运行`);
            this.currentFollowers = [];
        }
        
        // 清空池子引用（新配置会创建新的）
        this.pool.idle = [];
        this.pool.failed = [];
        this.pool.assigned.clear();
        
        // 停止重试定时器
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    startSequentialLogin() {
        logInfo(this.currentConfigName, '📦 开始依次登录小号...');
        
        let index = 0;
        const total = this.currentFollowers.length;
        
        const loginNext = () => {
            if (index >= total) {
                logSuccess(this.currentConfigName, `全部 ${total} 个小号已启动登录`);
                // 启动失败重试轮询
                this.retryTimer = setTimeout(() => this.retryFailedLogins(), this.retryInterval);
                return;
            }

            const bot = this.currentFollowers[index];
            if (bot.state === FollowerState.PENDING) {
                bot.start();
            }
            
            index++;
            
            // 每100个打印一次进度
            if (index % 100 === 0) {
                logInfo(this.currentConfigName, `📦 登录进度: ${index}/${total}`);
            }
            
            // 下一个
            setTimeout(loginNext, this.loginInterval);
        };

        loginNext();
    }

    retryFailedLogins() {
        // 收集失败的小号
        const failed = this.pool.failed.filter(f => 
            f.state === FollowerState.PENDING || f.state === FollowerState.FAILED
        );
        
        if (failed.length > 0) {
            logInfo(this.currentConfigName, `🔄 发现 ${failed.length} 个失败小号，开始重试...`);
            
            // 从失败列表移除
            this.pool.failed = this.pool.failed.filter(f => 
                f.state !== FollowerState.PENDING && f.state !== FollowerState.FAILED
            );
            
            // 依次重试
            failed.forEach((bot, idx) => {
                bot.retryCount = 0;
                bot.state = FollowerState.PENDING;
                setTimeout(() => bot.start(), idx * this.loginInterval);
            });
        }

        // 继续定期检查
        this.retryTimer = setTimeout(() => this.retryFailedLogins(), this.retryInterval);
    }

    startCompleteCheck() {
        // 停止之前的检查
        if (this.completeCheckTimer) {
            clearInterval(this.completeCheckTimer);
        }
        
        // 每5秒检查一次是否完成
        this.completeCheckTimer = setInterval(() => {
            this.checkConfigComplete();
        }, 5000);
    }

    checkConfigComplete() {
        const poolStats = this.pool.getStats();
        
        // 完成条件：池子空了且没有正在加入的小号
        // 即所有小号都已进入房间
        if (poolStats.idle === 0 && poolStats.assigned === 0 && poolStats.inLobby > 0) {
            // 记录统计
            const elapsed = this.configStartTime ? Math.round((Date.now() - this.configStartTime) / 1000 / 60) : 0;
            let configRooms = 0;
            this.leaders.forEach(l => configRooms += l.roomsCreated || 0);
            
            this.configStats[this.currentConfigName] = {
                followers: poolStats.inLobby,
                rooms: configRooms - this.totalRoomsCreated,
                elapsed
            };
            this.totalRoomsCreated = configRooms;
            
            logSuccess(this.currentConfigName, `✅ 配置处理完成！`);
            logInfo(this.currentConfigName, `   小号: ${poolStats.inLobby} 个已进入房间`);
            logInfo(this.currentConfigName, `   耗时: ${elapsed} 分钟`);
            
            // 停止检查定时器
            if (this.completeCheckTimer) {
                clearInterval(this.completeCheckTimer);
                this.completeCheckTimer = null;
            }
            
            // 切换到下一个配置
            this.currentConfigIndex++;
            setTimeout(() => this.loadNextConfig(), 2000);
        }
    }

    skipCurrentConfig() {
        logWarning('Farming', `⏭️ 跳过当前配置: ${this.currentConfigName}`);
        
        const poolStats = this.pool.getStats();
        const elapsed = this.configStartTime ? Math.round((Date.now() - this.configStartTime) / 1000 / 60) : 0;
        
        this.configStats[this.currentConfigName] = {
            followers: poolStats.inLobby,
            rooms: 0,
            elapsed,
            skipped: true
        };
        
        // 停止检查定时器
        if (this.completeCheckTimer) {
            clearInterval(this.completeCheckTimer);
            this.completeCheckTimer = null;
        }
        
        // 切换到下一个配置
        this.currentConfigIndex++;
        setTimeout(() => this.loadNextConfig(), 1000);
    }

    getStats() {
        const poolStats = this.pool.getStats();
        let leadersActive = 0;
        let roomsCreated = 0;

        this.leaders.forEach(leader => {
            if (leader.state === 'SEEDING' || leader.currentLobbyId) leadersActive++;
            roomsCreated += leader.roomsCreated || 0;
        });

        const totalElapsed = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
        const configElapsed = this.configStartTime ? Math.round((Date.now() - this.configStartTime) / 1000) : 0;

        return {
            // 当前配置进度
            currentConfig: this.currentConfigName,
            currentConfigIndex: this.currentConfigIndex,
            totalConfigs: this.farmConfigNames.length,
            configProgress: poolStats.inLobby,
            configTotal: poolStats.total,
            configElapsed,           // 当前配置运行秒数
            
            // 总体进度
            roomsCreated,            // 已创建房间数
            leadersActive,           // 活跃主号数
            poolIdle: poolStats.idle,
            assigned: poolStats.assigned,
            inLobby: poolStats.inLobby,
            failed: poolStats.failed,
            total: poolStats.total,
            totalElapsed             // 总运行秒数
        };
    }

    // 解散指定房间（让在这些房间中的小号退出）
    dissolveRooms(roomIds) {
        if (!roomIds || roomIds.length === 0) {
            logWarning('System', '解散房间: 没有收到有效的房间ID');
            return;
        }
        
        const roomIdSet = new Set(roomIds.map(id => id.toString()));
        let matchedCount = 0;
        
        // 统计当前小号在各房间的分布
        const roomStats = {};
        this.currentFollowers.forEach(follower => {
            const lobbyId = follower.currentLobbyId?.toString();
            if (lobbyId) {
                roomStats[lobbyId] = (roomStats[lobbyId] || 0) + 1;
            }
        });
        
        logInfo('System', `当前小号房间分布: ${Object.keys(roomStats).length} 个房间`);
        
        // 检查每个要解散的房间
        roomIds.forEach(roomId => {
            const idStr = roomId.toString();
            const count = roomStats[idStr] || 0;
            logInfo('System', `   房间 ${idStr}: ${count} 个小号 ${count > 0 ? '→ 匹配!' : '→ 无小号'}`);
        });
        
        // 遍历所有小号，检查是否在要解散的房间中
        this.currentFollowers.forEach(follower => {
            const followerLobbyId = follower.currentLobbyId?.toString();
            
            if (followerLobbyId && roomIdSet.has(followerLobbyId)) {
                matchedCount++;
                logInfo('Follower', `${follower.account.username} 在房间 ${followerLobbyId} 中，执行退出...`);
                
                // 让小号主动退出房间
                follower.leaveLobbyForDissolve();
            }
        });
        
        logSuccess('System', `解散房间执行完成: 共 ${matchedCount} 个小号被要求退出`);
    }
    
    cleanup() {
        logInfo('Farming', '🧹 清理资源...');
        
        // 停止定时器
        if (this.retryTimer) clearTimeout(this.retryTimer);
        if (this.completeCheckTimer) clearInterval(this.completeCheckTimer);
        
        this.leaders.forEach(bot => bot.cleanup());
        this.currentFollowers.forEach(bot => bot.cleanup());
        
        logSuccess('Farming', '挂机车队已停止');
    }
}

// ============================================
// 扫描 farm 配置目录（新格式：每个配置是一个目录）
// ============================================
function scanFarmConfigs() {
    const farmDir = path.join(projectRoot, 'config', 'farm');
    const configs = [];
    
    try {
        if (!fs.existsSync(farmDir)) {
            fs.mkdirSync(farmDir, { recursive: true });
            logWarning('System', `创建 farm 配置目录: ${farmDir}`);
            return configs;
        }
        
        const items = fs.readdirSync(farmDir, { withFileTypes: true });
        items
            .filter(item => item.isDirectory() && item.name.startsWith('config_'))
            .sort((a, b) => a.name.localeCompare(b.name)) // 按目录名排序 config_000, config_001, ...
            .forEach(item => {
                // 验证目录内有 followers.txt
                const followersPath = path.join(farmDir, item.name, 'followers.txt');
                if (fs.existsSync(followersPath)) {
                    configs.push(item.name);
                }
            });
        
        logInfo('System', `📂 扫描到 ${configs.length} 个 farm 配置`);
    } catch (e) {
        logError('System', `扫描 farm 配置目录失败: ${e.message}`);
    }
    
    return configs;
}

// ============================================
// Main Entry
// ============================================
const args = process.argv.slice(2);
const isDebugMode = args.includes('debug');

// 加载主号配置 (config_leaders.json)
const leadersConfigPath = path.join(projectRoot, 'config', 'config_leaders.json');
let leadersConfig;
try {
    const rawContent = fs.readFileSync(leadersConfigPath, 'utf8').replace(/^\uFEFF/, '');
    leadersConfig = JSON.parse(rawContent);
    logInfo('System', `📄 主号配置: ${leadersConfigPath}`);
    logInfo('System', `   主号数量: ${(leadersConfig.leaders || []).length} 个`);
} catch (e) {
    logError('System', `读取主号配置失败: ${e.message}`);
    process.exit(1);
}

leadersConfig.global_settings.debug_mode = isDebugMode;

// 确保共享验证数据目录存在
const sharedDataPath = leadersConfig.global_settings.shared_steam_data_path || "../shared_steam_data";
const steamDataDir = path.resolve(projectRoot, sharedDataPath);
if (!fs.existsSync(steamDataDir)) {
    fs.mkdirSync(steamDataDir, { recursive: true });
}

// 扫描 farm 配置
const farmConfigNames = scanFarmConfigs();

if (farmConfigNames.length === 0) {
    logError('System', '没有找到任何 farm 配置！请在 config/farm/ 目录下创建 config_XXX 目录，并添加 followers.txt');
    process.exit(1);
}

// 验证主号配置
if (!leadersConfig.leaders || leadersConfig.leaders.length === 0) {
    logError('System', '没有配置任何主号！请检查 config_leaders.json');
    process.exit(1);
}

// 创建并启动管理器
const manager = new FarmingManager(leadersConfig, farmConfigNames);
manager.start();

// 状态监控（每30秒输出一次）
setInterval(() => {
    const stats = manager.getStats();
    const percentage = stats.total > 0 ? Math.round((stats.inLobby / stats.total) * 100) : 0;
    const configElapsedMin = Math.floor(stats.configElapsed / 60);
    const configElapsedSec = stats.configElapsed % 60;
    const totalElapsedMin = Math.floor(stats.totalElapsed / 60);
    
    logInfo('Stats', `[${stats.currentConfig || '-'}] 进度: ${stats.inLobby}/${stats.total} (${percentage}%) | 房间: ${stats.roomsCreated} | 配置: ${stats.currentConfigIndex + 1}/${stats.totalConfigs} | 运行: ${configElapsedMin}分${configElapsedSec}秒`);
}, 30000);

// 异常处理
process.on('uncaughtException', (err) => {
    if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(err.code)) return;
    logError('System', `未捕获的异常: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
    if (reason?.code && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(reason.code)) return;
    logError('System', `未处理的Promise拒绝: ${reason}`);
});

process.on('SIGINT', () => {
    logSection('程序退出');
    manager.cleanup();
    setTimeout(() => {
        logSuccess('System', '程序已安全退出');
        process.exit(0);
    }, 3000);
});

// 监听 stdin 的命令（用于 Web 控制台）
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
    const input = data.toString().trim();
    
    // 尝试解析 JSON 命令
    try {
        const cmd = JSON.parse(input);
        
        // 解散房间命令
        if (cmd.type === 'dissolve_rooms' && cmd.roomIds) {
            logSection('收到解散房间命令');
            logInfo('System', `需要解散的房间: ${cmd.roomIds.length} 个`);
            cmd.roomIds.forEach((id, idx) => {
                logInfo('System', `   ${idx + 1}. LobbyId: ${id}`);
            });
            manager.dissolveRooms(cmd.roomIds);
            return;
        }
        
        // 跳过当前配置命令
        if (cmd.type === 'skip_config') {
            logSection('收到跳过配置命令');
            manager.skipCurrentConfig();
            return;
        }
        
        // 获取状态命令
        if (cmd.type === 'get_stats') {
            const stats = manager.getStats();
            console.log(JSON.stringify({ type: 'stats', data: stats }));
            return;
        }
    } catch (e) {
        // 不是 JSON，检查是否是退出命令
    }
    
    // 普通退出命令
    const cmdLower = input.toLowerCase();
    if (cmdLower === 'exit' || cmdLower === 'stop' || cmdLower === 'quit') {
        logSection('收到退出命令');
        manager.cleanup();
        setTimeout(() => {
            logSuccess('System', '程序已安全退出');
            process.exit(0);
        }, 3000);
    }
    
    // 跳过命令
    if (cmdLower === 'skip') {
        logSection('收到跳过命令');
        manager.skipCurrentConfig();
    }
});

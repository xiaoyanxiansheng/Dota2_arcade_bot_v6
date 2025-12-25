const SteamUser = require('steam-user');
const protobuf = require('protobufjs');
const Long = require('protobufjs').util.Long;
const fs = require('fs');
const path = require('path');

/**
 * v6.0 配置残留清理工具（独立运行，不依赖挂机车队进程）
 * 用法:
 *   node commands/cleanup_config.js config_001 [intervalMs] [maxInFlight]
 *
 * 行为:
 * - 逐个账号登录（可选代理）
 * - 启动 Dota2 并连接 GC
 * - 发送 AbandonCurrentGame + PracticeLobbyLeave
 * - 登出
 *
 * 说明:
 * - followers.txt 不包含 shared_secret；若账号需要 Steam Guard/2FA，本工具会跳过该账号（记录失败）。
 * - 本工具采用“流水线”模式：每 intervalMs 启动 1 个清理任务（不会一口气并发全开），但任务之间允许重叠（不等上一个结束）。
 * - maxInFlight 用于限制同时在途任务数量，防止堆积过多导致资源被打满。
 */

// GC 消息 ID
const k_EMsgGCAbandonCurrentGame = 7035;
const k_EMsgGCPracticeLobbyLeave = 7040;
const k_EMsgGCClientHello = 4006;
const k_EMsgGCClientConnectionStatus = 4004;
const k_EMsgProtoMask = 0x80000000;

const projectRoot = path.join(__dirname, '..');

const configName = process.argv[2];
const intervalMs = Math.max(50, Math.min(2000, Number(process.argv[3] || 100))); // 默认 0.1 秒一个
const maxInFlight = Math.max(1, Math.min(200, Number(process.argv[4] || 30)));   // 默认最多 30 个在途

if (!configName || !/^config_\d{3}$/.test(configName)) {
  console.log('用法: node commands/cleanup_config.js config_001 [intervalMs] [maxInFlight]');
  process.exit(1);
}

// 读取 v6 主号配置（用于共享数据目录 + 代理池）
function loadLeadersConfig() {
  const p = path.join(projectRoot, 'config', 'config_leaders.json');
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

// 读取 followers.txt
function loadFollowers(configNameArg) {
  const followersPath = path.join(projectRoot, 'config', 'farm', configNameArg, 'followers.txt');
  if (!fs.existsSync(followersPath)) {
    throw new Error(`配置不存在: ${followersPath}`);
  }
  const content = fs.readFileSync(followersPath, 'utf8').replace(/^\uFEFF/, '');
  return content
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && l.includes(',') && !l.startsWith('#'))
    .map(l => {
      const [username, password] = l.split(',');
      return { username: (username || '').trim(), password: (password || '').trim() };
    })
    .filter(x => x.username && x.password);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// 加载 Proto
let CMsgClientHello;
function loadProto() {
  const root = new protobuf.Root();
  root.resolvePath = function (origin, target) {
    if (fs.existsSync(target)) return target;
    const p1 = path.join(projectRoot, 'Protobufs', target);
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(projectRoot, 'Protobufs', 'dota2', target);
    if (fs.existsSync(p2)) return p2;
    const p3 = path.join(projectRoot, 'Protobufs', 'google', 'protobuf', target);
    if (fs.existsSync(p3)) return p3;
    return target;
  };

  root.loadSync(path.join(projectRoot, 'Protobufs/google/protobuf/descriptor.proto'));
  root.loadSync(path.join(projectRoot, 'Protobufs/dota2/networkbasetypes.proto'));
  root.loadSync(path.join(projectRoot, 'Protobufs/dota2/gcsdk_gcmessages.proto'));
  root.loadSync(path.join(projectRoot, 'Protobufs/dota2/dota_gcmessages_client.proto'));

  CMsgClientHello = root.lookupType('CMsgClientHello');
}

function pickFollowerProxy(leadersConfig) {
  const proxies = leadersConfig.proxies || [];
  const leaderProxyCount = leadersConfig.global_settings?.leader_proxy_count || 10;
  const followerProxies = proxies.slice(leaderProxyCount);
  if (followerProxies.length === 0) return null;
  return followerProxies[Math.floor(Math.random() * followerProxies.length)];
}

async function main() {
  const leadersConfig = loadLeadersConfig();
  const sharedDataPath = leadersConfig.global_settings?.shared_steam_data_path || '../shared_steam_data';
  const steamDataDir = path.resolve(projectRoot, sharedDataPath);
  ensureDir(steamDataDir);

  loadProto();

  const accounts = loadFollowers(configName);
  console.log(`[CleanupConfig] 配置: ${configName} | 账号数: ${accounts.length} | 间隔: ${intervalMs}ms/个 | 在途上限: ${maxInFlight}`);
  if (accounts.length === 0) {
    console.log('[CleanupConfig] followers.txt 为空或无有效账号，退出。');
    process.exit(0);
  }

  let processed = 0;
  let success = 0;
  let failed = 0;
  let skippedGuard = 0;

  const queue = accounts.slice(); // 待启动

  function printStats() {
    const percent = ((processed / accounts.length) * 100).toFixed(1);
    console.log(`[Stats] 总:${accounts.length} | ✅成功:${success} | ❌失败:${failed} | 🔐跳过:${skippedGuard} | 已处理:${processed} | 进度:${percent}%`);
  }

  // 流水线调度：每 intervalMs 启动一个，允许任务重叠，但限制在途数量
  let inFlight = 0;
  let started = 0;

  const maybeDone = () => {
    if (processed >= accounts.length && inFlight === 0) {
      printStats();
      console.log('[CleanupConfig] 完成。');
      process.exit(0);
    }
  };

  const onResult = (ok) => {
    processed++;
    inFlight = Math.max(0, inFlight - 1);
    if (ok && ok.ok) success++;
    else {
      if (ok && ok.reason === 'steam_guard') skippedGuard++;
      else failed++;
    }
    if (processed % 50 === 0 || processed === accounts.length) printStats();
    maybeDone();
  };

  const tick = () => {
    // 如果都已启动，则停止发射；等待在途结束
    if (queue.length === 0) {
      clearInterval(timer);
      maybeDone();
      return;
    }
    // 在途太多，跳过本次
    if (inFlight >= maxInFlight) return;

    const acc = queue.shift();
    if (!acc) return;
    inFlight++;
    started++;

    cleanupOne(acc, leadersConfig, steamDataDir)
      .then(onResult)
      .catch((e) => onResult({ ok: false, reason: e?.message || 'error' }));
  };

  // 立即启动一个，避免等第一个 interval
  tick();
  const timer = setInterval(tick, intervalMs);
}

function cleanupOne(account, leadersConfig, steamDataDir) {
  return new Promise((resolve) => {
    const proxy = pickFollowerProxy(leadersConfig);
    const client = new SteamUser({
      dataDirectory: steamDataDir,
      httpProxy: proxy || undefined,
      autoRelogin: false
    });

    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      // ⚠️ 不要在这里彻底移除所有监听后就放任 client 存活：底层 socket 可能在 logOff 后仍异步抛错，
      // 如果没有 error 监听会导致进程崩溃（Unhandled 'error' event）。
      // 处理策略：尽量清理非关键监听，但始终保留一个兜底 error 监听。
      try { client.removeAllListeners(); } catch (e) {}
      try { client.on('error', () => {}); } catch (e) {}
      try { client.logOff(); } catch (e) {}
      resolve(result);
    };

    const timeout = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 20000);

    client.on('steamGuard', () => {
      // 没有 shared_secret，无法自动处理，直接跳过
      clearTimeout(timeout);
      finish({ ok: false, reason: 'steam_guard' });
    });

    client.on('loggedOn', () => {
      client.setPersona(SteamUser.EPersonaState.Invisible);
      client.gamesPlayed([570]);
    });

    client.on('appLaunched', (appid) => {
      if (appid !== 570) return;
      try {
        const payload = { client_session_id: 0, engine: 2, client_launcher: 0 };
        const message = CMsgClientHello.create(payload);
        const buffer = CMsgClientHello.encode(message).finish();
        client.sendToGC(570, k_EMsgGCClientHello | k_EMsgProtoMask, {}, buffer);
      } catch (e) {}
    });

    client.on('receivedFromGC', (appid, msgType) => {
      if (appid !== 570) return;
      const cleanMsgType = msgType & ~k_EMsgProtoMask;
      if (cleanMsgType === k_EMsgGCClientConnectionStatus) {
        try {
          client.sendToGC(570, k_EMsgGCAbandonCurrentGame | k_EMsgProtoMask, {}, Buffer.alloc(0));
          client.sendToGC(570, k_EMsgGCPracticeLobbyLeave | k_EMsgProtoMask, {}, Buffer.alloc(0));
        } catch (e) {}

        clearTimeout(timeout);
        setTimeout(() => finish({ ok: true }), 500);
      }
    });

    client.on('error', () => {
      clearTimeout(timeout);
      finish({ ok: false, reason: 'steam_error' });
    });

    client.logOn({
      accountName: account.username,
      password: account.password
    });
  });
}

main().catch((e) => {
  console.error(`[CleanupConfig] 启动失败: ${e.message}`);
  process.exit(1);
});


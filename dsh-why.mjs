#!/usr/bin/env node
/**
 * dsh-why.mjs — 只读「现状体检」：一条命令答清
 *   ① 现在跑在哪台机  ② dsh 与守护鱼何时起（谁先起；**dsh 主进程 = 3080 LISTEN 的 owner**，不靠命令行匹配）  ③ 3080 端口连接情况  ④ 守护鱼状态与日志尾
 *
 * 守护鱼口径（2026-10-08 订正）：
 *   「守护鱼」行**只表示 `guard.mjs` 本体**；本体 spawn 的 **launcher**（`node -e "(async function launcherMain …)"`，
 *   负责起 dsh 的那个子进程）单独一行显示，并标明它随每次 dsh 启动换新 —— 判「守护鱼换没换」只看本体 pid。
 *   旧版对所有命令行含 `guard` 的 node 候选「取最小 pid」，会随 pid 大小偶发报到 launcher 上（判据见 guardRoleOf）。
 *   ⚠ 2026-10-08 实测追加：隔离/测试实例也跑 `guard.mjs`（`--port 3115 --state-dir %TEMP%\h1-iso\…`）⇒ 生产本体
 *     还要过 `--state-dir` 这一关（判据见 isProductionGuardBody）；非生产实例单独一行显示为「隔离守护鱼」。
 *   ⚠ 2026-10-16 实测追加（卡「V3·机器锁7」R-067）：**测试实例（如 3090）也有自己的 launcher**（同一个
 *     `launcherMain` 内联脚本，只是 `-- --port 3090 --cwd <test-workspace>`）⇒ 旧版把两个 launcher
 *     一起数，报出「发现 2 个 launcher」**假阳性**（与 2026-09-24 `guard-unhealthy` 把启动器数成第二只守护鱼**同坑复发**）。
 *     现按 **launcher 所服务的 dsh 端口**分桶（判据见 launcherTargetPort）：只有服务生产 PORT 的才算生产 launcher，
 *     非生产单独归 `guardIsoLaunchers` 并**如实单列**（不猜、不隐藏，但**不计入生产 launcher 个数**）。
 *
 * 用法：
 *   node dsh-why.mjs                 # 人类可读
 *   node dsh-why.mjs --json          # 机器可读（只落 stdout，日志不污染）
 *   node dsh-why.mjs --log-lines 30  # 日志尾行数（默认 12，0 = 不打印）
 *   node dsh-why.mjs --procs-file <p> # 用离线进程表 JSON 代替实时 CIM（自测/负样例/异机复现，输出标注来源）
 *   node dsh-why.mjs --help
 *
 * 定位：**按需调用的只读工具**，不挂钩子、不进任何强制流程、不写任何文件。
 * 它替代的是「凭记忆猜哪台机在跑 / 猜 dsh 刚重启没」这种穷举猜测。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 优选统一走工具：本机 pwsh 是 WindowsApps 别名
//   （fs.accessSync 判不到但能跑），原先「Program Files\PowerShell\7 → 否则 5.1」会漏判成 5.1（弹窗）。
import { powerShellExe } from './lib/powershell-exe.mjs';
// R-066（2026-10-16）：本件打印**进程命令行 / 环境 / 日志尾**（命令行里常带 key/token）
// ⇒ 输出前按「键名 or 值形态」双判据脱敏（共享件；只影响显示，不改任何逻辑）。
import { createRedactor } from './lib/redact.mjs';

const redactOut = createRedactor({ secretsOnly: true }).redactAndCount;

const PORT = 3080;
const GUARD_DIR = path.join(os.tmpdir(), 'dsh-guard');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = { json: false, logLines: 12, help: false, procsFile: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opt.json = true;
  else if (a === '--log-lines') opt.logLines = Number(argv[++i] ?? 12);
  else if (a === '--procs-file') opt.procsFile = argv[++i] ?? null;
  else if (a === '-h' || a === '--help') opt.help = true;
  else { process.stderr.write(`unknown arg: ${a}\n`); opt.help = true; }
}

const USAGE = [
  'usage: node dsh-why.mjs [--json] [--log-lines N] [--procs-file <p>] [--help]',
  '  只读现状体检：机器 / dsh(3080) 与守护鱼进程启动时间 / 端口连接 / 守护鱼状态与日志尾。',
  '  守护鱼口径：「守护鱼」行 = guard.mjs **本体**；它 spawn 的 launcher（起 dsh 的子进程）单独一行显示。',
  '  --procs-file <p>：改读离线进程表 JSON（自测/负样例/异机复现，输出会标注来源）；本工具不写任何文件。',
].join('\n');

// 入口守卫：被 import（单测/守门脚本）时**不执行 main**。
// ⚠ 必须 realpath 双方再比：junction 下 argv[1] 是逻辑路径、而 import.meta.url 解析为物理路径，直接比永不相等。
if (isMainModule()) {
  if (opt.help) {
    console.log(USAGE);
    process.exitCode = 0;
  } else {
    main();
  }
}

function main() {
  const now = new Date();
  const report = {
    at: stamp(now),
    host: process.env.COMPUTERNAME || os.hostname(),
    user: process.env.USERNAME || '',
    port: PORT,
    dsh: null,
    dshSource: null,      // 'port-owner' = 主进程由 3080 LISTEN 的 owner 判定（判据见 ② 段注释）
    dshRunners: [],       // dsh subprocess runner（命令行像 dsh，但不持有 3080）——单独归类，不当主进程
    guard: null,          // 守护鱼**本体**（guard.mjs 进程 · 且 state-dir = 生产）
    guardBodies: [],      // 全部 guard.mjs **生产**本体（>1 只 = 疑似第二只守护鱼，会在 notes 告警）
    guardIsoBodies: [],   // guard.mjs 的**隔离/测试实例**（--state-dir ≠ 生产）——单独归类，绝不当生产守护鱼
    guardLauncher: null,  // 本体 spawn 的 launcher（node -e "(async function launcherMain …)"）：起 dsh 的子进程
    guardLaunchers: [],   // 全部 launcher（**仅生产实例**：所服务的 dsh 端口 = PORT）
    guardIsoLaunchers: [],// launcher 里服务**非生产实例**的（如测试 3090）——单独归类，绝不计入生产 launcher 个数
    guardSource: null,    // 'cmdline:guard.mjs+state-dir' = 本体按「命令行以 guard.mjs 作脚本入口」+ state-dir 判定
    otherDshNodes: [],
    net: { listenPids: [], established: 0 },
    guardState: null,
    logTail: [],
    notes: [],
  };
  report.device = shortCode(report.host);

  // ① 3080 端口
  report.net = netInfo(PORT);
  if (report.net.listenPids.length === 0) report.notes.push(`3080 无 LISTENING —— 本机 dsh 未在跑`);
  if (report.net.listenPids.length > 1) report.notes.push(`3080 有多个 LISTENING PID：${report.net.listenPids.join(',')}`);

  // ② dsh 主进程判据 = **3080 LISTEN 的 owner**（不靠命令行匹配）
  //    为什么（2026-09-23 修）：命令行匹配会把 dsh 的 **subprocess runner** 也算成主进程 ——
  //    `...\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-subprocess-local\lib\runner.js` 的命令行同样含
  //    `@deepseek-ai\dsh`；旧逻辑「取最小 pid」在 pid 复用时会报出 runner 的 pid 与启动时间
  //    ⇒ 据此判成「刚重启过」（2026-09-23 实测复现：旧版报 PID 6256「已运行 0s」而真身是 52272）。
  //    **监听 3080 的进程才是主进程**（runner 不持有 3080）。
  const mainPid = report.net.listenPids[0] ?? null;
  report.dshSource = mainPid ? 'port-owner' : null;

  // ③ node 进程（CIM 拿启动时间 + 命令行；`--procs-file` 时改读离线夹具 —— 只读，用于排障与自测）
  const procs = opt.procsFile ? readProcsFile(opt.procsFile) : nodeProcesses();
  if (procs === null) {
    report.notes.push(opt.procsFile
      ? `--procs-file 读取失败或格式非法：${opt.procsFile}`
      : '进程查询失败（pwsh/powershell 不可用或 CIM 被拦）');
  }
  if (opt.procsFile) report.notes.push(`进程表来自 --procs-file（离线夹具，**非**实时 CIM 查询）：${opt.procsFile}`);

  for (const p of procs || []) {
    if (p.pid === process.pid) continue; // 别把自己列进去
    const cmd = String(p.cmd || '');
    const rec = {
      pid: p.pid, ppid: p.ppid ?? null, start: p.start, startLocal: fmtStamp(p.start),
      uptimeSec: uptimeSec(p.start, now), script: scriptName(cmd), cmd: shorten(cmd),
    };
    if (isSubprocessRunner(cmd)) { report.dshRunners.push(rec); continue; } // 命令行像 dsh ⇒ 单独归类，绝不当主进程
    // 守护鱼：本体（再分「生产 / 隔离实例」）与 launcher 分开归桶（判据见 guardRoleOf 注释）。
    // ⚠ 绝不「取最小 pid」混选 —— 那正是 2026-10-08 误报成 launcher 的根因。
    // ⚠ 2026-10-08 实测追加：隔离/测试实例也跑 `guard.mjs`（`--port 3115 --state-dir …\Temp\h1-iso\…`，
    //   父进程是测试脚本 `test-guard-http-alive.mjs`）⇒ 只按文件名判会把**测试实例**当成生产守护鱼
    //   （当时它 pid 7324 < 生产本体 21456，正好会被「取最小 pid」选中）。生产本体还要过 state-dir 这一关。
    const guardRole = guardRoleOf(cmd);
    if (guardRole === 'body') {
      if (isProductionGuardBody(cmd)) report.guardBodies.push(rec);
      else report.guardIsoBodies.push(rec);
      continue;
    }
    if (guardRole === 'launcher') {
      // R-067（2026-10-16）：launcher 也分「服务哪个实例」—— 测试实例（3090/3092）同样有 launcher，
      //   混在一起数会误报「发现 2 个 launcher」。判据 = launcher 命令行里给 dsh 的 `--port`（缺省 PORT）。
      rec.targetPort = launcherTargetPort(cmd);
      if (rec.targetPort === PORT) report.guardLaunchers.push(rec);
      else report.guardIsoLaunchers.push(rec);
      continue;
    }
    if (p.pid === mainPid) { report.dsh = rec; continue; }             // 判据：持有 3080 的 pid
    report.otherDshNodes.push(rec);                                    // 其余 node（含 3090/3092 等其它实例；含 guard 字样但两者都不是的也落这里）
  }
  // 守护鱼定序：按 pid 升序取第一只作代表；**report.guard 永远是「生产本体」**
  const byPid = (a, b) => a.pid - b.pid;
  report.guardBodies.sort(byPid);
  report.guardLaunchers.sort(byPid);
  report.guardIsoLaunchers.sort(byPid);
  report.guardIsoBodies.sort(byPid);
  report.guard = report.guardBodies[0] ?? null;
  report.guardLauncher = report.guardLaunchers[0] ?? null;
  if (report.guard) report.guardSource = 'cmdline:guard.mjs+state-dir';
  if (report.guardIsoBodies.length) {
    report.notes.push(`另有 ${report.guardIsoBodies.length} 个 guard.mjs **非生产实例**（pid ${report.guardIsoBodies.map((b) => b.pid).join(',')}`
      + `，--state-dir ≠ 生产 ${GUARD_DIR}）—— 已排除，绝不计入生产守护鱼（测试/隔离实例的 pid 可能更小，旧版按「文件名 + 最小 pid」会选错它）`);
  }
  if (report.guardBodies.length > 1) {
    report.notes.push(`发现 ${report.guardBodies.length} 个 guard.mjs 本体（pid ${report.guardBodies.map((b) => b.pid).join(',')}）`
      + '—— 疑似第二只守护鱼，需人工核（判「守护鱼换没换」以本行列出的本体为准）');
  }
  if (!report.guard && report.guardLauncher) {
    report.notes.push(`只见到 launcher（pid ${report.guardLauncher.pid}，父 ${report.guardLauncher.ppid}）而无 guard.mjs 本体`
      + ' —— 守护鱼本体可能已退出/被换（dsh 仍可由父链带着跑）；判守护鱼存活**不能**只看 launcher');
  }
  if (report.guardLaunchers.length > 1) {
    report.notes.push(`发现 ${report.guardLaunchers.length} 个 launcher（pid ${report.guardLaunchers.map((l) => l.pid).join(',')}）`
      + ' —— 正常应只有 1 个（dsh 退出时旧 launcher 会跟着退）');
  }
  // R-067：**非生产** launcher 如实单列 —— 旧版把它们并进上面的计数，报出「发现 2 个 launcher」假阳性
  //   （2026-10-16 实测：测试实例 3090 的 launcher 被当成第二只）。这里不猜、不隐藏，但**不混进生产计数**。
  if (report.guardIsoLaunchers.length) {
    report.notes.push(`另有 ${report.guardIsoLaunchers.length} 个 launcher 服务**非生产实例**`
      + `（pid ${report.guardIsoLaunchers.map((l) => `${l.pid}·端口${l.targetPort}`).join('，')}）`
      + ` —— 已排除，**不计入**生产 launcher 个数（判据：launcher 命令行里给 dsh 的 --port ≠ ${PORT}）`);
  }
  if (report.dshRunners.length) {
    report.notes.push(`dsh 主进程按 3080 owner 判定；已排除 ${report.dshRunners.length} 个 subprocess runner`
      + `（pid ${report.dshRunners.map((r) => r.pid).join(',')}，命令行含 @deepseek-ai\\dsh 但不持有 3080）`);
  }
  if (mainPid && procs !== null && !report.dsh) {
    report.notes.push(`3080 owner pid ${mainPid} 不在 node 进程列表里（restart 竞态 / CIM 未及）——启动时间未知`);
  }
  // 端口 PID 兜底：CIM 查询失败或该 pid 未列出时，也要标出监听者
  if (!report.dsh && mainPid) {
    report.dsh = { pid: mainPid, start: null, startLocal: '未知', uptimeSec: null, script: '', cmd: '(CIM 无该进程信息)' };
    report.notes.push('dsh 由端口 PID 兜底识别，启动时间可能缺失');
  }

  // ③ 守护鱼状态文件
  report.guardState = guardState();

  // ④ 日志尾
  if (opt.logLines > 0) report.logTail = tailLines(path.join(GUARD_DIR, 'guard2.log'), opt.logLines);

  // ⑤ 时间线判断（只据启动时间顺序，不臆测）
  //    ⚠ 判「守护鱼换没换」用**本体**启动时间：launcher 每次 dsh 启动都会换新，拿它当守护鱼必错（2026-10-08 卡）。
  if (report.guardLauncher?.start && report.dsh?.start) {
    const lag = Math.abs(Math.round((new Date(report.dsh.start) - new Date(report.guardLauncher.start)) / 1000));
    if (lag <= 180) {
      report.notes.push(`launcher pid ${report.guardLauncher.pid} 与 dsh 同刻启动（差 ${lag}s）`
        + ' ⇒ 本次 dsh 启动/重启是它拉起的；守护鱼本体未变（判「守护鱼重不重启」只看本体 pid）');
    }
  }
  if (report.dsh?.start && report.guard?.start) {
    const gap = Math.round((new Date(report.dsh.start) - new Date(report.guard.start)) / 1000);
    if (gap >= 0 && gap <= 180) report.timeline = `守护鱼先起 ${gap}s → dsh 随后启动（这 ${gap}s 内发生过一次 dsh 启动/重启）`;
    else if (gap < 0) report.timeline = `dsh 比守护鱼早 ${-gap}s（守护鱼是后来接手的）`;
    else report.timeline = `守护鱼早于 dsh ${gap}s（超过 3 分钟，未必是同一次启动）`;
  } else if (report.dsh && !report.dsh.start) {
    report.timeline = '（缺 dsh 启动时间，无法判断是否刚重启）';
  }

  // ---------- 输出 ----------
  if (opt.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = 0;
    return;
  }

  const L = [];
  L.push(`DSH 现状 · ${report.at}`);
  L.push(`机器      ${report.host}${report.device ? `（${report.device}）` : ''}${report.user ? `  用户 ${report.user}` : ''}`);
  const n = report.net;
  if (report.dsh) {
    L.push(`dsh(3080) PID ${report.dsh.pid}  起于 ${report.dsh.startLocal || '未知'}${fmtUp(report.dsh.uptimeSec)}  监听 ${n.listenPids.includes(report.dsh.pid) ? '✓' : '✗'}  ESTABLISHED ${n.established}`);
  } else {
    L.push(`dsh(3080) 未识别到进程（LISTENING PID：${n.listenPids.length ? n.listenPids.join(',') : '无'}）  ESTABLISHED ${n.established}`);
  }
  if (report.guard) {
    // 只说**本体**：dsh 重启只换 launcher，本体不变（口径见文件头「守护鱼口径」）
    L.push(`守护鱼    PID ${report.guard.pid}  起于 ${report.guard.startLocal || '未知'}${fmtUp(report.guard.uptimeSec)}  guard.mjs（本体 · dsh 重启/换 launcher 不动它）`);
  } else if (report.guardLauncher) {
    L.push('守护鱼    未识别到 guard.mjs 本体（⚠ 只见到 launcher，见下一行）');
  } else {
    L.push('守护鱼    未识别到 guard 进程（⚠ 守护鱼不在）');
  }
  if (report.guardLauncher) {
    const g = report.guardLauncher;
    const rel = describeLauncherParent(g, report.guard, (procs || []).map((p) => p.pid));
    L.push(`launcher  PID ${g.pid}  起于 ${g.startLocal || '未知'}${fmtUp(g.uptimeSec)}  ${rel} · node -e 内联脚本（起 dsh 的子进程：每次 dsh 启动换新，非守护鱼本体）· 服务端口 ${g.targetPort ?? PORT}`);
  }
  // R-067：非生产 launcher 单独一行（不让它冒充生产 launcher，也不把它藏起来）
  for (const g of report.guardIsoLaunchers) {
    L.push(`launcher* PID ${g.pid}  起于 ${g.startLocal || '未知'}${fmtUp(g.uptimeSec)}  **非生产实例**（服务端口 ${g.targetPort}，本机生产是 ${PORT}）· 不计入上面的 launcher 个数`);
  }
  if (report.guardIsoBodies.length) {
    const iso = report.guardIsoBodies[0];
    const more = report.guardIsoBodies.length > 1 ? `（共 ${report.guardIsoBodies.length} 个）` : '';
    L.push(`隔离守护鱼 PID ${iso.pid}${more}  起于 ${iso.startLocal || '未知'}${fmtUp(iso.uptimeSec)}  guard.mjs（--state-dir ≠ 生产 ⇒ 测试/隔离实例，**非**生产本体）`);
  }
  if (report.timeline) L.push(`时间线    ${report.timeline}`);
  if (report.guardState) {
    const s = report.guardState;
    const kv = Object.entries(s).filter(([k]) => /mode|crash|repair|last|state|pid/i.test(k)).slice(0, 8)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    L.push(`guard 态  ${kv.join('  ') || '(无关键字段)'}`);
  }
  if (report.otherDshNodes.length) {
    L.push(`其他 node ${report.otherDshNodes.map((p) => `${p.pid}(${p.script})`).join('  ')}`);
  }
  if (report.logTail.length) {
    L.push(`日志尾    ${path.join(GUARD_DIR, 'guard2.log')}`);
    for (const line of report.logTail) L.push(`  ${line}`);
  }
  for (const note of report.notes) L.push(`注意      ${note}`);
  console.log(redactOut(L.join('\n')));
  process.exitCode = 0;
}

// ---------- 取数 ----------
function netInfo(port) {
  const out = { listenPids: [], established: 0 };
  let text = '';
  try {
    text = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/);
    if (!m || Number(m[2]) !== port) continue;
    if (m[4] === 'LISTENING') out.listenPids.push(Number(m[5]));
    else if (m[4] === 'ESTABLISHED') out.established++;
  }
  return out;
}

function pickShell() {
  // 【2026-10-09 · 卡「360弹窗治本-pwsh7」】原来写死 `%ProgramFiles%\PowerShell\7\pwsh.exe` + fs.accessSync：
  //   本机 pwsh 是 **WindowsApps 别名**（existsSync/accessSync 返回 false，但能跑）⇒ 原判据必然漏判 → 回落 5.1 弹窗。
  try { return powerShellExe(); } catch { return 'powershell.exe'; }
}

/**
 * dsh 的 subprocess runner 判据：命令行指向 `<...>/dsh-subprocess-<变体>/lib/runner.js` 的 node 进程。
 * 这类进程命令行含 `@deepseek-ai\dsh`，会被朴素的命令行匹配误当成主进程（本文件 2026-09-23 修的就是这个）。
 */
export function isSubprocessRunner(cmd) {
  return /[\\/]dsh-subprocess-[^\\/\s]+[\\/]lib[\\/]runner\.js/i.test(String(cmd || ''));
}

/**
 * `--procs-file`：从 JSON 夹具读进程表（`[{pid, ppid, start, cmd}]` 或 `{ procs: [...] }`），
 * 替代实时 CIM 查询 —— **只读**，不写任何东西。用途 = 自测 / 负样例 / 异机复现（输出会显式标注来源，防被当实时读数）。
 */
function readProcsFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(j) ? j : (Array.isArray(j?.procs) ? j.procs : null);
    if (!arr) return null;
    return arr.map((p) => ({
      pid: Number(p?.pid),
      ppid: p?.ppid === undefined || p?.ppid === null ? null : Number(p.ppid),
      start: p?.start ?? null,
      cmd: String(p?.cmd ?? ''),
    })).filter((p) => Number.isFinite(p.pid));
  } catch {
    return null;
  }
}

function nodeProcesses() {
  const ps = [
    "$ProgressPreference='SilentlyContinue'",
    "$ErrorActionPreference='SilentlyContinue'",
    "$r = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object {",
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; start = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }; cmd = [string]$_.CommandLine }",
    "})",
    "ConvertTo-Json -InputObject $r -Compress -Depth 3",
  ].join('\n');
  try {
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    // stdio 全 pipe：别把 pwsh 的 CLIXML / 进度噪声漏到本脚本 stderr（--json 时 stdout 必须干净）
    const out = execFileSync(pickShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
      encoding: 'utf8', windowsHide: true, timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out.trim() || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

function guardState() {
  for (const name of ['guard-state.json', 'guard2-state.json']) {
    const f = path.join(GUARD_DIR, name);
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* next */ }
  }
  return null;
}

function tailLines(file, count) {
  try {
    const st = fs.statSync(file);
    const from = Math.max(0, st.size - 64 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-count).map((l) => shorten(l, 160));
  } catch {
    return [];
  }
}

// ---------- 小工具 ----------
function stamp(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtStamp(iso) {
  if (!iso) return '未知';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : stamp(d);
}
function scriptName(cmd) {
  const m = String(cmd || '').match(/[^\\/\s"]+\.m?js/gi);
  return m && m.length ? m[m.length - 1] : 'node';
}
function uptimeSec(start, now) {
  if (!start) return null;
  const t = new Date(start);
  if (Number.isNaN(t.getTime())) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}
function fmtUp(sec) {
  if (sec === null || sec === undefined) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const body = h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
  return `（已运行 ${body}）`;
}
function shorten(s, max = 110) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}
function shortCode(host) {
  const h = String(host || '').toUpperCase();
  if (!h) return '';
  // 设备短码：默认把主机名 slug 化（不锁具体机器）；需要自定义展示名时设 DSH_DEVICE_LABEL
  const custom = String(process.env.DSH_DEVICE_LABEL || '').trim();
  if (custom) return custom;
  return h.replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------- 守护鱼判定（导出：单测同源引用，勿复制逻辑到别处） ----------
/** 入口守卫（realpath 双方比对，见调用点注释）。 */
export function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 守护鱼进程角色判定（三态 · 纯函数）：
 *   'body'     = 守护鱼**本体**：命令行把 `\guard.mjs` 作为脚本入口（`node <DSH_ROOT>\guard.mjs --state-dir …`）
 *   'launcher' = 本体（或 repair 分身）spawn 的 launcher：`node -e "(async function launcherMain …)"`，
 *                命令行里带 `--pid-file <…>\Temp\dsh-guard\dsh-launcher-pid-<pid>.json` ⇒ 含 "guard" 字样
 *   null       = 与守护鱼无关（含 guard 字样但两者都不是 ⇒ 归 other，**绝不冒充守护鱼**）
 *
 * 为什么需要它（2026-10-08）：旧逻辑 `if (/guard/i.test(cmd))` 把 launcher 也算候选、再「取最小 pid」，
 * 报谁的 pid 全看 pid 大小（10:33 实测 launcher 36580 < 本体 38996 ⇒ 报成 launcher）。
 * launcher 随每次 dsh 启动换新、**本体不变** ⇒ 误读会得出「守护鱼重启了」的错误结论。
 */
export function guardRoleOf(cmd) {
  const c = String(cmd || '');
  if (!/guard/i.test(c)) return null;
  if (/launcherMain|dsh-launcher-pid/i.test(c)) return 'launcher';
  if (/[\\/]guard\.mjs(?=["'\s]|$)/i.test(c)) return 'body';
  return null;
}

/**
 * launcher 服务的 **dsh 实例端口**（纯函数）：从 launcher 命令行里读出它给 dsh 的 `--port`。
 * 为什么需要它（R-067 · 2026-10-16 实测）：测试实例（3090）也有 launcher，且用的是**同一个** `launcherMain`
 *   内联脚本 ⇒ 旧版把两个 launcher 一起数，报出「发现 2 个 launcher」**假阳性**（与 2026-09-24 `guard-unhealthy`
 *   把启动器数成第二只守护鱼**同坑复发**）。判据必须是"它服务哪个实例"，而不是"有几个 launcher 进程"。
 * 解析口径：launcher 命令行形如
 *   `node -e "…launcherMain…" -- --log … --cwd … --pid-file … -- <node.exe> …\bin.js web --port 3090 --no-open`
 *   ⇒ 取**最后一个 ` -- ` 之后**那一段（= 真正传给 dsh 的参数）里找 `--port`；取最后一段是为了不误读
 *   launcher 自身的 `--log` / `--cwd` / `--pid-file`。不带 `--port` ⇒ dsh 默认端口（= fallback，本机生产 PORT）。
 */
export function launcherTargetPort(cmd, fallback = PORT) {
  const c = String(cmd || '');
  const i = c.lastIndexOf(' -- ');
  const tail = i >= 0 ? c.slice(i) : c;
  const m = tail.match(/--port(?:=|\s+)(\d{2,5})/i);
  return m ? Number(m[1]) : fallback;
}

/**
 * 「生产 launcher」判定：角色是 launcher **且**服务的是生产端口。
 *   R-067 起新增（2026-10-16）：非生产实例的 launcher 归 `guardIsoLaunchers`，**不计入**生产 launcher 个数。
 */
export function isProductionLauncher(cmd, port = PORT) {
  return guardRoleOf(cmd) === 'launcher' && launcherTargetPort(cmd, port) === port;
}

/**
 * 「生产本体」判定：guard.mjs 本体还必须**用生产 state-dir**（默认 = `%TEMP%\dsh-guard`）。
 * 为什么（2026-10-08 11:59 实测撞上）：隔离/测试实例也跑 `guard.mjs`，只是换了端口与 state-dir
 * （`--port 3115 --state-dir %TEMP%\h1-iso\run-…\C3`，父进程 = 测试脚本 `test-guard-http-alive.mjs`）；
 * 当时它 pid 7324 < 生产本体 21456 ⇒ 只看文件名 + 「取最小 pid」会把**测试实例**报成生产守护鱼。
 * 容错：不带 `--state-dir` ⇒ 视为生产（走默认值）；比较时去引号/尾斜杠并忽略大小写。
 */
export function isProductionGuardBody(cmd, guardDir = GUARD_DIR) {
  const m = String(cmd || '').match(/--state-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (!m) return true;
  const val = String(m[1] ?? m[2] ?? m[3] ?? '').replace(/[\\/]+$/, '');
  const prod = String(guardDir).replace(/[\\/]+$/, '');
  return val.toLowerCase() === prod.toLowerCase();
}

/**
 * launcher 父进程描述。
 * ⚠ 实测（2026-10-08 11:52）launcher 的父**不一定是本体**：pid 38244 的父是 14524（repair 分身，已退出），
 * 本体是 21456 ⇒ 别硬写「父=本体」，按实际 ppid 标注。
 */
export function describeLauncherParent(launcher, body, pids) {
  if (!launcher) return '';
  const ppid = launcher.ppid;
  const alive = (pids || []).includes(ppid);
  if (body && ppid === body.pid) return `父 ${ppid}（=本体）`;
  if (body) return `父 ${ppid}（≠本体 ${body.pid}${alive ? '' : '·已退出'} ⇒ 由 repair 分身等代起）`;
  return `父 ${ppid}${alive ? '' : '（已退出）'}`;
}

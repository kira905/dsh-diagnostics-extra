#!/usr/bin/env node
/**
 * owner-todo-scan.mjs —— 只读：扫出「等你操作 / 待拍板」的悬项（可落成清单文件）
 *
 * 为什么需要它：会话标题的【完成】只表示"这一轮说完了"，不等于"活闭环了"。
 * 真正等你的事散落在四处登记里，本工具把它们合成一张清单：
 *   ⓪ DSH 现场锁（`~/.dsh/upgrade-lock` 判为中断 / 不可判定 / phase=failed）——③ 包 C-6 失败态的第三处视图
 *   ① 看板卡 description 里的「待拍板 / 待主人 / 需主人 / 等你」段落（默认只列**在途卡**）
 *   ② docs\交接-*.md 里的「待主人 / 待对端 / 未完成」段
 *   ③ docs 里「给对端机执行的单子」—— 这类文档本身就是一份待办
 *
 * 用法：
 *   node owner-todo-scan.mjs           # 在途卡 + 交接文档 + 对端执行单
 *   node owner-todo-scan.mjs --all     # 追加 done 卡里的「待拍板」历史段（噪声多，兜底用）
 *   node owner-todo-scan.mjs --write   # 落 docs\待你操作-<设备>.md（整体重写刷新）
 *   node owner-todo-scan.mjs --json
 *
 * 输出口径（2026-10-19 · 卡「待你操作清单与禁攒债打架」· 主人 2026-10-14 禁攒债令）：
 *   · `gradeOf()` 判为 **甲档（self）** 的条目**不进 Markdown 正文**，只在「一、」段头部留一行计数；
 *     明细仍完整保留在 `--json` 的 `cards[].hits/grades`（既有字段未改，只新增）。
 *   · 交接档先判「是否已办结」：同族（剥日期/棒号后的主题）已有更新档 / 档内引用的卡全为
 *     done·archived / 超 OVERDUE_DAYS 且无任何在途卡引用 ⇒ 判历史件，只留一行折叠计数，
 *     明细在 `--json` 的 `handoffs[].verdict`。**卡类到期项不受此折叠影响（硬判据，逐条列）**。
 *   · ⓪ 升级锁 / 🔴 红线卡 / ③ 对端机执行单**照旧全部列出**（这些真需要人操作）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolveDshHome, resolveDshWorkspace } from "./lib/dsh-home.mjs";
import { firstH1Index, insertAtFor, stampDocMark } from "./lib/generated-docs.mjs"; // §2.2 权威源（档级标记）
import { cliGuard } from "./lib/cli-args.mjs";
// 升级锁现场（③ 包 C-6 段①②的第三处视图）：判据唯一源 = lib/upgrade-lock.mjs 的 status()
// —— **绝不在此复制判定逻辑**（锁的心跳/pid 判据改一处就够）。
// ⚠️ 该模块是**可选依赖**：它属于 DSH 生态内核（私有工具树），本仓不下发 ⇒ 改为动态加载 + 降级（见下方「可选内核」段）。
let lockStatus = null;

// DSH 数据根 / 工作区：口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（2026-09-17 环境边界修复，
// 卡：自研组件去 os.homedir() 硬编码）。原为 os.homedir() + 固定 <DSH_ROOT>\docs ——
// 测试实例里扫的是**生产**看板账本，--write 还会写**生产** docs。
// HOME 现在是 DSH 数据根（…\.dsh），下游拼接不再补一层 .dsh；不设 env 时逐字节不变。
const DOCS = process.env.DSH_DOCS_DIR || path.join(resolveDshWorkspace(), "docs");
const HOME = resolveDshHome();

// ---------- 可选内核加载（升级锁 / 守护鱼闸 / 残留收敛） ----------
// 这三个判据的真实实现长在 DSH 私有工具树（dsh-butler/lib）里，本仓不下发：
//   · 目录存在 ⇒ 行为与私有树逐字一致；
//   · 目录不存在 ⇒ 升级锁本节显式打印「不可探测」并继续；另两节静默跳过（它们是噪音源，不是"有你的事"）。
const SPEC = {
  cmd: 'dsh-owner-todo-scan',
  summary: '把「等你操作 / 待拍板」的悬项从四处登记里合成一张清单（现场锁 / 看板卡 / 交接档 / 对端执行单）。',
  usage: 'dsh-owner-todo-scan [--all] [--json] [--write]',
  flags: [
    { name: '--all', desc: '连已 done 卡里的历史段也扫（噪声多，兜底用）' },
    { name: '--json', desc: '机器可读输出（含每条的档位判定）' },
    { name: '--write', desc: '把清单整体重写成 docs 下的「待你操作-<设备>.md」' },
  ],
  writes: '默认只打印。--write 会整体重写一份 docs 下的清单文件（覆盖式刷新）。',
  exits: '0 成功 · 1 采集异常 · 2 参数错误',
  examples: ['dsh-owner-todo-scan', 'dsh-owner-todo-scan --json'],
};
cliGuard(SPEC);

const TOOLS_DIR = process.env.DSH_TOOLS_DIR || path.join(resolveDshWorkspace(), "tools");
const BUTLER_LIB = process.env.DSH_BUTLER_LIB || path.join(TOOLS_DIR, "dsh-butler", "lib");
try {
  ({ status: lockStatus } = await import(pathToFileURL(path.join(BUTLER_LIB, "upgrade-lock.mjs")).href));
} catch { /* 无内核 ⇒ lockStatus = null，§④ 显式降级 */ }
const argv = process.argv.slice(2);
const INCLUDE_DONE = argv.includes("--all");
const JSON_OUT = argv.includes("--json");
const WRITE = argv.includes("--write");

const ASK = /(待拍板|待主人|需主人|主人确认|主人点头|等你|待你|请主人|主人定|待对端|未完成|待验|待裁决|待授权|需授权)/;
const SKIP = /(已拍板|已确认|已授权|已裁决|已闭环|已完成|已落地|已收口|无需再|不再需要)/;
// 文件名本身含「待你操作」⇒ 任何**引用本清单档名**的行都会被 ASK 误判成"待你"（2026-10-19 实测：
// 卡描述里写验收命令 `rg "🔧甲档" docs\待你操作-<设备>.md` 就被扫成一条悬项）。判关键词前先把该档名抹平。
const stripNames = (s) => String(s).replace(/待你操作-[^\s`"'）)]+\.md/gi, "清单文件");

// ---------- 档位分拣（2026-10-14 主人令「别最后攒一屁股债找我拍板」） ----------
// 为什么：这张清单本来是"要你一句话的"，可现实是**本鱼自己能拍的活也被攒进来**了
//   （主人原话点名：大管家 V2 待拍板清单几百条、还滚动更新）。⇒ 每条按驾照 §11 判档位：
//   甲档 = 本鱼该自己办掉（**不许进这张清单**，长期不为 0 就是本鱼又在攒债）；乙档红线 = 真得主人一句话。
// 判据 = 关键词命中（先红线后甲档；都不中 ⇒ unknown，保守列给主人但标"未定档"）。
//   ⚠️ 这是**启发式**，不是判定真源（真源 = `docs\本鱼自主授权细则-20260921.md` §11.2/§11.3）；
//      误判的代价 = 清单多一行标注，故宁可宽判"甲档"（让债暴露）而不漏。
const REDLINE = /(凭据|密钥|密码|删别人|删除别人|别人的卡|别人的会话|对端生产|对端服务|停机|关机|shutdown|外发|企微|钉钉|邮件|充值|采购|付费|花钱|扩权|改本细则|不可逆|force-collect)/;
const SELFDO = /(建卡|落卡|run|开关|放行|回滚|备份|进程|重启|文档|记忆|审核|取证|收尾|归档|索引|口径|回写|迁移|体检|清理|改名|整理|订正)/;
export function gradeOf(text) {
  if (REDLINE.test(String(text))) return "red";
  if (SELFDO.test(String(text))) return "self";
  return "unknown";
}
const GRADE_LABEL = { self: "🔧甲档(应自办)", red: "🔴红线(待主人)", unknown: "❔未定档" };
const gradeLabel = (g) => GRADE_LABEL[g] ?? GRADE_LABEL.unknown;
const OPEN = new Set(["backlog", "todo", "running", "review"]);
const DEV = (process.env.DSH_DEVICE_LABEL || os.hostname() || "DEV").trim();
const nowMs = Date.now();
const DAY_MS = 24 * 3600 * 1000;
const OVERDUE_DAYS = 7;
const overdueMs = OVERDUE_DAYS * DAY_MS;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// 交接档「族键」：剥掉前缀 `交接-`、日期、尾部棒号（`第N棒` / `棒N` / `-N`）后去分隔符。
// 同一主线的接力档（第8棒…第20棒）因此落进同一族 ⇒ 只有最新一份可能算「在途」。
const handoffFamily = (name) => {
  let s = String(name).replace(/^交接-/, "").replace(/\.md$/i, "");
  s = s.replace(/(?:^|[-_ ])\d{8}(?=$|[-_ ])/g, "");          // 日期 YYYYMMDD
  s = s.replace(/(?:[-_ ]*(?:第)?\d{1,3}棒)+$/g, "");          // 尾部 第8棒 / 棒2
  s = s.replace(/(?:[-_ ]+棒?\d{1,3})+$/g, "");                // 尾部 -20 / 棒20
  return s.replace(/[^\p{L}\p{N}.]+/gu, "").toLowerCase();
};

const T = (ms) => ms ? new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

// ---------- ① 看板卡 ----------
const cards = [];
// 账本全量卡态索引（**只用于判交接档是否已办结**，不进「一、」段）：id → archived/done/failed/open…
const cardState = new Map();
const ledger = path.join(HOME, "task-board", "ledger-v2.json");
if (fs.existsSync(ledger)) {
  const j = JSON.parse(fs.readFileSync(ledger, "utf8"));
  for (const t of (j.tasks || [])) cardState.set(String(t.id).toLowerCase(), t.archivedAt ? "archived" : (t.status ?? "unknown"));
  for (const t of (j.tasks || [])) {
    if (t.archivedAt) continue;
    if (!INCLUDE_DONE && !OPEN.has(t.status)) continue;   // done/failed 卡的历史「待拍板」段属噪声
    const text = String(t.description || "");
    const lines = text.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && ASK.test(stripNames(l)) && !SKIP.test(l.slice(0, 40)));
    if (!lines.length) continue;
    const hits = lines.slice(-6);
    cards.push({ id: t.id, title: t.title, status: t.status, line: t.line ?? "", seq: t.seq ?? "", hits, grades: hits.map(gradeOf), updatedAt: Number(t.updatedAt) || null });
  }
  cards.sort((a, b) => String(a.line).localeCompare(String(b.line), "zh"));
}

// ---------- ② 交接文档 ----------
const handoffs = [];
if (fs.existsSync(DOCS)) {
  for (const name of fs.readdirSync(DOCS)) {
    if (!/^交接-.*\.md$/.test(name)) continue;
    const full = path.join(DOCS, name);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    const blocks = text.split(/\r?\n(?=#{2,4}\s)/);
    const hits = [];
    for (const b of blocks) {
      const head = b.split("\n")[0] || "";
      if (!ASK.test(stripNames(head)) && !ASK.test(stripNames(b.slice(0, 200)))) continue;
      const body = b.split("\n").slice(0, 6).map((l) => l.trim()).filter(Boolean).slice(0, 3);
      if (body.length) hits.push(body.join(" / "));
    }
    const mtime = fs.statSync(full).mtimeMs;
    if (hits.length) handoffs.push({
      file: name, mtime, hits: hits.slice(0, 4),
      family: handoffFamily(name),
      cardIds: [...new Set((text.match(UUID_RE) || []).map((x) => x.toLowerCase()))],
    });
  }
  handoffs.sort((a, b) => b.mtime - a.mtime);

  // 「是否已办结」判定（2026-10-19 · 只读启发式，判据全部可解释）：
  //   superseded = 同族（剥日期/棒号）已有更新档 ⇒ 本份被取代
  //   live       = 档内引用的看板卡仍有在途（backlog/todo/running/review）⇒ 真在途
  //   closed     = 引用的卡全部能在本机账本里解析、且都不是在途 ⇒ 已办结
  //   stale      = 超 OVERDUE_DAYS 天且无任何在途卡引用 ⇒ 判不出但够老，按历史件收
  //   recent     = 近 7 天新档且判不出 ⇒ 保守列出（宁可多列，不可漏）
  //   ⚠️ 判据不替代人工：`--json` 里每份都带 verdict/verdictReason，随时可复核。
  const famLatest = new Map();
  for (const d of handoffs) {
    if (!famLatest.has(d.family) || famLatest.get(d.family) < d.mtime) famLatest.set(d.family, d.mtime);
  }
  for (const d of handoffs) {
    const refs = d.cardIds.map((id) => cardState.get(id) ?? "missing");
    d.openRefs = refs.filter((s) => OPEN.has(s)).length;
    const allClosed = refs.length > 0 && !refs.some((s) => s === "missing" || OPEN.has(s));
    if (famLatest.get(d.family) > d.mtime + 1000) {
      d.verdict = "superseded"; d.verdictReason = "同族已有更新的交接档";
    } else if (d.openRefs > 0) {
      d.verdict = "live"; d.verdictReason = `档内引用的卡仍有在途 ${d.openRefs} 张`;
    } else if (allClosed) {
      d.verdict = "closed"; d.verdictReason = "档内引用的卡全部已关（done/archived）";
    } else if (nowMs - d.mtime > overdueMs) {
      d.verdict = "stale"; d.verdictReason = `超 ${OVERDUE_DAYS} 天且无在途卡引用`;
    } else {
      d.verdict = "recent"; d.verdictReason = "近 7 天新档，判不出已办结（保守列出）";
    }
  }
}

// ---------- ③ 给对端机执行的单子 ----------
// 判据收紧：文件名像执行单/作业方案，或正文命中 ≥2 处「<对端机>侧执行」类措辞；跳过流水/日报/坑库等渲染物目录
const peerDocs = [];
const PEER_NAME = String(process.env.DSH_PEER_LABEL || "对端机").trim();
const PEER_RE = PEER_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PEER = new RegExp(`(?:${PEER_RE} ?侧执行|主人在 ?${PEER_RE}|主人上 ?${PEER_RE}|照本单执行|待 ?${PEER_RE} ?侧|${PEER_RE} ?侧照|交给 ?${PEER_RE}|开 ?${PEER_RE}|${PEER_RE} ?侧重|${PEER_RE} ?侧按)`);
const SKIP_DIR = /(变更流水|管家报告|坑库|长期库大扫除|_archive|大扫除)/;
const NAME_HINT = /(执行单|执行清单|执行卡|作业方案|接线执行)/;
// 不是执行单、且会自指造成回环的文档：本工具自己生成的清单（它整篇都在复述对端单的行，
// 被扫回来 ⇒ 每次刷新都自我复读一份）+ 文档总索引（只索引别的档名，本身无待办）。
const SELF_OUT = /^(待你操作-.*\.md|文档总索引\.md)$/;
if (fs.existsSync(DOCS)) {
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(full, depth + 1); continue; }
      if (!e.name.endsWith(".md")) continue;
      if (SELF_OUT.test(e.name)) continue;
      let text = "";
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      const matches = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => PEER.test(l));
      if (!matches.length) continue;
      if (!NAME_HINT.test(e.name) && matches.length < 2) continue;
      peerDocs.push({ file: path.relative(DOCS, full), mtime: fs.statSync(full).mtimeMs, hits: matches.slice(0, 4) });
    }
  };
  walk(DOCS, 0);
  peerDocs.sort((a, b) => b.mtime - a.mtime);
}

// ---------- ④ DSH 现场锁（升级失败 / 中断 —— ③ 包 C-6 段①②③ 的第三处视图） ----------
// 只在"需要人处置"的态里列：interrupted（中断现场）/ uncertain / unknown（判不了，保守当要人看）
// / phase=failed（自检未过 或 回滚失败）。正常无锁 / held（升级进行中）/ done 不列（不是"等你操作"）。
const lockNow = [];
if (typeof lockStatus === "function") {
  try {
    const st = lockStatus({ home: HOME });
    const failedPhase = st?.lock?.phase === "failed";
    const wantHuman = st?.state === "interrupted" || st?.state === "uncertain" || st?.state === "unknown" || failedPhase;
    if (st?.exists && wantHuman) {
      lockNow.push({
        state: st.state, step: st.lock?.step ?? null, phase: st.lock?.phase ?? null, note: st.lock?.note ?? null,
        backupDir: st.lock?.backupDir ?? null, summary: st.summary ?? "", hint: st.hint ?? null, file: st.file,
        severity: (st.state === "interrupted" || failedPhase) ? "🔴" : "🟡",
      });
    }
  } catch (e) {
    // 判据不可用 ≠ 没有锁：保守列出来（宁可多一行，不可静默）
    lockNow.push({ state: "unreadable", summary: `升级锁读不出来（判据不可用 ≠ 没有锁）：${e?.message ?? e}`, hint: "人工看 <HOME>/.dsh/upgrade-lock 与 <DSH_ROOT>/logs/alert.log", file: path.join(HOME, "upgrade-lock"), severity: "🟡" });
  }
} else {
  // 可选内核缺席（≠ 异常）：打印「不可探测」并继续；判定口径不变 —— 仍列一条、仍需人看一眼。
  lockNow.push({ state: "unavailable", summary: "升级锁：不可探测（本机没有 dsh-butler 内核；判据不可用 ≠ 没有锁）", hint: "若你装了 DSH 生态工具树，设 DSH_TOOLS_DIR 指向它；否则忽略本行", file: path.join(HOME, "upgrade-lock"), severity: "🟡" });
}

// ---------- ④b 守护鱼闸抑制（卡 ③-5 · 方案 §3.5(a) 的「持续 >1h ⇒ 待你操作一行」） ----------
// 口径：**判据不可用且持续 > 1h** 才列 —— 防"判据坏掉 ⇒ 守护鱼永久静默没人知"（同 P9 §17.2 T8 教训）。
//   升级链占位（held/uncertain/interrupted）导致的抑制是**正常让路**，只进日报段，不进「等你操作」清单
//   （否则每天升级都会在清单里刷一条噪音）。
// 数据源 = guard 落下的抑制记录（%TEMP%\dsh-guard\guard-lane-suppress.json）；
//   判定与文案同源 = tools\dsh-butler\lib\lane-gate.mjs（**绝不在此复制判据**）。
const guardNow = [];
try {
  const lg = await import(pathToFileURL(path.join(BUTLER_LIB, "lane-gate.mjs")).href);
  const rec = lg.readSuppress(null);
  if (rec && rec.judgeUnavailable === true) {
    const sinceMs = Date.parse(rec.since ?? rec.at ?? "");
    const heldMs = Number.isFinite(sinceMs) ? Date.now() - sinceMs : null;
    if (heldMs !== null && heldMs > lg.SUPPRESS_RED_AFTER_MS) guardNow.push({ heldMs, rec, lines: lg.suppressSectionLines(rec) });
  }
} catch { /* 判据库读不到 = 另一类问题（不是"有你的事"），不把清单变噪音源 */ }

// ④c 残留收敛待办（**P2-B · 2026-09-21 · G15/B4**）：护士被强杀留下的超期残留是**自动收敛**的
//   （守护鱼低频 + 护士启动自收敛 + 开机链第 0 步报残留）；只有「收敛失败」或「保守跳过
//   （pid 疑似存活）」才需要人来看 —— 正常收敛只进日报段，不刷主人的清单（否则又成噪音源）。
// 数据源 = 三层挂点共用的记录 `%TEMP%\dsh-guard\guard-residue-reap.json`；
//   判定与文案同源 = tools\dsh-butler\lib\residue-reaper.mjs（**绝不在此复制判据**）。
const residueNow = [];
try {
  const rr = await import(pathToFileURL(path.join(BUTLER_LIB, "residue-reaper.mjs")).href);
  const rec = rr.readResidueRecord(null);
  const bad = (rec && Array.isArray(rec.failed)) ? rec.failed.length : 0;
  const skip = (rec && Array.isArray(rec.skipped)) ? rec.skipped.length : 0;
  if (rec && (bad > 0 || skip > 0)) residueNow.push({ rec, bad, skip, lines: rr.residueSectionLines(rec) });
} catch { /* 判据库读不到 = 另一类问题，不把清单变噪音源 */ }

// ---------- ④d 到期责任制（O-5 · **T+7d 上升为「待拍板」项**）----------
// 口径（2026-10-10 · 冲刺600·补可观测 B3 / gap-3-44）：
//   「悬项挂多久」这一维此前**没有判据**（台账原话：T+48h『未验证』可见，T+7d 上升判据未见专用实现）。
//   判据 = 载体**最近一次动过**的时刻（卡 `updatedAt` / 交接档 mtime / 对端单 mtime）距今 **> 7 天**
//     ⇒ 该悬项「已悬 7 天没人动」⇒ 在本清单里**上升**（首部汇总 + 每项标 ⏰），提请主人一句话。
//   ⚠️ 只读：不写任何状态、不改卡；判据全部用**既有时间戳**，不新增任何记录面。
//   ⚠️ 用 `updatedAt`（最近一次动过）而不是 `createdAt`：卡一直在推进 ≠ 悬项没人管；
//      只有"7 天没人动过这张卡"才说明那个「待拍板」真的悬着。
const overdue = [];
for (const c of cards) {
  if (Number.isFinite(c.updatedAt) && nowMs - c.updatedAt > overdueMs) {
    overdue.push({ kind: "卡", label: `${c.title}（\`${String(c.id).slice(0, 8)}\` · ${c.status}）`, staleMs: nowMs - c.updatedAt, at: c.updatedAt });
  }
}
for (const d of handoffs) {
  if (Number.isFinite(d.mtime) && nowMs - d.mtime > overdueMs) overdue.push({ kind: "交接档", label: d.file, staleMs: nowMs - d.mtime, at: d.mtime, verdict: d.verdict, verdictReason: d.verdictReason });
}
for (const d of peerDocs) {
  if (Number.isFinite(d.mtime) && nowMs - d.mtime > overdueMs) overdue.push({ kind: "对端单", label: d.file, staleMs: nowMs - d.mtime, at: d.mtime, verdict: "peer" });
}
overdue.sort((a, b) => b.staleMs - a.staleMs);

// 档位统计（2026-10-14 主人令）：`self` = 本鱼**该自己办掉却还列着**的条目数 —— 它长期 > 0 就是本鱼又在攒债。
const gradeStats = { self: 0, red: 0, unknown: 0 };
for (const c of cards) for (const g of (c.grades ?? [])) gradeStats[g] = (gradeStats[g] ?? 0) + 1;

// ---------- 输出视图（2026-10-19 · 卡「待你操作清单与禁攒债打架」） ----------
// 正文只留「真得主人一句话 / 到场」的：甲档（self）条目与历史交接档不逐条占正文，
// 各留一行计数；**完整明细仍在 --json**（既有字段名/结构不变，只新增 verdict 类字段）。
const HISTORICAL = new Set(["superseded", "closed", "stale"]);
const isHistorical = (d) => HISTORICAL.has(d.verdict);
const cardsShown = cards
  .map((c) => {
    const kept = (c.hits ?? [])
      .map((h, i) => ({ text: h, grade: c.grades?.[i] ?? "unknown" }))
      .filter((x) => x.grade !== "self");   // 甲档 = 本鱼该自办 ⇒ 不进正文
    return kept.length ? { ...c, hits: kept.map((x) => x.text), grades: kept.map((x) => x.grade) } : null;
  })
  .filter(Boolean);
const handoffsShown = handoffs.filter((d) => !isHistorical(d));
const handoffsHidden = handoffs.length - handoffsShown.length;
const overdueCards = overdue.filter((o) => o.kind === "卡");
const overduePeerDocs = overdue.filter((o) => o.kind === "对端单");
const overdueLiveDocs = overdue.filter((o) => o.kind === "交接档" && o.verdict === "live");
const overdueHistDocs = overdue.filter((o) => o.kind === "交接档" && o.verdict !== "live");

const out = { generatedAt: Date.now(), device: DEV, overdueDays: OVERDUE_DAYS, gradeStats, counts: { lockNow: lockNow.length, guardNow: guardNow.length, residueNow: residueNow.length, cards: cards.length, handoffs: handoffs.length, peerDocs: peerDocs.length, overdue: overdue.length, cardsShown: cardsShown.length, handoffsShown: handoffsShown.length, overdueHistorical: overdueHistDocs.length }, lockNow, guardNow, residueNow, cards, handoffs, peerDocs, overdue };

if (JSON_OUT) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`等你操作 / 待拍板 悬项扫描（只读）· 设备 ${DEV}${INCLUDE_DONE ? " · 含 done 卡" : " · 仅看板在途卡"}`);
  console.log(`\n【〇】DSH 现场锁（升级失败 / 中断）${lockNow.length} 条`);
  for (const k of lockNow) {
    console.log(`\n  ${k.severity} 升级锁 ${k.state}${k.phase ? ` · phase=${k.phase}` : ""}${k.note ? ` · note=${k.note}` : ""}`);
    console.log(`     ▸ ${clip(k.summary, 260)}`);
    if (k.hint) console.log(`     ▸ 处置：${clip(k.hint, 260)}`);
  }
  console.log(`\n【〇b】守护鱼闸抑制（判据不可用 >1h）${guardNow.length} 条`);
  for (const g of guardNow) for (const l of g.lines) console.log(`  ${l}`);
  console.log(`\n【〇c】残留收敛未自动收尾${residueNow.length} 条`);
  for (const g of residueNow) for (const l of g.lines) console.log(`  ${l}`);
  console.log(`\n【〇d】⏰ T+${OVERDUE_DAYS}d 到期：在途卡 ${overdueCards.length} 张 + 在途文档 ${overdueLiveDocs.length} 份 + 疑似历史件 ${overdueHistDocs.length} 份 + 对端单 ${overduePeerDocs.length} 份（悬 ${OVERDUE_DAYS} 天没人动）`);
  for (const o of overdueCards) console.log(`  ⏰ 卡：${o.label} — 最近动过 ${T(o.at)}（已 ${(o.staleMs / 86400000).toFixed(1)} 天）`);
  for (const o of overdueLiveDocs) console.log(`  ⏰ ${o.kind}：${o.label} — 已 ${(o.staleMs / 86400000).toFixed(1)} 天`);
  for (const o of overduePeerDocs) console.log(`  ⏰ ${o.kind}：${o.label} — 已 ${(o.staleMs / 86400000).toFixed(1)} 天`);
  if (overdueHistDocs.length) console.log(`  🗄 疑似历史件 ${overdueHistDocs.length} 份（已判办结/被更新档取代，明细见 --json 的 overdue）`);
  console.log(`\n【一】看板卡里的悬项 ${cardsShown.length} 张　🔴红线 ${gradeStats.red} 条 / ❔未定档 ${gradeStats.unknown} 条　🔧甲档应自办 ${gradeStats.self} 条（按 §11.9 已自行消化，明细见 --json）`);
  for (const c of cardsShown) {
    console.log(`\n  [${c.status}] ${c.line}${c.seq ? " " + c.seq : ""} | ${c.title}`);
    console.log(`     ${c.id.slice(0, 8)}`);
    c.hits.forEach((h, i) => console.log(`     ${gradeLabel(c.grades?.[i])} ▸ ${clip(h, 240)}`));
  }
  console.log(`\n【二】给对端机执行的单子 ${peerDocs.length} 份`);
  for (const d of peerDocs) {
    console.log(`\n  ${d.file}  (${T(d.mtime)})`);
    for (const h of d.hits) console.log(`     ▸ ${clip(h, 260)}`);
  }
  console.log(`\n【三】交接文档里的悬项 ${handoffsShown.length} 份（另有 ${handoffsHidden} 份历史件未列出）`);
  for (const d of handoffsShown) {
    console.log(`\n  ${d.file}  (${T(d.mtime)})`);
    for (const h of d.hits) console.log(`     ▸ ${clip(h, 260)}`);
  }
}

// ---------- --write ----------
if (WRITE) {
  const stamp = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ");
  const L = [];
  L.push(`# ⏳ 待你操作 · ${DEV}`, "");
  L.push(`> 生成 **${stamp}**（北京）· 扫描器 \`node owner-todo-scan.mjs --write\`（只读：看板卡 description ＋ docs 交接文档 ＋ 给对端机执行的单子）。`);
  L.push(`> ⚠️ **本文件每次刷新会被整体重写**——想留痕请写进对应卡的 description 或交接文档，别只写在这里。`);
  L.push(`> 背景：会话标题的【完成】只表示"这一轮说完了"，不代表活闭环；真正等你的事以本清单为准。`);
  L.push("");
  L.push(`## 〇、DSH 现场（升级失败 / 中断）· ${lockNow.length} 条`, "");
  if (!lockNow.length) L.push("_（无：升级锁当前不在「需要人处置」的态）_", "");
  for (const k of lockNow) {
    L.push(`### ${k.severity} 升级锁 ${k.state}${k.phase ? ` · phase=${k.phase}` : ""}${k.note ? ` · note=${k.note}` : ""}`, "");
    L.push(`- ${clip(k.summary, 400)}`);
    if (k.hint) L.push(`- 处置：${clip(k.hint, 400)}`);
    if (k.backupDir) L.push(`- 备份目录：\`${k.backupDir}\`（回滚入口 \`<backupDir>\\restore-upgrade.mjs\`）`);
    L.push(`- 锁文件：\`${k.file}\``);
    L.push("- 另两处视图：`~/.dsh/butler-alert.log`（升级锁告警行）＋ 当天日报「🔒 升级锁（B3 前置）」段");
    L.push("");
  }
  // ④b 守护鱼闸抑制（卡 ③-5）：只有"判据不可用 >1h"才进本清单（正常让路只进日报段）
  if (guardNow.length) {
    L.push(`### 🐟 守护鱼闸：跨线判据不可用已 > 1h（${guardNow.length} 条）`, "");
    for (const g of guardNow) for (const l of g.lines) L.push(l);
    L.push("- 处置：修好升级锁 / 交接锁的可解析性（或人工收尾升级）—— 判据恢复后守护鱼自动恢复接管能力；**期间不接管连崩**。");
    L.push("");
  }
  // 〇c 残留收敛未自动收尾（P2-B · G15/B4）
  if (residueNow.length) {
    L.push(`### 🧹 残留收敛：有未自动收尾项（${residueNow.length} 条）`, "");
    for (const r of residueNow) for (const l of r.lines) L.push(l);
    L.push("- 处置：①「保守跳过」⇒ 先确认那几个 pid 是不是真的护士进程（`tasklist /FI \"PID eq <pid>\"`）：是则等它自己走 ⑤.5 收尾，不是则下一轮低频检查会自动释放；②「释放失败」⇒ `node dsh-upgrade-silence.mjs --status` 看剩余持有者，必要时 `--enable --holder <id>`；③ 接管声明残留（`<safeRoot>\\case-*\\takeover.json`）确认那个 case 确实死了可直接删。");
    L.push("");
  }
  L.push(`## 一、要你一句话的（在途卡的「待拍板」段）· ${cardsShown.length} 张`, "");
  L.push(`> 🔴 红线 ${gradeStats.red} 条 · ❔ 未定档 ${gradeStats.unknown} 条（判据 = 驾照 §11 关键词分拣，见脚本头「档位分拣」段）。`, "");
  L.push(`> 🔧甲档应自办 ${gradeStats.self} 条（按 §11.9 已自行消化，明细见 \`node owner-todo-scan.mjs --json\`）。`, "");
  if (!cardsShown.length) L.push("_（无）_", "");
  // 〇d 到期责任制（O-5 · T+7d 上升）：悬了 7 天没人动过的，单独提到最前面 —— 它们比新悬项更该被看见
  if (overdue.length) {
    L.push(`### ⏰ 已悬 ${OVERDUE_DAYS} 天没人动（到期责任制 · 卡 ${overdueCards.length} 张 / 在途文档 ${overdueLiveDocs.length} 份 / 对端单 ${overduePeerDocs.length} 份）`, "");
    L.push(`> 判据 = 载体最近一次动过的时刻（卡 updatedAt / 交接档 mtime / 对端单 mtime）距今 > ${OVERDUE_DAYS} 天。`);
    L.push(`> 文档类先判**是否已办结**（同族已有更新档 / 档内引用卡全关 / 超 ${OVERDUE_DAYS} 天无在途卡关联）⇒ 历史件只留一行计数、不逐条占正文；**卡类是硬判据**（在途卡 7 天没动，逐条列）。`);
    for (const o of overdueCards) L.push(`- ⏰ **卡**：${o.label} — 最近动过 ${T(o.at)}（已 ${(o.staleMs / 86400000).toFixed(1)} 天）`);
    for (const o of overdueLiveDocs) L.push(`- ⏰ ${o.kind}：${o.label} — 已 ${(o.staleMs / 86400000).toFixed(1)} 天`);
    for (const o of overduePeerDocs) L.push(`- ⏰ ${o.kind}：${o.label} — 已 ${(o.staleMs / 86400000).toFixed(1)} 天`);
    if (overdueHistDocs.length) L.push(`- 🗄 疑似历史件 ${overdueHistDocs.length} 份（判据见上一行；明细见 \`node owner-todo-scan.mjs --json\` 的 overdue 数组，含 verdict）`);
    L.push("");
  }
  cardsShown.forEach((c, i) => {
    L.push(`### ${i + 1}. [${c.status}] ${c.line}${c.seq ? " " + c.seq : ""} — ${c.title}`, "");
    L.push(`\`${c.id.slice(0, 8)}\``, "");
    c.hits.forEach((h, j) => L.push(`- ${gradeLabel(c.grades?.[j])} ${clip(h, 400)}`));
    L.push("");
  });
  L.push(`## 二、要你在另一台机上执行/看的单子 · ${peerDocs.length} 份`, "");
  if (!peerDocs.length) L.push("_（无）_", "");
  for (const d of peerDocs) {
    L.push(`### ${d.file}`, "");
    L.push(`*最近修改 ${T(d.mtime)}*`, "");
    for (const h of d.hits) L.push(`- ${clip(h, 400)}`);
    L.push("");
  }
  L.push(`## 三、交接文档里的悬项 · ${handoffsShown.length} 份`, "");
  L.push(`> 只列**判为在途**的交接档（引用卡仍有在途项 / 近 ${OVERDUE_DAYS} 天新档）；已办结或被同族更新档取代的 ${handoffsHidden} 份不逐条列出（\`--json\` 的 \`handoffs[].verdict\` 可复核）。`, "");
  if (!handoffsShown.length) L.push("_（无）_", "");
  for (const d of handoffsShown) {
    L.push(`### ${d.file}`, "");
    for (const h of d.hits) L.push(`- ${clip(h, 400)}`);
    L.push("");
  }
  const target = path.join(DOCS, `待你操作-${DEV}.md`);
  // §2.2 档级标记（`todo` 族 · 方案 §3.1）：插入点由权威源 `insertAtFor()` 按文档真实 H1 定（落点 L2）
  const docBody = L.join("\n") + "\n";
  fs.writeFileSync(target, stampDocMark(docBody, "todo", insertAtFor(firstH1Index(docBody))), "utf8");
  console.log(`\n[write] 已刷新 ${target}`);
}
process.exitCode = 0;

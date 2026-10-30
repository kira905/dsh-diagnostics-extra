# dsh-diagnostics-extra · DSH 诊断与对账小工具

> DeepSeek Harness（DSH）生态里**出问题时真正会去跑**的几件只读诊断工具：
> **图片附件对账 / 取回**（从别的机器同步来的含图会话为什么一续聊就报 TRANSPORT）、
> **一条命令答清「现在哪台机在跑、dsh 与守护鱼何时起、3080 端口连了谁」**、
> **把散落在看板卡 / 交接文档 / 对端执行单里的「等你操作」合成一张清单**。
>
> 全部 **Node.js ≥ 20**、**零第三方运行时依赖**（只用 `node:` 内置模块）。Windows 优先。

---

## ⚠️ 先读这段（比任何用法都重要）

1. **`owner-todo-scan.mjs` 自 2026-10-30 起已支持 `--help`（打印用法、退出码 0）与未知参数拒收
   （退出码 2，绝不继续执行）** —— 敲错参数会被拦下，不会带着 `--write` 去重写清单。
   用法文本里写明了它唯一的写动作：`--write` 会**整体重写 `docs\待你操作-<设备>.md`**。
   ⇒ 拿不准就先 `--help`，或先读脚本头部注释。
2. **另外三件**：`attachments-audit.mjs` / `attachments-fetch.mjs` / `dsh-why.mjs`
   也都实现了 `-h` 与帮助输出，**未知参数会报错并停在用法提示**（不会执行真动作）。
   本文件仍不在代码块里给帮助示例 —— 四件的参数写法差异大，照抄逐件表最稳。
3. **写动作只有两处**：`attachments-fetch.mjs` 的取回落盘（可 `--dry-run` 预演、`--report` 留报告、`--rollback` 回退）
   与 `owner-todo-scan.mjs --write` 的清单刷新（整体重写）。其余全部只读。
4. 本仓工具**不做任何网络请求、不读凭据文件**。它们只读本机 DSH 数据根与 docs 树。

---

## 1. 环境与安装

```powershell
# Node 20+；无需 npm install（零依赖）
node --version

# 直接用（在仓根）
node attachments-audit.mjs --json
node dsh-why.mjs --log-lines 20

# 或者装到全局用 bin 名
npm i -g @kira905/dsh-diagnostics-extra
dsh-attachments-audit --json
```

### 环境变量（都可选）

| 变量 | 含义 | 缺省 |
|---|---|---|
| `DSH_ROOT` | DSH 工作区根（放 `docs\`、`tools\`、`_archive\` 的那棵树） | `~/DSH` |
| `DSH_HOME` / `BUTLER_DSH_HOME` | DSH home（`sessions`、`attachments`、`task-board` 所在处） | `~/.dsh` |
| `DSH_WORKSPACE` | 覆盖工作区根解析（优先于 `DSH_HOME` 推导） | 由 `DSH_HOME` / `DSH_ROOT` 推导 |
| `DSH_DOCS_DIR` | `owner-todo-scan` 扫的文档目录 | `<workspace>/docs` |
| `DSH_TOOLS_DIR` | DSH 工具树根（可选内核的父目录） | `<workspace>/tools` |
| `DSH_BUTLER_LIB` | 可选内核目录（`upgrade-lock.mjs` / `lane-gate.mjs` / `residue-reaper.mjs`） | `<DSH_TOOLS_DIR>/dsh-butler/lib` |
| `DSH_DEVICE_LABEL` | 设备展示名（清单文件名 / 体检短码；不设则用主机名） | 主机名 |
| `DSH_PEER_LABEL` | 「对端机」在本线的叫法（对端执行单判据用） | `对端机` |
| `DSH_ATTACH_RELAY` | 附件中转目录（一个，`attachments-fetch` 优先取） | 见该件说明 |

> 这些工具原本长在一棵私有工作树里。**发布版把所有本机绝对路径改成了
> `DSH_ROOT` / `os.homedir()` / 环境变量 + 相对路径**；机器名与用户名换成了通用占位。
> 第一次在自己机器上用，先设 `DSH_ROOT`（否则默认按 `~/DSH` 找 `docs\`）。

---

## 2. 仓库结构（全量文件）

```
dsh-diagnostics-extra/
├── attachments-audit.mjs        # 会话引用的图片附件 vs 本机实体：只读对账
├── attachments-fetch.mjs        # 按 sha256 取回缺失附件 / 导出 / 回滚（会写盘，可 dry-run）
├── dsh-why.mjs                  # 只读现状体检：机器 / dsh 与守护鱼何时起 / 3080 连接 / 日志尾
├── owner-todo-scan.mjs          # 扫「等你操作 / 待拍板」悬项（--write 会重写清单）
├── lib/
│   ├── dsh-home.mjs             # DSH home / workspace / 报告目录解析
│   ├── attach-refs.mjs          # 会话日志里的附件引用解析 + 对象路径（sha256 口径）
│   ├── session-file-name.mjs    # 会话日志文件名判据（认全世代，防按精确文件名失明）
│   ├── powershell-exe.mjs       # PowerShell 解释器选择（pwsh 7 优先，5.1 兜底）
│   ├── redact.mjs               # 输出脱敏（键名 or 值形态双判据；只影响显示）
│   └── generated-docs.mjs       # 「自动生成档」判级标记与家族匹配（纯常量 + 纯函数）
├── README.md
├── README.en.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── .gitignore
└── .gitattributes
```

> 闭包里还有 `lib/session-file-name.mjs`：`attach-refs.mjs` 的会话文件名判据来自它，
> 不带上它会在主包换代（`session.vN.jsonl.zstd`）时**整条失明**。

---

## 3. 逐件说明

### 3.1 `attachments-audit.mjs` —— 图片附件对账（只读）

**它回答什么**：从另一台机同步来的「含图会话」在本机续聊必挂，报
`DeepSeek API stream from … failed` / `code=TRANSPORT`。看着像网络，其实是历史图片实体
（`<DSH_HOME>/attachments/v1/objects/<sha前2位>/<sha256>`）不在本机 —— 每轮请求前会扫**全部历史消息**里的图，
读不到实体就抛普通 Error，被兜底 catch 归成 TRANSPORT。
本工具把「缺哪些对象 / 哪些会话受影响」变成看得见的事实。

| 参数 | 说明 |
|---|---|
| `--home <dir>` | 覆盖 DSH home（默认按 `BUTLER_DSH_HOME` → `DSH_HOME` → `~/.dsh`） |
| `--session <id\|前缀>` | 只看一个会话 |
| `--json` | 机器可读输出 |
| `--quiet` | 只出退出码（给开机 / 交接挂点用） |
| `--no-cache` | 忽略缓存全量重扫 |
| `--cache <file>` | 覆盖缓存文件（默认 `<home>/butler-attach-scan.json`） |
| `--top <n>` | 摘要里最多列几个会话（默认 20） |
| `--sessions-only` | 只列会话，不逐对象展开 |
| `--verify-objects` | 对命中的对象再算一遍 sha256（慢，但能抓「实体在、内容错」） |

**退出码**：`0` 无缺失 · `3` 有缺失 · `2` 用法错 · `4` 环境不可用（读不到会话/附件根）。
⚠️ `4` 是 fail-closed：**读不到 ≠ 没缺失**。

**只读声明**：除自身缓存（`butler-attach-scan.json`）外不写任何文件；缓存键 = 相对路径 + size + mtimeMs
（mtime 会被复制/搬动骗过，所以同时含 size）。

### 3.2 `attachments-fetch.mjs` —— 缺失附件取回 / 导出 / 回滚（会写盘）

**它做什么**：按 sha256 把缺失的图片对象补回 `<DSH_HOME>/attachments/v1/objects/<2>/<sha>`，
布局与 DSH 完全一致。取回源按优先级：`--from` → `--relay` / `DSH_ATTACH_RELAY` / 常见中转目录 →
本机派生源（`<home>/dsh-imagegen/{images,gallery/images}`、`<workspace>/generated`，按内容 sha 命中）。

| 参数 | 说明 |
|---|---|
| `--hash <sha256>` | 取回指定对象（可重复，也支持逗号分隔） |
| `--session <id\|前缀>` | 取回该会话引用的全部缺失对象 |
| `--all-missing` | 全量对账后补所有缺失 |
| `--probe` | 只列可用取回源与覆盖率（**纯只读**） |
| `--export <dir>` | 反向：把本机引用到的附件导出成中转包 |
| `--rollback <报告.json>` | 按报告删除本次新写文件 |
| `--from <path>` | 取回源（可重复；对端 attachments 根 / v1 / objects / 任意目录，自动识别层级） |
| `--relay <dir>` | 中转目录（可重复） |
| `--local-source <dir>` | 追加本机派生源（可重复） |
| `--no-local-sources` | 不扫本机派生源 |
| `--home <dir>` | 覆盖 DSH home |
| `--verify` / `--no-verify` | 落位后二次校验 sha256（默认开） |
| `--dry-run` | 只打印计划，不写盘 |
| `--force` | 目标已存在但内容不符时覆盖（默认报 conflict、不覆盖） |
| `--json` / `--report <file>` / `--quiet` | 输出形态 / 落报告 / 只出退出码 |

**退出码**：`0` 全部就位 · `3` 有未找到源的缺失 · `4` 有失败（写盘/校验） · `2` 用法错。

**落盘铁律**：写同目录临时文件 → 校验 sha256 → `rename` 原子落位 → 重读二次校验；
已存在且 sha 一致 ⇒ skip（幂等）；内容不符 ⇒ conflict，**不覆盖**（除非 `--force`）。

> **第一次用先跑 `--probe --dry-run`**：它只列源与覆盖率，不写盘。

### 3.3 `dsh-why.mjs` —— 只读现状体检

**一条命令答清**：① 现在跑在哪台机 ② dsh 与守护鱼何时起（**dsh 主进程 = 3080 LISTEN 的 owner**，不靠命令行匹配）
③ 3080 端口连接情况 ④ 守护鱼状态与日志尾。

| 参数 | 说明 |
|---|---|
| `--json` | 机器可读（只落 stdout；日志不污染） |
| `--log-lines <n>` | 日志尾行数（默认 12；`0` = 不打印） |
| `--procs-file <p>` | 用离线进程表 JSON 代替实时 CIM（自测 / 负样例 / 异机复现；输出会标注来源） |

**只读声明**：不挂钩子、不进任何强制流程、**不写任何文件**。

**输出脱敏**：本件会打印进程命令行 / 环境 / 日志尾（命令行里常带 key/token）⇒
输出前按「键名 or 值形态」双判据脱敏（`lib/redact.mjs`；只影响显示，不改判定）。

**设备短码**：默认把主机名 slug 化（`DSH_DEVICE_LABEL` 可覆盖），不锁任何具体机器。

### 3.4 `owner-todo-scan.mjs` —— 「等你操作」清单（`--write` 会重写清单）

**为什么需要**：会话标题的【完成】只表示「这一轮说完了」，不等于活闭环。真正等你的事散落在四处：
看板卡 description 里的「待拍板 / 待主人 / 等你」段 · `docs\交接-*.md` 里的悬项 ·
给对端机执行的单子 · DSH 现场升级锁（中断 / 不可判定 / phase=failed）。

| 参数 | 说明 |
|---|---|
| （无参数） | 在途卡 + 交接文档 + 对端执行单 |
| `--all` | 追加 done 卡里的「待拍板」历史段（噪声多，兜底用） |
| `--write` | 落 `docs\待你操作-<设备>.md`（**整体重写刷新**） |
| `--json` | 机器可读（明细最全：`cards[].hits/grades`、`handoffs[].verdict`） |

⚠️ **本件没有帮助命令，未知参数会被静默忽略并直接执行**（`--write` 时就是真写盘）。

**档位分拣**：每条按「自主授权」关键词分 `🔧甲档(应自办)` / `🔴红线(待主人)` / `❔未定档`；
甲档条目**不进 Markdown 正文**（只在段头留计数），明细仍完整保留在 `--json`。

**输出**：`待你操作-<设备>.md` 带档级标记（`todo` 族），插入点由 `lib/generated-docs.mjs`
的 `insertAtFor(firstH1Index(...))` 决定，**整体重写**。

### 3.5 `owner-todo-scan.mjs` 的可选内核依赖（重要，别当成缺件）

「升级锁 / 守护鱼闸抑制 / 残留收敛」三节的**判定实现不在本仓**，它们长在 DSH 私有工具树
（`tools/dsh-butler/lib/`）里：

| 模块 | 用途 | 本仓缺席时 |
|---|---|---|
| `upgrade-lock.mjs` | 升级锁 `status()` 的**唯一真源** | 打印一行「升级锁：不可探测（判据不可用 ≠ 没有锁）」并继续 |
| `lane-gate.mjs` | 守护鱼闸抑制判据 + 文案 | 静默跳过（该类不是「有你的事」，不刷噪音） |
| `residue-reaper.mjs` | 残留收敛记录判据 + 文案 | 静默跳过（同上） |

**为什么这样拆**：本仓不做「第二份判定实现」——复制判据就是口径漂移的起点。
发布版只把**静态 import 改成动态加载**，内核在时行为与私有树**逐字同源**，内核缺席时按上表降级；
**判定口径（哪些态要人处置）没有改一个字**。

想启用真判据：`DSH_TOOLS_DIR` 指向工具树（默认 `<workspace>/tools`），或 `DSH_BUTLER_LIB` 直接指到 `dsh-butler/lib`。

---

## 4. 两件附件工具的配合（推荐顺序）

```powershell
# 1) 先对账（只读）：缺多少、影响哪些会话
node attachments-audit.mjs --json > audit.json

# 2) 再看源（只读）：有哪些取回源、覆盖率多少
node attachments-fetch.mjs --probe

# 3) 预演（不写盘）：看它准备写哪些对象
node attachments-fetch.mjs --all-missing --dry-run --report plan.json

# 4) 真取回（写盘；默认二次校验）
node attachments-fetch.mjs --all-missing --report fetch.json

# 5) 出问题就按报告回退（只删本次新写文件）
node attachments-fetch.mjs --rollback fetch.json
```

---

## 5. 安全与隐私

- **不联网**：四件都不做 HTTP 请求。
- **不读凭据**：不碰 `credentials.yaml` / token / 环境变量里的密钥。
- **只在你指定/推导出的本机路径上读写**：`DSH_HOME`、`DSH_ROOT`、`docs`；写动作见 §3.2 / §3.4。
- **输出里的敏感字串**（key/token 形状）在 `dsh-why` 侧按 `lib/redact.mjs` 脱敏。
- 扫描的是**你自己的**会话日志与看板账本；别把这些数据提交进公开仓。

---

## 6. 许可

本仓代码以 **AGPL-3.0 + 商业授权**（双许可）发布，详见 [LICENSE](LICENSE)。
简言之：**要么按 AGPL-3.0 使用/修改并让衍生作品同样开源，要么取得商业授权**。
（AGPL 本身不禁止商用；「+ 商业授权」是双许可，不是禁商用条款。）

---

## 7. 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。首个公开版本 `v0.1.0`（2026-10-19）。

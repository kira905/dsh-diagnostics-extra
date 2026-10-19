// ============================================================
//  attach-refs.mjs — 会话附件引用 / 附件对象 共享库（卡 AT1 · 2026-09-16）
//  ------------------------------------------------------------
//  为什么需要：`attachments-audit.mjs`（只读对账）与 `attachments-fetch.mjs`（按需取回）
//  必须用**同一套口径**解析「会话引用了哪些 sha256」「对象该落在哪」——两套实现必然漂移。
//
//  口径真源（全部来自主包源码，改前先复核）：
//    · 实体路径   `<DSH_HOME>/attachments/v1/objects/<sha256前2位>/<sha256>`
//                 （@deepseek-ai/dsh-attachment-local/lib/index.js 的 objectPath()）
//    · sha 形态   `^sha256:[a-f0-9]{64}$`（同文件 ID_PATTERN，强制小写十六进制）
//    · 会话文件   `<DSH_HOME>/sessions/**_/session[.vN].jsonl.zstd`（0.1.5 起为
//                 `session.v3.jsonl.zstd`；判据真源 `lib/session-file-name.mjs`，**认全世代**；
//                 多帧 zstd 拼接，append-only，
//                 逐帧解压 —— 只解第一帧会漏事件：与 dsh-session-probe.mjs 同判据）
//    · 引用形态   事件 JSON 里 `{type:"image", attachment:{attachmentId:"sha256:…",…}}`，
//                 且 tool-result 内容里也嵌图 ⇒ 递归收集，不能只看第一层
//
//  只读库：本文件不做任何写操作。
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
// 会话日志文件名判据**唯一真源**（卡「修·V3判据③」2026-09-24）：
//   0.1.5 起落盘名 `session.jsonl.zstd` → `session.v3.jsonl.zstd`，读取侧必须认全世代。
import { isSessionFileName, SESSION_FILE_NAME_LEGACY } from './session-file-name.mjs'

/** zstd 帧魔数（多帧拼接文件的切帧依据）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * @deprecated 会话日志文件名**已世代化**（0.1.5 起 `session.jsonl.zstd` → `session.v3.jsonl.zstd`）：
 *   读取侧一律用 `isSessionFileName()`（认全世代），**禁拿本常量做文件名比较**。
 *   保留导出只为历史消费者不炸（与 `pitfall-scan.mjs` 同款处置）。
 */
export const SESSION_FILE_NAME = SESSION_FILE_NAME_LEGACY

/** 附件 id 严格形态（与主包 ID_PATTERN 同源）。 */
const ATTACHMENT_ID_RE = /^sha256:([a-f0-9]{64})$/

/** 宽松扫描用（日志/文本里找 sha 引用；文件名与目录名都是小写）。 */
const SHA_IN_TEXT_RE = /sha256:([a-f0-9]{64})/g

/** 是否为合法 sha256 十六进制（小写）。 */
export function isSha256(v) {
  return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
}

/** 归一化用户输入的 hash：接受裸 sha / `sha256:<sha>` / 大写。返回 null 表示非法。 */
export function normalizeSha(input) {
  if (typeof input !== 'string') return null
  const s = input.trim().toLowerCase().replace(/^sha256:/, '')
  return isSha256(s) ? s : null
}

/** 附件实体路径（唯一口径，别在调用方另拼）。 */
export function objectPathFor(objectsRoot, sha) {
  return path.join(objectsRoot, sha.slice(0, 2), sha)
}

/** 附件对象根（由 DSH_HOME 推出）。 */
export function objectsRootFor(home) {
  return path.join(home, 'attachments', 'v1', 'objects')
}

/** 附件根（request-images / tmp 的同级）。 */
export function attachmentsRootFor(home) {
  return path.join(home, 'attachments', 'v1')
}

/** 文件 sha256（小写十六进制）。 */
export function sha256File(file) {
  const buf = fs.readFileSync(file)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 字节 sha256。 */
export function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// ---------------------------------------------------------------- 会话帧解析

/**
 * 把多帧 zstd 拼接缓冲切成帧（与 dsh-session-probe.mjs 同实现）。
 * @param {Buffer} buf
 * @returns {Buffer[]}
 */
export function splitFrames(buf) {
  const starts = []
  let i = 0
  while (i >= 0 && i < buf.length) {
    const j = buf.indexOf(ZSTD_MAGIC, i)
    if (j < 0) break
    starts.push(j)
    i = j + 4
  }
  return starts.map((s, k) => buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length))
}

/**
 * 逐帧解压会话缓冲。
 * ⚠️ 只解第一帧会把完整会话误判成空会话（仓2 空壳判据的历史教训）。
 * @param {Buffer} buf
 * @returns {{text:string, frames:number, badFrames:number, bytes:number}}
 */
export function decodeSessionBuffer(buf) {
  const frames = splitFrames(buf)
  const parts = []
  let badFrames = 0
  for (const f of frames) {
    try { parts.push(zlib.zstdDecompressSync(f)) } catch { badFrames++ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length, badFrames, bytes: buf.length }
}

/** 读文件并解码（IO 版）。 */
export function decodeSessionFile(file) {
  return decodeSessionBuffer(fs.readFileSync(file))
}

/**
 * 递归收集一个会话事件里的附件引用（`attachmentId` 字段，任意深度；tool-result 内容里的图也在内）。
 * @param {unknown} node 已 JSON.parse 的事件
 * @param {Array<{sha:string, ref:object}>} out
 */
export function collectRefsFromEvent(node, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) collectRefsFromEvent(v, out)
    return
  }
  const id = node.attachmentId
  if (typeof id === 'string') {
    const m = ATTACHMENT_ID_RE.exec(id)
    if (m) out.push({ sha: m[1], ref: node })
  }
  for (const v of Object.values(node)) collectRefsFromEvent(v, out)
}

/**
 * 从会话文本（多行 JSONL）收集全部附件引用（去重后按 sha 归并）。
 * @param {string} text
 * @returns {{refs: Map<string, {sha:string, count:number, sample:object}>, badLines:number, events:number}}
 */
export function collectSessionRefs(text) {
  const refs = new Map()
  let badLines = 0
  let events = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let obj
    try { obj = JSON.parse(line) } catch { badLines++; continue }
    events++
    const found = []
    collectRefsFromEvent(obj, found)
    for (const { sha, ref } of found) {
      let rec = refs.get(sha)
      if (!rec) { rec = { sha, count: 0, sample: ref }; refs.set(sha, rec) }
      rec.count++
    }
  }
  return { refs, badLines, events }
}

/** 文本里出现的 sha256（宽松扫描，用于报告里的 `sha256:` 摘录）。 */
export function scanShaInText(text) {
  const out = new Set()
  SHA_IN_TEXT_RE.lastIndex = 0
  let m
  while ((m = SHA_IN_TEXT_RE.exec(text)) !== null) out.add(m[1])
  return out
}

// ---------------------------------------------------------------- 会话文件枚举

/**
 * 枚举一棵会话树下的会话文件（不跟随链接/重解析点 —— 同仓2 采集口径 /XJ）。
 * ⚠️ 认全世代（`isSessionFileName`）：归档里的旧名 `session.jsonl.zstd` 与 0.1.5 起的
 *    `session.v3.jsonl.zstd` 都收（**禁精确名比较** —— 卡「修·V3判据③」2026-09-24）。
 * @param {string} dir
 * @returns {string[]} 绝对路径
 */
export function listSessionFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let ents
    try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = path.join(cur, e.name)
      let st
      try { st = fs.lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { stack.push(p); continue }
      if (st.isFile() && isSessionFileName(e.name)) out.push(p)
    }
  }
  return out.sort()
}

/**
 * 枚举本机全部会话树（现役 + 物理归档）。归档里的图**同样会被历史回合带上**，
 * 所以对账必须两棵树一起扫（只扫 sessions 会漏一半 —— 实测 14 个受影响会话里
 * 11 个在 `_archived-sessions`）。
 * @param {string} home
 * @returns {Array<{name:string, dir:string}>}
 */
export function sessionTrees(home) {
  return ['sessions', '_archived-sessions']
    .map((name) => ({ name, dir: path.join(home, name) }))
    .filter((t) => fs.existsSync(t.dir))
}

/** 会话目录名/路径 → 归一会话 id（兼容 `session-<guid>` 与裸 `<guid>`）。 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return null
  let n = path.basename(value.trim())
  if (n.startsWith('session-')) n = n.slice('session-'.length)
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(n)
    ? n.toLowerCase()
    : null
}

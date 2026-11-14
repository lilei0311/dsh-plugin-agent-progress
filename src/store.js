// 状态存储：子代理运行记录。
//
// 设计要点：
// - **只记元数据，不记内容**：子代理的任务正文与输出可能含敏感信息（代码、密钥路径、
//   业务数据），一律不落盘。只留「谁派的、什么 provider、什么时候、什么状态、退出原因」。
// - 原子替换写：单 JSON 快照，写临时文件 → rename（同 approval-bridge / federation-hub 惯例）。
// - 失败不阻断：存储出错只记日志，绝不影响子代理本身的运行。

import fs from 'node:fs'
import path from 'node:path'

/** 状态机：running → completed | failed | cancelled | unknown */
export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'unknown'])
export const ACTIVE_STATES = new Set(['running'])

export function defaultStateFile(home) {
  return path.join(home ?? process.env.HOME ?? '.', '.dsh', 'agent-progress', 'state.json')
}

export function emptySnapshot() {
  return { version: 1, updatedAt: 0, runs: {} }
}

/** 读快照；文件不存在/损坏 → 空快照（fail-soft，不抛）。 */
export function readSnapshot(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.runs !== 'object') return emptySnapshot()
    return { version: parsed.version ?? 1, updatedAt: parsed.updatedAt ?? 0, runs: parsed.runs ?? {} }
  } catch {
    return emptySnapshot()
  }
}

/** 原子写：临时文件 → rename。目录 0700 / 文件 0600。 */
export function writeSnapshot(file, snapshot) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 1), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(dir, 0o700)
    fs.chmodSync(file, 0o600)
  } catch {
    // chmod 失败（Windows / 特殊 fs）不致命
  }
}

/**
 * 记录一次启动。
 * @param {object} snapshot 当前快照（会被原地修改）
 * @param {object} run 元数据（已由调用方脱敏）
 */
export function recordStart(snapshot, run) {
  const now = Date.now()
  snapshot.runs[run.childId] = {
    childId: run.childId,
    parentId: run.parentId ?? null,
    parentName: run.parentName ?? null,
    provider: run.provider ?? null,
    label: run.label ?? null,
    status: 'running',
    startedAt: now,
    endedAt: null,
    durationMs: null,
    outcome: null,
    reason: null,
  }
  snapshot.updatedAt = now
  return snapshot
}

/** 记录一次终态。未知 childId → 忽略（不凭空造记录）。 */
export function recordEnd(snapshot, childId, outcome, reason) {
  const run = snapshot.runs[childId]
  if (!run) return snapshot
  const now = Date.now()
  run.status = outcome && TERMINAL_STATES.has(outcome) ? outcome : 'unknown'
  run.endedAt = now
  run.durationMs = run.startedAt ? now - run.startedAt : null
  run.outcome = outcome ?? null
  // reason 只留分类标签，不留自由文本（自由文本可能含内容）
  run.reason = typeof reason === 'string' && reason !== '' ? reason.slice(0, 120) : null
  snapshot.updatedAt = now
  return snapshot
}

/**
 * 汇总视图：给「进度查询」用。
 * @param {object} snapshot
 * @param {object} opts { includeFinished, limit }
 */
export function summarize(snapshot, opts = {}) {
  const includeFinished = opts.includeFinished !== false
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 200
  const runs = Object.values(snapshot.runs ?? {})
  const filtered = includeFinished ? runs : runs.filter((r) => r.status === 'running')
  const active = filtered.filter((r) => ACTIVE_STATES.has(r.status))
  const finished = filtered.filter((r) => TERMINAL_STATES.has(r.status))
  const sorted = [...filtered].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, limit)
  const byParent = {}
  for (const r of filtered) {
    const key = r.parentName ?? r.parentId ?? 'unknown'
    byParent[key] = (byParent[key] ?? 0) + 1
  }
  return {
    total: filtered.length,
    running: active.length,
    finished: finished.length,
    byParent,
    runs: sorted,
  }
}

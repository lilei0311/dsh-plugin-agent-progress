// dsh 插件：子代理运行状态记录与查询。
//
// 目的：PM 把活派给写码 Agent（subagent）之后，**PM 自己**能回答
// 「下面派了几个、还在跑几个、跑多久了、成了没」——不必再靠人翻日志。
//
// 机制（dsh 0.2.2-rc.1 已核实）：
// - 运行时事件 `subagent/start`（发布子代理身份）与 `subagent/end`（终态）成对发出，
//   父作用域监听器可见自己的委派。
// - `ctx.subagents.startActivation()` 返回 `{ childId, messageId?, result, dispose }`。
//
// 边界：
// - **只记元数据，不记内容**：任务正文、输出、代码一律不落盘（可能含敏感信息）。
// - **只读查询接口**：外部只能 GET，不能改状态。
// - 存储失败绝不阻断子代理本身运行。

import fs from 'node:fs'
import path from 'node:path'
import {
  defaultStateFile,
  readSnapshot,
  writeSnapshot,
  recordStart,
  recordEnd,
} from './store.js'
import { createProgressServer, DEFAULT_PORT } from './server.js'

export const name = 'agent-progress'
export const inject = []

function resolveConfig(ctx, config) {
  const home = process.env.HOME ?? '.'
  const fileCfg = (() => {
    const f = config.stateFile ?? process.env.DSH_AGENT_PROGRESS_STATE_FILE
    if (typeof f === 'string' && f !== '') return { stateFile: f }
    return {}
  })()
  return {
    stateFile: fileCfg.stateFile ?? defaultStateFile(home),
    port: Number(config.port ?? process.env.DSH_AGENT_PROGRESS_PORT ?? DEFAULT_PORT),
    host: String(config.host ?? process.env.DSH_AGENT_PROGRESS_HOST ?? '127.0.0.1'),
    enabled: config.enabled !== false,
  }
}

/** 从 start/end 事件载荷里提取「安全可记」的元数据。 */
function extractRunInfo(info) {
  if (info === null || typeof info !== 'object') return {}
  const out = {}
  const pick = (obj, keys) => {
    for (const k of keys) {
      const v = obj?.[k]
      if (typeof v === 'string' && v !== '') { out[k] = v.slice(0, 200); break }
    }
  }
  pick(info, ['childId', 'child_id', 'id', 'sessionId'])
  pick(info, ['parentId', 'parent_id', 'parentSessionId'])
  pick(info, ['provider', 'providerName'])
  pick(info, ['label', 'title', 'description'])
  return out
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(ctx, config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('agent-progress: 已禁用（config.enabled=false）')
    return
  }

  let server = null

  const snapshotOf = () => readSnapshot(cfg.stateFile)
  const persist = (snapshot) => {
    try {
      writeSnapshot(cfg.stateFile, snapshot)
    } catch (err) {
      // 存储失败不影响子代理运行
      ctx.logger?.warn?.(`agent-progress: 状态写入失败（忽略）: ${err?.message ?? err}`)
    }
  }

  // —— subagent/start：子代理被接受 ——
  ctx.on('subagent/start', (info) => {
    try {
      const run = extractRunInfo(info)
      if (!run.childId) return
      const snapshot = snapshotOf()
      recordStart(snapshot, {
        childId: run.childId,
        parentId: run.parentId ?? null,
        parentName: run.parentName ?? null,
        provider: run.provider ?? null,
        label: run.label ?? null,
      })
      persist(snapshot)
    } catch (err) {
      ctx.logger?.warn?.(`agent-progress: start 处理失败（忽略）: ${err?.message ?? err}`)
    }
  })

  // —— subagent/end：终态 ——
  ctx.on('subagent/end', (info) => {
    try {
      const run = extractRunInfo(info)
      if (!run.childId) return
      const snapshot = snapshotOf()
      const outcome = info?.outcome ?? info?.status ?? info?.reason ?? null
      recordEnd(snapshot, run.childId, outcome, info?.reason ?? null)
      persist(snapshot)
    } catch (err) {
      ctx.logger?.warn?.(`agent-progress: end 处理失败（忽略）: ${err?.message ?? err}`)
    }
  })

  // —— 查询接口 ——
  const startServer = async () => {
    try {
      server = createProgressServer({
        stateFile: cfg.stateFile,
        host: cfg.host,
        port: cfg.port,
        readSnapshot,
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.port, cfg.host, resolve)
      })
      ctx.logger?.info?.(
        `agent-progress: 查询接口 http://${cfg.host}:${cfg.port}/agent-progress（状态文件 ${cfg.stateFile}）`,
      )
    } catch (err) {
      ctx.logger?.warn?.(`agent-progress: 查询接口未启动（忽略）: ${err?.message ?? err}`)
    }
  }
  startServer()

  return () => {
    try {
      server?.close()
    } catch {
      // 忽略
    }
  }
}

export { defaultStateFile, readSnapshot, writeSnapshot, recordStart, recordEnd } from './store.js'
export { createProgressServer, DEFAULT_PORT } from './server.js'

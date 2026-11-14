// 查询 HTTP 服务：给外部（本机控制台 / 脚本）读状态。
//
// 纪律（同 approval-bridge owners API）：
// - **只绑 127.0.0.1**，不对外暴露。
// - 只读，不接受任何写操作（状态由插件内部写）。
// - 端口默认 47830；与现有端口（47822 联邦 / 47824 审批桥 / 47826 名单 / 47950 Hub）都不同。

import http from 'node:http'
import { summarize } from './store.js'

export const DEFAULT_PORT = 47830

export function createProgressServer({
  stateFile,
  host = '127.0.0.1',
  port = DEFAULT_PORT,
  readSnapshot,
}) {
  return http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      res.writeHead(code, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(payload),
      })
      res.end(payload)
    }
    if (req.method !== 'GET') {
      send(405, { error: 'method_not_allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/agent-progress' || url.pathname === '/agent-progress/') {
      const snapshot = readSnapshot(stateFile)
      const includeFinished = url.searchParams.get('includeFinished') !== '0'
      const limit = Number(url.searchParams.get('limit') ?? '200')
      send(200, { ...summarize(snapshot, { includeFinished, limit }), stateFile })
      return
    }
    if (url.pathname === '/health') {
      send(200, { ok: true })
      return
    }
    send(404, { error: 'not_found' })
  })
}

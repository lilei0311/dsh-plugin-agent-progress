import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  emptySnapshot,
  readSnapshot,
  writeSnapshot,
  recordStart,
  recordEnd,
  summarize,
  TERMINAL_STATES,
} from '../src/store.js'
import { createProgressServer } from '../src/server.js'

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-progress-'))
  return path.join(dir, 'state.json')
}

test('空快照结构正确', () => {
  const s = emptySnapshot()
  assert.equal(s.version, 1)
  assert.deepEqual(s.runs, {})
})

test('读：文件不存在 → 空快照（不抛）', () => {
  const s = readSnapshot(path.join(os.tmpdir(), 'nope-' + Date.now(), 'x.json'))
  assert.deepEqual(s.runs, {})
})

test('读：文件损坏 → 空快照（fail-soft）', () => {
  const f = tmpFile()
  fs.writeFileSync(f, '{ broken json')
  const s = readSnapshot(f)
  assert.deepEqual(s.runs, {})
})

test('写：原子替换 + 权限 0600/0700', () => {
  const f = tmpFile()
  const s = emptySnapshot()
  recordStart(s, { childId: 'c1', provider: 'claude-code', label: '写码' })
  writeSnapshot(f, s)
  assert.ok(fs.existsSync(f))
  assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700)
  // 没有残留 tmp 文件
  const leftovers = fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('start → running；end → 终态 + 时长', () => {
  const s = emptySnapshot()
  recordStart(s, { childId: 'c1', provider: 'claude-code' })
  assert.equal(s.runs.c1.status, 'running')
  assert.equal(s.runs.c1.endedAt, null)

  recordEnd(s, 'c1', 'completed', 'ok')
  assert.equal(s.runs.c1.status, 'completed')
  assert.ok(s.runs.c1.endedAt >= s.runs.c1.startedAt)
  assert.ok(s.runs.c1.durationMs >= 0)
})

test('end：未知 childId → 忽略（不凭空造记录）', () => {
  const s = emptySnapshot()
  recordEnd(s, 'ghost', 'completed')
  assert.deepEqual(s.runs, {})
})

test('end：非法 outcome → unknown（不崩）', () => {
  const s = emptySnapshot()
  recordStart(s, { childId: 'c1' })
  recordEnd(s, 'c1', 'weird-status')
  assert.equal(s.runs.c1.status, 'unknown')
})

test('reason 只留截断标签，不留长文本', () => {
  const s = emptySnapshot()
  recordStart(s, { childId: 'c1' })
  recordEnd(s, 'c1', 'failed', 'x'.repeat(500))
  assert.ok(s.runs.c1.reason.length <= 120)
})

test('summarize：统计 running/finished 与按父分组', () => {
  const s = emptySnapshot()
  recordStart(s, { childId: 'a', parentName: 'PM-联邦' })
  recordStart(s, { childId: 'b', parentName: 'PM-联邦' })
  recordStart(s, { childId: 'c', parentName: 'PM-官翻' })
  recordEnd(s, 'b', 'completed')

  const sum = summarize(s)
  assert.equal(sum.total, 3)
  assert.equal(sum.running, 2)
  assert.equal(sum.finished, 1)
  assert.equal(sum.byParent['PM-联邦'], 2)
  assert.equal(sum.byParent['PM-官翻'], 1)
})

test('summarize：includeFinished=false 只留运行中', () => {
  const s = emptySnapshot()
  recordStart(s, { childId: 'a' })
  recordEnd(s, 'a', 'completed')
  const sum = summarize(s, { includeFinished: false })
  assert.equal(sum.total, 0)
})

test('summarize：按 startedAt 倒序 + limit', () => {
  const s = emptySnapshot()
  recordStart(s, { childId: 'old' })
  s.runs.old.startedAt = 1000
  recordStart(s, { childId: 'new' })
  s.runs.new.startedAt = 2000
  const sum = summarize(s, { limit: 1 })
  assert.equal(sum.runs.length, 1)
  assert.equal(sum.runs[0].childId, 'new')
})

test('HTTP：GET /agent-progress 返回汇总；GET /health 200；POST 405；未知路径 404', async () => {
  const f = tmpFile()
  const s = emptySnapshot()
  recordStart(s, { childId: 'c1', parentName: 'PM-联邦', provider: 'claude-code' })
  writeSnapshot(f, s)

  const server = createProgressServer({ stateFile: f, port: 0, readSnapshot })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const p = await fetch(`${base}/agent-progress`)
    assert.equal(p.status, 200)
    const body = await p.json()
    assert.equal(body.total, 1)
    assert.equal(body.running, 1)
    assert.equal(body.runs[0].childId, 'c1')

    const h = await fetch(`${base}/health`)
    assert.equal(h.status, 200)

    const bad = await fetch(`${base}/agent-progress`, { method: 'POST' })
    assert.equal(bad.status, 405)

    const nf = await fetch(`${base}/nope`)
    assert.equal(nf.status, 404)
  } finally {
    server.close()
  }
})

test('HTTP：includeFinished=0 只返回运行中', async () => {
  const f = tmpFile()
  const s = emptySnapshot()
  recordStart(s, { childId: 'a' })
  recordEnd(s, 'a', 'completed')
  writeSnapshot(f, s)

  const server = createProgressServer({ stateFile: f, port: 0, readSnapshot })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/agent-progress?includeFinished=0`)).json()
    assert.equal(body.total, 0)
  } finally {
    server.close()
  }
})

test('落盘内容不含任务正文字段（只存元数据）', () => {
  const s = emptySnapshot()
  recordStart(s, { childId: 'c1', label: '改 README', provider: 'claude-code' })
  const blob = JSON.stringify(s)
  for (const forbidden of ['prompt', 'body', 'output', 'content', 'stdout']) {
    assert.ok(!blob.includes(`"${forbidden}"`), `不应包含 ${forbidden}`)
  }
})

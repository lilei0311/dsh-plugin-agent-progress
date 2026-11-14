# dsh-plugin-agent-progress

**让 PM 能回答「我派出去的 Agent 进度到哪了」。**

dsh 插件：记录子代理（subagent / 写码 Agent）的运行状态，并提供只读查询接口。

## 为什么需要它

PM 把活派给写码 Agent（`subagent_claude_code` / `subagent_codex`）之后：
- 子代理是**独立管理的**，有 id、有完成通知
- 但运行状态**没有任何查询入口**——PM 自己只能凭记忆答
- 于是「下面写到哪了」变成黑盒，只能等它回来

本插件把运行时已经知道的生命周期（`subagent/start` / `subagent/end`）落成可查的表。

## 装

```sh
dsh plugin --profile web add dsh-plugin-agent-progress
```

或从源码目录：

```sh
dsh plugin --profile web add file:/Users/usali/projects/dsh-plugin-agent-progress
```

重启 dsh 服务后生效。

## 用

```sh
# 汇总（含已结束）
curl -s http://127.0.0.1:47830/agent-progress

# 只看还在跑的
curl -s 'http://127.0.0.1:47830/agent-progress?includeFinished=0'
```

返回：

```json
{
  "total": 5, "running": 2, "finished": 3,
  "byParent": { "PM-联邦": 4, "PM-官翻": 1 },
  "runs": [
    { "childId": "…", "parentName": "PM-联邦", "provider": "claude-code",
      "label": "改 README", "status": "running",
      "startedAt": 1794600000000, "endedAt": null, "durationMs": null }
  ]
}
```

## 边界（重要）

- **只记元数据，不记内容**：任务正文、输出、代码**一律不落盘**——那些可能含密钥路径、
  业务数据。只留「谁派的、什么 provider、什么时候、什么状态、退出原因」。
- **只读**：外部接口只接受 GET，状态只能由插件内部写。
- **只绑 127.0.0.1**：不对外暴露。
- **存储失败不阻断**：写状态出错只记日志，不影响子代理本身运行。

## 状态文件

`~/.dsh/agent-progress/state.json`（目录 0700 / 文件 0600，原子替换写）

可用 `DSH_AGENT_PROGRESS_STATE_FILE` 覆盖。

## 配置

```jsonc
{
  "enabled": true,       // false = 完全不启用
  "stateFile": "…",      // 状态文件路径
  "host": "127.0.0.1",   // 查询接口绑定地址
  "port": 47830          // 查询接口端口
}
```

环境变量：`DSH_AGENT_PROGRESS_STATE_FILE`、`DSH_AGENT_PROGRESS_HOST`、`DSH_AGENT_PROGRESS_PORT`。

## 端口

47830。与现有端口不冲突：47822 联邦插件 / 47824 审批桥 / 47826 名单 API / 47950 Hub。

## 测试

```sh
npm test
```

## 参与改进

这是**公共组件**，欢迎提意见和参与贡献 —— 仓库开着 Issues 和 Discussions。

挑模板提就行：

| 模板 | 什么时候用 |
|---|---|
| **使用建议** | 字段名看不懂、缺参数、返回形状不合手、JSON 难读 |
| **隐私边界** | 对「只记元数据不记内容」这条边界有不同意见——**这类讨论最欢迎**，它决定了这个插件敢不敢被更多人用 |
| **新需求** | 想让它能做的事：进程流、当前在做什么、告警、导出报表… |

也可以直接开 Discussion 聊用法、集成方式，或者直接提 PR。

**已知边界（诚实说明）**
- 只有**状态**，没有**过程**——子代理跑到哪一步、卡在哪里看不到。那需要接子代理的流式输出，侵入面大得多，是下一步的方向。
- 记录**跨重启保留**（状态文件落盘），但 DSH 换 profile 会丢（状态目录跟着 profile 走）。
- `label` 取自运行时事件里的任务标题，**不含任务正文**——正文一律不落盘。

## 路线图（欢迎认领）

- [ ] 过程流：子代理工具调用时间线
- [ ] 「当前在做什么」：子代理主动上报阶段
- [ ] 告警：子代理卡住 / 失败时推送（iMessage / 邮件）
- [ ] 导出：按 PM 汇总成日报

## License

MIT

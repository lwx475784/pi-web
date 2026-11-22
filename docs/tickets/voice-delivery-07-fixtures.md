<!-- status: done with 01–06: 58 new tests; the fake world now returns `state`, so the idle gate is finally exercised; `ANSWER_WAIT_MS` pinned -->
# 07 · 夹具测试 + 补假世界缺 `state`

**问题**：现有 62 条测试从没执行过真正的 idle 门控 —— `lib/voice/pi-bridge.test.mjs` 的
`fakeWorld` 状态 GET 只返回 `{running}`，没有 `state.isStreaming/isPromptRunning`，
于是"忙"这条路永远判否。本次线上两个 bug（超时弃单、撞车被拒）测试一个都没抓到。

**做法**：给假世界补 `state` 形状；按事件流真实形状造序列夹具：慢任务、两条撞车、
queued 排队、断线重连、旧音频迟到、权限拒绝。每条 ticket 的验收各对应至少一条测试。
**关键**：01/03 的回归夹具必须在旧代码上失败（否则证明不了修的是同一个洞）。

**落点**：`lib/voice/pi-bridge.test.mjs`、`lib/voice/realtime-client.test.mjs`、
新增事件序列夹具

**验收**：`npm test` 全绿；对 revert 掉的旧实现，慢任务/撞车两条测试红。

**估时**：1 人日 · **依赖**：01–06

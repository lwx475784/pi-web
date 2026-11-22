# 01 · requestId 归因 + SSE 事件驱动（门槛组地基）

**问题**：播报靠"leafId 变了 + 有非空 assistant 文本"猜答案归属，认不出就把别人的答案当成本题念出来。
实测第一次语音任务跑 218.7 s，旧实现 180 s 放弃，答案 43 s 后落地时无人认领。

**证据**：`lib/voice/pi-bridge.ts` 的 wait 循环；SDK `prompt(): Promise<void>`，只有
`preflightResult("started"|"queued"|"handled")` 给身份，`queued` 无法归属；
`POST /api/agent/[id]` 只回 `{success,data}`（`app/api/agent/[id]/route.ts`、`lib/rpc-manager.ts:1583`）；
SSE 已透传 `agent_start/agent_end/agent_settled/prompt_done/user_message_entry/queue_update`。
⇒ 身份是 pi-web 侧改造，不需要上游 SDK 动。

**做法**：语音客户端每次 ask 生成 `requestId` 随 prompt 提交 → wrapper 用 closure 在
`user_message_entry` / `prompt_done` / `prompt_error` 上回显，并把该 run 的答案 entryId 一起给出；
桥改为订阅 SSE 事件拿终态，现存的轮询保留成退路开关（`PI_VOICE_POLL_FALLBACK=1` 或设置项）。

**落点**：`lib/rpc-manager.ts`、`app/api/agent/[id]/route.ts`、`lib/agent-event-wire.ts`、
`lib/agent-event-stream.ts`、`lib/voice/pi-bridge.ts`、`components/VoiceConversationPanel.tsx`

**验收**：慢任务答对且不等整个 run settle；两条撞车不串答；断线重连能补投结果；
关掉 SSE（开退路）仍答对，只是延迟变差。

**估时**：1–2 人日 · **依赖**：无

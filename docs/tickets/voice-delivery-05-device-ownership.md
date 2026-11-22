# 05 · 设备接管提示 + onclose 可见 + watchdog

**问题**：s2s 只有 1 条 pipeline（实测 `GET /v1/pool` = `{"size":1,"in_use":0}`），第二路直接
`session_limit_reached` + close 1008，不排队；而 `lib/voice/realtime-client.ts` 运行期 `onclose`
只把 ws 置 null，界面仍显示在通话中（假在线），麦克风也继续被占。

**做法**：后来者顶掉前者 —— 被踢方明确显示「语音已由 `<设备>` 接管」并释放麦克风；
第一路连接失败时提示"语音被占用"而不是笼统 error；加按状态的 watchdog（N 秒无事件 → 明确失败
+ 释放麦 + 重连不重投 prompt）。

**落点**：`lib/voice/realtime-client.ts`（`onclose`/错误码/退避）、
`components/VoiceConversationPanel.tsx`、`lib/i18n/messages/*`

**验收**：两个浏览器抢一路 → 后开的能用，先开的看到原因；拔网线 5 s 内提示并释放麦；
重连不重复投问题。

**估时**：0.5–1 人日 · **依赖**：无

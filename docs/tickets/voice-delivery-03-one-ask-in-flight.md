# 03 · 串行撞车判定与话术

**问题**：允许多条同时在飞时，排进队列的那些（`queued`）天生没有身份，只能降级成"待读不播报"。

**做法**：`ask_pi` 进来先查语音侧在飞 job；已有则返回 `{state:"conflict", running, unread}`，
由语音层问一句「前面还有 1 条在跑，排队还是停掉它？」——排队仍走 `followUp`，但其结果按 ADR
第 4 条只进待读账本，不播报；停掉它走 04 的作用域取消。

**落点**：`components/VoiceConversationPanel.tsx`、`lib/voice/pi-bridge.ts`、语音层
`ask_pi` 工具描述与 instructions

**验收**：连问两条时第二问听到选择而非静默排队；选排队 → 不串答且结果进待读；
选停 → 只停语音那条；同一时刻至多一条待认领。

**估时**：0.5 人日 · **依赖**：01、04

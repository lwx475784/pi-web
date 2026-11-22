# 04 · stop_pi 只停语音那条

**问题**：语音说"算了"今天会 abort 整个 run 并 `clearQueue()` 清空**全部** steer/followUp 队列
（`lib/rpc-manager.ts:1606`）。页面 Stop 会把取回的文字放回输入框，语音侧 `stopPiRun`
（`lib/voice/pi-bridge.ts`）把返回值直接丢了 —— 等于**悄悄丢掉**你敲进去排队的活儿。

**做法**：三级取消 ——
「算了」= 只取消语音自己派出的那条 job（播报 + 该 job 若独占 run 则 abort run）；
「别念了」= 只停公告，任务继续；
「全部停止」= 语音先回读「要停掉 N 个任务，确认？」，确认后才 session abort。
作用域信息来自 01 的 requestId（认不出归属就不许 abort 别人的 run）。

**落点**：`components/VoiceConversationPanel.tsx`、`lib/voice/pi-bridge.ts`、`lib/rpc-manager.ts`

**验收**：键入排队 B + 语音跑 A → 说"算了"只停 A，B 仍在队列里且被明确告知；
"全部停止"未确认时不产生副作用；取消项计入待读（不静默）。

**估时**：0.5 人日 · **依赖**：01（可先做止血版：不丢返回值）

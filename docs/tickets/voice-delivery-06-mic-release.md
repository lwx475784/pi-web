# 06 · 停麦前补静音收尾

**问题**：服务端 turn 收尾只看**音频时钟**（`VADIterator` 按样本数判 300 ms 静音，
无"多久没音频就结束"的定时器）。所以收起时 `mic.stop()` 会让说到一半的那句**永不 commit**，
客户端 `speaking` 标志也可能一直挡住公告。

**做法**：释放麦克风前主动 `sendSilenceChunks()` 触发 `input_audio_buffer.committed`；
等 ≤300 ms，没等到就丢弃当轮并清 `speaking` 标志。收起与挂断两条路径共用这段收尾。

**落点**：`components/VoiceConversationPanel.tsx`（collapse/hangup 路径）、
`lib/voice/realtime-client.ts`（收尾与丢弃的原子动作）

**验收**：说到一半收起 → 那半句要么被识别生效、要么明确作废（不可悬空）；
公告不被 `speaking` 卡住；展开后能重新拿到麦克风且指示灯状态正确。

**估时**：0.5 人日 · **依赖**：无

# 02 · 服务端待读账本 + 药丸计数

**问题**：漏播现在是静默的 —— 答案落在页面，语音侧一句不说；且逐字记录只活在浏览器
localStorage，换设备/清缓存就没有账（`lib/voice/call-history.ts`）。

**做法**：per-session 的服务端账本，记「未播的成功答案」与「未播的失败/超时」；
播报成功才标已读；有界条数 + 24 h 过期 + 显式"清除本通话记录"连带清理。
收起状态下药丸显示"N 条待读"，下次开麦**补播最近一条**，其余只报数量。
旧 localStorage 记录不迁移，按新策略过期。

**落点**：新增 `lib/voice/announce-ledger.ts` + 一个读写 route（挂在 `/api/sessions/[id]/…`），
`components/VoiceConversationPanel.tsx`、`lib/i18n/messages/*`

**验收**：挂断后重开 → 听到一条补播 + "还有 N 条"；换浏览器仍可见；24 h 后自动消失；
清除按钮连带清账本；漏播永不再静默。

**估时**：0.5–1 人日 · **依赖**：01

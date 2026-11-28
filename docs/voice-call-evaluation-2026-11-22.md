# Pi Web 语音通话评估 · 2026-11-22

## 1. 执行摘要

**5.1/10：双层设计值得保留，现版适合单人试用，不宜承诺多端可靠交付。** 三大风险：答错任务比晚答更严重；一句「算了」可能停止别的工作；连接或轮次失步后界面仍像在通话。三大机会：按任务推送结果、用真实排队状态替代重复口头确认、先降 TTS 的固定延迟和 LLM 的长尾，不急着换传输。最反直觉：**把等待延长到 20 分钟救回了慢任务，却也延长了把别人的答案当成本题答案的窗口。**（`lib/voice/pi-bridge.ts:75–149`；`lib/voice/realtime-client.ts:160–181,254–273,371–392`；`/tmp/s2s-sample.log:1–1501`）

## 2. 评分卡

严重度指未处理的风险；等权计分。引用为直接代码证据，影响与分数为评审判断。

| 维度 | 分数 | 依据 / 扣分 | 严重度 |
|---|---:|---|---|
| 功能完整性与正确性 | 7 | 寒暄、委派、字幕、结果回送齐备；接受前报 `started`，取消不按任务（`components/VoiceConversationPanel.tsx:140–221,308–320`） | 高 |
| 延迟与打断 | 4 | 本地能清播放器，但旧音频可在 `done` 前重新排入；服务端样本中位 2.82s（`lib/voice/realtime-client.ts:328–371`；日志见 §3） | 高 |
| 状态机健壮性 | 4 | 启动有 URL fallback，运行期 `onclose` 静默，无 watchdog（`lib/voice/realtime-client.ts:130–188,254–273,371–392`） | 高 |
| 错误与可观测性 | 4 | 有警告/工作提示，收起只剩标题和色点；无端到端关联，轮询吞错（`components/VoiceConversationPanel.tsx:322–333,396–447`；`lib/voice/pi-bridge.ts:119–150`） | 高 |
| 轮询桥 | 4 | 不另开 SSE，但叶变化不是请求身份（`lib/voice/pi-bridge.ts:86–150`） | 高 |
| 隐私与安全 | 5 | TLS 优先但默认有明文候选；逐字历史会重放（`lib/voice/settings.ts:22–60`；`lib/voice/call-history.ts:11–87`） | 高 |
| 移动端/iOS | 5 | 有 safe area、设备释放；手势与启动跨异步，播音恢复失败被静默（`components/VoiceConversationPanel.tsx:334–387,419–463`；`lib/voice/audio-out.ts:23–46`；[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)） | 中 |
| 可测试性与维护性 | 7 | FakeWS、注入 fetch、纯函数易测；缺真浏览器、并发与失联验证（`lib/voice/realtime-client.test.mjs:6–38,236–275`；`lib/voice/pi-bridge.test.mjs:26–89`） | 中 |
| i18n/文案 | 6 | 中英文按钮可辨，语音硬编码中文符合家庭用途；「没回应」和「直接说话」不说明麦克风或任务真状态（`lib/i18n/messages/zh-CN.ts:831–850`、`lib/i18n/messages/en.ts:831–850`；`components/VoiceConversationPanel.tsx:53–65,402–447`） | 中 |

## 3. 架构与实测

**路径（部署版本/拓扑来自任务背景）**：Mac mini 浏览器 → Win s2s 1.1.0（Qwen3-ASR、LiteLLM Chat Completions、OmniVoice）→ `ask_pi` 先回 tool output、再走同源 REST → pi run → `[background event, not said by the user]` → 语音重述。s2s 普通响应会因工具未回而拒绝；不能靠它代为执行 `ask_pi`，但上游能在收到 output 后预生成跟进，不能笼统说完全无服务端跟进（`components/VoiceConversationPanel.tsx:181–221`；`lib/voice/realtime-client.ts:166–181,194–273`；[s2s v1.1.0](https://raw.githubusercontent.com/huggingface/speech-to-speech/v1.1.0/src/speech_to_speech/api/openai_realtime/handlers/response.py)）。

**文字时序，15:14 `turn_2 rev=1`**：用户说完（服务端 soft-end 34.215）→ ASR final（35.244，差 **1.029s**，非纯 STT）→ `ask_pi`（37.113，差 **1.869s**）→ 即时回执发送和 pi 入队（浏览器未打点）；首个语音回合日志 E2E **4.29s**，随后 tool 跟进 LLM/TTS **10.77/1.16s**。→ pi run **218.7s**（父会话核实，非本 s2s 日志可算）→ 旧版注入的是超时，失败播报 LLM/TTS **2.57/1.35s**；成功注入与设备出声未核实（`/tmp/s2s-sample.log:1299–1360`）。

**样本直接证据**（`/tmp/s2s-sample.log:1–1501`）：手工筛 `source=speech`、`completed`、数值 E2E，共 **31** 条；中位/P90（最近秩）**2.82/5.37s**，范围 **2.36–11.81s**；同组 LLM 中位 **0.76s**、TTS TTFA 中位 **1.07s**；输入 **897–2115**、输出 **2–138** tokens，不是账单。多条 STT 为 `n/a`；例如首次工具轮以时间差补读，不能外推。Smart Turn 有 **800ms** reopen grace，判不完整有 **2000ms** 窗口、另报延迟处理 **600ms**，不可把窗口全当串行成本。插话例 11:53:27.280→27.292 为 VAD 确认到取消记录 **12ms**，不是开口到扬声器静音；其余取消、缺测、网关超时另报，不计成功分位。样本混合不同会话，非修复后的验收。

**归因（静态推断）**：idle 降低把过程旁白当答案的概率，却不保证最终文本：无最终正文时仍向前取带工具的助手文本；状态与 context 两次 GET 也非原子。A/B 排队会同等整个 run settle，可能都取 B、取旧答或因 `tail=8` 被挤掉；同 session 两页若都可接通，写同一 wrapper 并各自猜答案；若 s2s 槽已满，第二路先被拒。1.2s/次近 20 分钟约 **1000 次状态 GET/任务**（忽略 RTT），idle 未命中再查 context；`systemPrompt=0` 只瘦响应，仍算活动时长。`get_state` 不续命，20 分钟也不硬性中断卡住的 fetch（`lib/voice/pi-bridge.ts:41–58,86–150`；`lib/rpc-manager.ts:1375–1408,1430–1585,1618–1650`；`app/api/sessions/[id]/context/route.ts:13–47`；[s2s router](https://raw.githubusercontent.com/huggingface/speech-to-speech/v1.1.0/src/speech_to_speech/api/openai_realtime/websocket_router.py)）。

**门控（静态推断）**：两错误码符合 s2s 常见拒绝，绝非完整恢复策略：白名单只重置 `createOpen`、置 `owed`，不安排下一次尝试；非白名单或无 `created/done` 可锁死。`openCalls` 在发送前删、无 output ACK，本地空不等于服务端空；`speaking` 漏 terminal 会一直挡公告，但不挡所有普通回复。公告在 `create` 前出队，失败或被打断不保证再播；`failed/incomplete` 可留下旧字幕，布尔量也不能过滤跨 response 的迟到音频。静默断开可能仍占麦，发音频成空操作（`lib/voice/realtime-client.ts:75–82,162–210,222–284,311–392`；`components/VoiceConversationPanel.tsx:286–305,322–353,377–388`）。

## 4. 与业界对照

下表链接为一手证据；「对本项目」是解读。

| 对象 | 一手证据 | 对本项目 |
|---|---|---|
| OpenAI Realtime | [会话](https://developers.openai.com/api/docs/guides/realtime-conversations)：WS 传 PCM delta，WebRTC/SIP 走媒体；客户端交 function output。 [VAD](https://platform.openai.com/docs/guides/realtime-vad)：`server_vad` 可调 threshold/prefix/silence，`semantic_vad` 可调 eagerness，另有 `create_response` / `interrupt_response`。 [事件](https://developers.openai.com/api/reference/resources/realtime/client-events)：默认会话不能同时有两个写入 response，`conversation:none` 可带外；[官方说明](https://developers.openai.com/blog/realtime-api#asynchronous-function-calling) 允许 pending tool 期间继续交谈。 | 不把 s2s pending 拒绝推广成 OpenAI 语义。保留解耦，而非先迁移。 |
| Gemini Live | [双向 WS / interim 转写](https://ai.google.dev/api/live)、[proactivity](https://ai.google.dev/gemini-api/docs/live-guide) 可忽略无关语音；[工具](https://ai.google.dev/gemini-api/docs/live-tools) 按型号支持 `NON_BLOCKING` 和 `WHEN_IDLE`。 | 后台完成择机播报不是独创；我们独到的是复用同一个编码会话。 |
| Claude 语音模式 | [产品文档](https://support.claude.com/en/articles/11101966-using-voice-mode)：同一聊天切语音/文字，免提可插话，吵时可按住说；默认留文字不留音频。 | 给共享房间一个确定性入口；未核实可比 API/延迟。 |
| Deepgram Voice Agent / Aura | [Voice Agent](https://deepgram.com/product/voice-agents) 用 Flux 做轮次/插话；[特定 VPC/Bedrock](https://deepgram.com/blog/voice-agents-deepgram-nvidia-nemotron) E2E **660/979ms P50/P90**；[Aura-2](https://developers.deepgram.com/changelog/2025/5/14) **<200ms TTFB**，非全链路。 | 先 A/B 中文 TTS 的首音、名称/数字发音；不直接换供应商。 |
| LiveKit / Pipecat | [LiveKit turns](https://docs.livekit.io/agents/logic/turns/) 区分 backchannel，截断未听内容；[异步工具](https://docs.livekit.io/agents/logic/tools/async/) 有进度与静默期 filler。Pipecat 有 [Smart Turn](https://docs.pipecat.ai/pipecat/learn/speech-input)、[按调用取消及延期结果](https://docs.pipecat.ai/pipecat/learn/function-calling)。 | 补齐真状态、打断与恢复；不必靠 LLM 再说一遍「已经问了」。 |
| Vapi / Moshi | [Vapi](https://docs.vapi.ai/assistants/model-intelligence/understanding-latency) 记逐轮 `turnLatency`，区分组件与 transport；[轮次配置](https://docs.vapi.ai/customization/speech-configuration) 分 endpointing / backchannel。 [Kyutai Moshi](https://github.com/kyutai-labs/moshi) 全双工，理论 **160ms**、L4 实测低至 **200ms**，非带工具通话。 | 先对齐测量口径，不拿模型速度与浏览器体验直接排名。 |

**基准与取舍**：以「用户实际说完→设备首个可听语音」作主指标；另记 TTFDA（本报告操作定义：说完→首个解码且非静音的帧，尚未出声）、TTFB、TTS TTFA、pi 接收/完成→播报；不把 TTFDA 当通用缩写（[Pipecat 指标](https://docs.pipecat.ai/pipecat/fundamentals/metrics)、[Coval TTFA](https://benchmarks.coval.ai/benchmarks/time-to-first-audio)）。「~500ms 好、~800ms 及格、>1s 有迟滞风险」是**团队目标解读**，非标准：参照 [Stivers 人类对话平均值](https://pmc.ncbi.nlm.nih.gov/articles/PMC2705608/)、上述 Deepgram 分位和 [LiveKit 的低于一秒建议](https://docs.livekit.io/agents/models/pipelines/)。OpenAI 公布 [GPT‑4o 最低 232ms、平均 320ms](https://openai.com/index/hello-gpt-4o/)，不是 Realtime API SLA；[GPT‑Realtime‑2](https://developers.openai.com/api/docs/models/gpt-realtime-2) 音频输入/输出 **$32/$64 每百万 tokens**（缓存输入 **$0.40**），不适用本地日志计费。

近场 floor/peak、预卷与静音填充值得保留为可选配置；再按单字、时长、每轮唤醒词硬过滤，可能错过轻声「停」或让旁人念到名字即触发。VAD 先打断、转写后拒绝，反而会把「没回应」变成「打断了，但没恢复」。滑杆 0 也不是旁路；说话人识别并非上述产品的普遍前提。当前只能证明不主动回复，不能证明被拒音频没上传或未进服务端上下文（`lib/voice/turn-gate.ts:53–95,147–179`；`lib/voice/mic.ts:62–100`；`lib/voice/realtime-client.ts:311–340`；[LiveKit turns](https://docs.livekit.io/agents/logic/turns/)）。

## 5. 改进意见

| 优先级 / 问题 | 做法 → 落点 | 粗估与验收 |
|---|---|---|
| **P0 答案串单** | POST 分配幂等 `jobId`；在实际入队/起跑关联 user entry，终态带 answer entry；复用现有 SSE 并提供按 ID 补读。不能确定归因就不播。→ `app/api/agent/[id]/route.ts`、`lib/rpc-manager.ts`、`lib/voice/pi-bridge.ts` | 4–7 人日（先核实 SDK 关联点）；A/B、并发键入、分支切换及断线重放零串答，A 不等 B。 |
| **P0 错停别人的工作** | `stop_pi` 先只取消对应播报；不支持单项撤队就明说。仅给显式确认的「停止本会话全部任务」使用 session abort。→ `components/VoiceConversationPanel.tsx`、`lib/voice/pi-bridge.ts` | 0.5–1 人日；语音取消 A 不停止键入 B、不清队列、不谎报已停。 |
| **P0 假在线与卡死** | 连接世代、事件 ID/ACK、按状态 watchdog、有界退避；公告等终态再结算，失联时释放麦，重连不重投 prompt。→ `lib/voice/realtime-client.ts`、`components/VoiceConversationPanel.tsx` | 2–4 人日；丢 `created/done/committed`、拒绝、断网均恢复或明确失败，麦克风停止。 |
| **P0（共享前）误唤醒与外传** | TLS 默认且拒绝带凭据 URL；认证短期凭据/受控端点；副作用动作走文字确认，敏感结果默认只在原会话可见。→ `lib/voice/settings.ts`、`components/VoiceConversationPanel.tsx`、agent admission | 2–4 人日；共享场景广播/旁人音频不能直接触发变更；跨设备不得自动播敏感结果。 |
| P1 慢首音与假进度 | 按 turn/response/job 记录各阶段（不记正文），已受理才显示/短音确认；A/B 流式 TTS 与快模型，状态查询不另起 pi 任务。→ `lib/voice/audio-out.ts`、`lib/voice/pi-bridge.ts`、s2s 配置 | 2–4 人日；同中文集分层报告成功/取消/无声、P50/P90，先证明相对基线改善且不升误触发。 |
| P1 麦克风、Esc、误插话 | 开始/展开点击内解锁；收起主动结束或丢弃当轮，串行设备交接；Esc 限焦点且尊重 IME/defaultPrevented；提供按住说、短 backchannel 不永久停播。→ `components/VoiceConversationPanel.tsx`、`lib/voice/mic.ts`、`lib/voice/turn-gate.ts` | 2–4 人日；iOS 16.2/当前 Safari 验证收展、锁屏、听写交替；Esc 只执行本控件动作。 |
| P1 历史与长答 | 可关/可清历史、限字限时，区分已生成/已播；Markdown 表只播结论和入口，详情留原会话。→ `lib/voice/call-history.ts`、`components/VoiceConversationPanel.tsx`、i18n | 1–2 人日；长表不整段出站，清除后重连无旧 digest，收起明确「麦克风已关，仅播报」。 |
| P2 回归覆盖 | 加假钟、跨标签、浏览器音频及真实 WS 录制事件夹具。→ `lib/voice/*.test.mjs` | 1–2 人日；覆盖慢任务、双任务、重复工具事件、旧音频及权限拒绝。 |

## 6. 两项修复复评

- **`3e91e6a`：止血有效，未根治。** 经核实的 218.7s 刚好解释旧上限失败；20 分钟适合作界面提醒期限，超时应提示「停止等待播报，任务可能仍在运行」，仍可查询终态。`prompt_rejected/accepted:false` 也覆盖 404、目录、预检等，不等于忙；压缩能返回 parked `{queued:true}`，普通 followUp 的 acceptance 也不等于完成。优先服务端原子决定开始/排队和返回 disposition，不盲重发。两条新测试覆盖重投形态与多轮轮询，400 次 × 1ms 并未跨旧默认期限，fake busy 也未提供 `state`（`app/api/agent/[id]/route.ts:39–73`；`lib/rpc-manager.ts:1430–1585,1618–1636`；`lib/voice/pi-bridge.test.mjs:26–83`）。事件改造宜在 wrapper/SDK 回调识别具体请求终态，再经现有 SSE 送达；只监听 `agent_end` 或换成扩展主动推送，仍不能替代身份和补读（`app/api/agent/[id]/events/route.ts:9–42`）。
- **`737f03e`：解决遮挡和设备占用；不等于挂断。** 只停 track/采集 context；上游 WS 读超时继续等，正常不释放 pipeline，代理空闲策略未核实。折叠在半句话可能没有 trailing silence，公告仍被 `speaking` 挡；保留槽也可能让用同一 s2s 的站内听写连不上（与系统输入法不同）。连接先断后收起又会被 `connected` 守卫跳过；全局 Escape 不看输入框已消费的事件，可能关菜单且收窗，或与停止 pi 同时触发（`components/VoiceConversationPanel.tsx:161–184,350–393,419–463`；`lib/voice/mic.ts:101–113`；`hooks/useVoiceInput.ts:124–162`；`components/ChatInput.tsx:1589–1696`；`hooks/useKeyboardShortcuts.ts:17–35`；[s2s router](https://raw.githubusercontent.com/huggingface/speech-to-speech/v1.1.0/src/speech_to_speech/api/openai_realtime/websocket_router.py)）。

## 7. 风险与伦理

麦克风工作、WS 在线、pi 正工作是三件事；当前「正在聆听」只在空字幕时出现。浏览器代码未见原音落盘，但音频出站，采样日志含转写；Win/LiteLLM/上游留存、ACL 与凭据配置未核实。`localStorage` 存每会话近 40 条，重开取 12 条原文拼接，并非会话恢复：跨设备不一致，同浏览器多页写入可能覆盖，取消回复也可能记入未听文本。整张 Markdown 表也会以 `role:user` 背景消息发给模型；「最多两句」只限生成意图，不限输入大小、不隔离指令。建议明确告知旁人、默认限留存、敏感播报选择加入，不以唤醒词作为授权。（`components/VoiceConversationPanel.tsx:55–65,204–221,286–305,334–346,490–506`；`lib/voice/call-history.ts:11–87`；`lib/voice/realtime-client.ts:243–252,275–277`；`/tmp/s2s-sample.log:1299–1360`）

## 8. 附录：审阅索引与证据边界

- 入口：`components/ChatWindow.tsx:262–268,328–340,929–976`；`components/VoiceCallButton.tsx:11–33`；`components/VoiceInputButton.tsx:21–48`；`components/VoiceInputSettings.tsx:32–115`。媒体与文字：`lib/voice/mic.ts:53–113`、`audio-out.ts:23–66`、`turn-gate.ts:53–95,147–179`、`text.ts:13–24`（听写拼接，非播报清洗）；桥接、历史、设置、API 与词条见正文。62 条为任务提供口径；只读检查夹具，未运行测试、未查 git 历史。
- 引用：§4 链接是厂商文档、厂商具名实测和原始论文；§3/6 为本地样本及 s2s 标签源码。未采用论坛摘录或把 TTS 的 TTFB 当 E2E。自动来源核验未给出确定判断，关键数字已逐项查原文表格；仍缺修复后的浏览器首音、成功结果注入打点和并发实机复测。

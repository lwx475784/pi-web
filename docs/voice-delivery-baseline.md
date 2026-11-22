# 语音送达回归

- server: `http://127.0.0.1:30141` · session `01a20331-f440-707f-b113-c16fca391753` · 2026-11-22T12:23:07.520Z
- asks: 20 · 配对正确 20 · 错配 0 (0.0 %) · 门槛 < 5 % · 未复述编号 0
- pi 侧每问耗时: P50 8882 ms · P90 23864 ms · 最长 45099 ms
- ledger: {"stored":true,"unreadBefore":true,"clearedAfterMark":true}
- speech leg: off (--speech)

| token | 判定 | 配对 | 用时 | 答案开头 |
|---|---|---|---|---|
| QN01 | answered | ✓ | 18394 ms | QN01 完成 |
| QN02 | answered | ✓ | 9030 ms | QN02 完成 |
| QN03 | answered | ✓ | 7458 ms | QN03 完成 |
| QN04 | answered | ✓ | 23864 ms | QN04 完成 |
| QN05 | answered | ✓ | 7388 ms | QN05 完成 |
| QN06 | answered | ✓ | 15155 ms | QN06 完成 |
| QN07 | answered | ✓ | 45099 ms | QN07 完成 |
| QN08 | answered | ✓ | 26283 ms | QN08 完成 |
| QN09 | answered | ✓ | 6892 ms | QN09 完成 |
| QN10 | answered | ✓ | 4410 ms | QN10 完成 |
| QN11 | answered | ✓ | 15524 ms | QN11 完成 |
| QN12 | answered | ✓ | 1029 ms | QN12 完成 |
| QN13 | answered | ✓ | 9950 ms | QN13 |
| QN14 | answered | ✓ | 5314 ms | QN14 完成 |
| QN15 | answered | ✓ | 8882 ms | QN15 完成 |
| QN16 | answered | ✓ | 14401 ms | QN16 完成 |
| QN17 | answered | ✓ | 3966 ms | QN17 完成 |
| QN18 | answered | ✓ | 17759 ms | QN18 |
| QN19 | answered | ✓ | 5709 ms | QN19 |
| QN20 | answered | ✓ | 4200 ms | QN20 |

**未覆盖**：误唤醒率与真实噪声（合成语音测不到，按 ADR 用一周真实日志统计）、浏览器面板的实际播报（脚本走的是服务端契约与账本接口）。

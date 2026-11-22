// What to say when pi has been working on a spoken ask for a long time (ADR 0008 #9). Client-safe.
//
// A voice ask can run for minutes, and the call is otherwise silent until the answer: the user is
// left with a spinner and no way to tell "still reading" from "died quietly". One line, after two
// minutes, settles it. It is deliberately coarse — the alternative is narrating tool names, and
// `launchctl kickstart` read aloud is both ugly and wrong half the time. So the mapping goes from
// what the session is doing to a phrase a person would say, and everything unmapped becomes
// "还在想", which is always true and never misleading.

/** How long an ask may run before the call says anything about it. Once, not every two minutes. */
export const PROGRESS_AFTER_MS = 120_000;

export type ProgressClass = "reading" | "searching" | "writing" | "running" | "delegating" | "thinking";

const TOOL_CLASSES: Array<[ProgressClass, string[]]> = [
  ["reading", ["read", "grep", "find", "ls", "module_report", "read_symbol", "read_enclosing", "symbol_search"]],
  ["searching", ["web_search", "source_check", "fetch_content", "get_search_content"]],
  ["writing", ["edit", "write", "notebook_edit"]],
  ["running", ["bash", "powershell", "codemode", "ast_grep_search", "ast_grep_replace", "lens_diagnostics"]],
  ["delegating", ["subagent", "task", "todo"]],
];

/** The bucket a tool call belongs to, or null when it is not an activity we report. */
export function classifyTool(toolName: unknown): ProgressClass | null {
  if (typeof toolName !== "string" || !toolName) return null;
  const name = toolName.trim().toLowerCase();
  for (const [cls, names] of TOOL_CLASSES) {
    if (names.includes(name)) return cls;
  }
  return null;
}

/**
 * What an agent event tells us about what is happening now. Only a tool starting is reportable:
 * a message or a token stream would make the line flicker every second, and "正在生成" is not news.
 */
export function classifyActivity(event: unknown): ProgressClass | null {
  if (!event || typeof event !== "object") return null;
  const candidate = event as { type?: unknown; toolName?: unknown };
  if (candidate.type !== "tool_execution_start") return null;
  return classifyTool(candidate.toolName);
}

/**
 * How recent a tool activity has to be to be worth naming. A call that started four minutes ago
 * and has said nothing since is not still doing that thing, and "还在想" stays true whatever the
 * session is actually stuck on.
 */
export const ACTIVITY_FRESH_MS = 60_000;

export interface ActivityState { cls: ProgressClass; at: number }

/** The class to report now: the live activity if it is fresh, otherwise an honest "还在想". */
export function pickProgressClass(activity: ActivityState | null, now: number = Date.now()): ProgressClass {
  if (!activity || now - activity.at > ACTIVITY_FRESH_MS) return "thinking";
  return activity.cls;
}

const PHRASES: Record<ProgressClass, string> = {
  reading: "在读你的文件",
  searching: "在查资料",
  writing: "在改东西",
  running: "在跑命令",
  delegating: "在叫别的 agent 帮忙",
  thinking: "还在想",
};

/**
 * The one sentence, model-facing: the voice layer says it in its own words. `seconds` is rounded
 * down on purpose — "已经 3 分钟" that was really 2:10 overstates, and under-stating is harmless.
 */
export function progressLine(elapsedMs: number, cls: ProgressClass): string {
  const minutes = Math.max(1, Math.floor(elapsedMs / 60_000));
  return `pi 还在跑你 ${minutes} 分钟前问的那件事，${PHRASES[cls]}。不用等，先忙别的也行。`;
}

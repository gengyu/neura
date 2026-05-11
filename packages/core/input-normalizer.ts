import { normalizeToText, tokenize } from "../memory/memory.ts";
import { hasSchedulableReminderIntent } from "./reminder-intent.ts";
import type { InputEvent, NormalizedInput } from "./types.ts";

type InputContent = string | {
  path?: string;
  extension?: string | null;
  kind?: string | null;
  mimeType?: string;
  note?: string;
  text?: string;
  summaryHint?: string;
  eventName?: string;
  url?: string;
  [key: string]: unknown;
} | null | undefined;

function isStructuredContent(content: InputContent): content is Exclude<InputContent, string | null | undefined> {
  return typeof content === "object" && content !== null;
}

export function normalizeInputEvent(inputEvent: InputEvent): NormalizedInput {
  const content = inputEvent.content as InputContent;
  const inputType = inputEvent.type ?? "event";
  const sourcePluginId = inputEvent.pluginId ?? "unknown";

  const normalized: NormalizedInput = {
    sourcePluginId,
    inputType,
    sourceKind: classifySource(inputType, sourcePluginId),
    scenario: classifyScenario(inputType, sourcePluginId, content),
    title: buildTitle(inputType, content),
    normalizedText: buildNormalizedText(inputType, content),
    summaryHint: buildSummaryHint(inputType, content),
    keywords: [],
    file: buildFileDescriptor(content),
    image: buildImageDescriptor(content),
    metadata: inputEvent.metadata ?? {},
    signals: {
      userRequestedResponse: false,
      containsQuestion: false,
      containsActionRequest: false,
      containsReminderIntent: false,
      containsMemoryCommand: false,
      asksHistoryLookup: false,
      asksCurrentSummary: false,
      hasLongFormContent: false,
      likelyEphemeral: false,
      likelyDecision: false,
      likelyPreference: false
    },
    memorySearchQuery: "",
    taskType: "context_capture"
  };

  normalized.keywords = tokenize(`${normalized.title}\n${normalized.normalizedText}`).slice(0, 12);
  normalized.signals = deriveSignals(normalized);
  normalized.memorySearchQuery = buildMemorySearchQuery(normalized);
  normalized.taskType = inferTaskType(normalized);
  return normalized;
}

function classifySource(inputType: string, sourcePluginId: string): string {
  if (sourcePluginId === "cli-input") return "direct_user_input";
  if (sourcePluginId === "webhook-input") return "external_event";
  if (sourcePluginId === "folder-watch-input") return "watched_file";
  if (sourcePluginId === "screenshot-watch-input") return "watched_screenshot";
  if (sourcePluginId === "scheduler-input") return "scheduled_input";
  if (inputType === "image") return "visual_capture";
  if (inputType === "file") return "file_capture";
  return "generic_input";
}

function classifyScenario(inputType: string, sourcePluginId: string, content: InputContent): string {
  if (sourcePluginId === "scheduler-input") return "scheduled_check";
  if (sourcePluginId === "webhook-input") return "webhook_event";
  if (sourcePluginId === "screenshot-watch-input" || inputType === "image") return "screenshot_capture";
  if (sourcePluginId === "folder-watch-input" || inputType === "file") return "file_ingest";
  if (sourcePluginId === "cli-input" && typeof content === "string") {
    if (/[?？]/.test(content)) return "query";
    return "idea_capture";
  }
  return "generic_capture";
}

function buildTitle(inputType: string, content: InputContent): string {
  if (typeof content === "string") return content.trim().slice(0, 80) || `Untitled ${inputType}`;
  if (content?.path) return String(content.path).split("/").pop() ?? `Untitled ${inputType}`;
  if (content?.eventName) return String(content.eventName);
  if (content?.url) return String(content.url);
  return `Untitled ${inputType}`;
}

function buildNormalizedText(inputType: string, content: InputContent): string {
  if (typeof content === "string") return content.trim();
  if (inputType === "file" && typeof content?.text === "string") return content.text.trim();
  if (inputType === "image") {
    return [content?.note, content?.text, content?.summaryHint, content?.path].filter(Boolean).join("\n").trim();
  }
  return normalizeToText(content).trim();
}

function buildSummaryHint(inputType: string, content: InputContent): string {
  if (inputType === "image") return "这是一个图片/截图输入，需要理解视觉内容及用户上下文。";
  if (inputType === "file") {
    if (!isStructuredContent(content)) return "这是一个文件输入，需要基于文件内容或元信息提炼关键信息。";
    if (content?.kind === "code") return "这是一个代码文件输入，需要提取目的、模块和关键变化。";
    if (content?.kind === "binary-document") return "这是一个二进制文档输入，可能需要先形成高层摘要。";
    return "这是一个文件输入，需要基于文件内容或元信息提炼关键信息。";
  }
  if (inputType === "event") return "这是一个外部事件输入，需要判断是否值得沉淀为长期记忆。";
  return "这是一个通用输入，需要判断其长期价值、任务价值和输出必要性。";
}

function buildFileDescriptor(content: InputContent): NormalizedInput["file"] {
  if (!isStructuredContent(content)) return null;
  if (!content?.path) return null;
  return {
    path: content.path,
    extension: content.extension ?? null,
    kind: content.kind ?? null
  };
}

function buildImageDescriptor(content: InputContent): NormalizedInput["image"] {
  if (!isStructuredContent(content)) return null;
  if (!content?.path || !content?.mimeType) return null;
  return {
    path: content.path,
    mimeType: content.mimeType
  };
}

function deriveSignals(normalized: NormalizedInput): NormalizedInput["signals"] {
  const text = normalized.normalizedText;
  const lowered = text.toLowerCase();
  return {
    userRequestedResponse:
      normalized.sourcePluginId === "cli-input" ||
      normalized.sourcePluginId === "admin-ui-output" ||
      /[?？]$/.test(text) ||
      /请|帮我|告诉我|总结|分析/.test(text),
    containsQuestion: /[?？]/.test(text),
    containsActionRequest: /请|帮我|执行|生成|整理|检查/.test(text),
    containsReminderIntent: hasSchedulableReminderIntent(text),
    containsMemoryCommand: /记住|保存|存一下|加入记忆|记到|记录下来|帮我记/.test(text),
    asksHistoryLookup: /历史|以前|之前|上次|过去|记忆里|记录里|查找|搜索|找一下|有没有/.test(text),
    asksCurrentSummary: /总结|归纳|提炼|整理一下|概括|摘要|读完/.test(text),
    hasLongFormContent: text.length > 180 || text.split(/\n/u).filter(Boolean).length >= 4,
    likelyEphemeral:
      normalized.scenario === "webhook_event" &&
      !/决策|偏好|计划|项目|设计/.test(text),
    likelyDecision: /决定|方案|结论|采用|确定/.test(text),
    likelyPreference: /喜欢|偏好|希望|不要|只/.test(text) || lowered.includes("prefer")
  };
}

function buildMemorySearchQuery(normalized: NormalizedInput): string {
  const segments = [
    normalized.title,
    ...normalized.keywords.slice(0, 6)
  ].filter(Boolean);
  return segments.join(" ").slice(0, 160) || normalized.normalizedText.slice(0, 160);
}

function inferTaskType(normalized: NormalizedInput): string {
  if (normalized.signals.asksCurrentSummary && normalized.signals.hasLongFormContent) return "summarize_current";
  if (normalized.signals.containsReminderIntent || normalized.scenario === "scheduled_check") return "reminder";
  if (normalized.signals.asksHistoryLookup) return "memory_query";
  if (normalized.signals.containsMemoryCommand) return "memory_capture";
  if (normalized.signals.containsQuestion) return "query";
  if (normalized.signals.containsActionRequest) return "action_request";
  if (normalized.scenario === "webhook_event") return "event_capture";
  if (normalized.scenario === "file_ingest") return "knowledge_ingest";
  if (normalized.scenario === "screenshot_capture") return "visual_capture";
  if (normalized.signals.likelyDecision) return "decision_capture";
  if (normalized.signals.likelyPreference) return "preference_capture";
  return "context_capture";
}

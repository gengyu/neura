const RELATIVE_PATTERNS = [
  { pattern: /(\d+)\s*分钟后/, unitMs: 60_000 },
  { pattern: /(\d+)\s*分后/, unitMs: 60_000 },
  { pattern: /(\d+)\s*小时后/, unitMs: 3_600_000 },
  { pattern: /(\d+)\s*h(?:ours?)?\s*later/i, unitMs: 3_600_000 },
  { pattern: /(\d+)\s*天后/, unitMs: 86_400_000 },
  { pattern: /(\d+)\s*d(?:ays?)?\s*later/i, unitMs: 86_400_000 }
];

export function detectReminderPlan(normalizedInput, analysis) {
  if (normalizedInput.taskType !== "reminder" && analysis?.taskType !== "reminder") return null;
  const text = normalizedInput.normalizedText;
  const runAt = detectRunAt(text);
  if (!runAt) return null;

  const reminderText = extractReminderText(text, analysis?.summary, normalizedInput.title);
  return {
    name: buildReminderName(reminderText),
    mode: "reminder",
    content: { text: reminderText },
    runAt,
    intervalMs: null
  };
}

function detectRunAt(text) {
  for (const item of RELATIVE_PATTERNS) {
    const match = text.match(item.pattern);
    if (match) {
      return new Date(Date.now() + Number(match[1]) * item.unitMs).toISOString();
    }
  }
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
  if (isoMatch) {
    const parsed = new Date(isoMatch[0]);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function extractReminderText(text, summary, title) {
  const cleaned = text
    .replace(/^\s*提醒我\s*/u, "")
    .replace(/(\d+\s*(分钟|分|小时|天)后)/gu, "")
    .replace(/\d+\s*h(?:ours?)?\s*later/giu, "")
    .trim();
  return cleaned || summary || title || "回看这条记录";
}

function buildReminderName(text) {
  return `提醒: ${text}`.slice(0, 40);
}

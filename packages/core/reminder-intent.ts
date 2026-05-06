const RELATIVE_PATTERNS = [
  { pattern: /(\d+)\s*分钟后/, unitMs: 60_000 },
  { pattern: /(\d+)\s*分后/, unitMs: 60_000 },
  { pattern: /(\d+)\s*小时后/, unitMs: 3_600_000 },
  { pattern: /(\d+)\s*h(?:ours?)?\s*later/i, unitMs: 3_600_000 },
  { pattern: /(\d+)\s*天后/, unitMs: 86_400_000 },
  { pattern: /(\d+)\s*d(?:ays?)?\s*later/i, unitMs: 86_400_000 }
];

const WEEKDAY_INDEX = new Map([
  ["日", 0],
  ["天", 0],
  ["一", 1],
  ["二", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6]
]);

export function hasSchedulableReminderIntent(text) {
  return hasReminderKeyword(text) && (Boolean(detectRunAt(text)) || Boolean(detectIntervalMs(text)));
}

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
    intervalMs: detectIntervalMs(text)
  };
}

function hasReminderKeyword(text) {
  return /提醒|稍后|待办|回头|todo/i.test(text);
}

function detectRunAt(text) {
  for (const item of RELATIVE_PATTERNS) {
    const match = text.match(item.pattern);
    if (match) {
      return new Date(Date.now() + Number(match[1]) * item.unitMs).toISOString();
    }
  }

  const dayBased = detectDayBasedRunAt(text);
  if (dayBased) return dayBased.toISOString();

  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
  if (isoMatch) {
    const parsed = new Date(isoMatch[0]);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function detectDayBasedRunAt(text) {
  const now = new Date();
  const target = new Date(now);

  if (/明早|明天早上/.test(text)) {
    target.setDate(target.getDate() + 1);
    setClock(target, 9, 0);
    return target;
  }
  if (/明晚|明天晚上/.test(text)) {
    target.setDate(target.getDate() + 1);
    setClock(target, 20, 0);
    return target;
  }
  if (/今晚/.test(text)) {
    setClock(target, 20, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target;
  }
  if (/明天/.test(text)) {
    target.setDate(target.getDate() + 1);
    setClock(target, ...detectClock(text, 9, 0));
    return target;
  }

  const weekdayMatch = text.match(/下周([日天一二三四五六])/u);
  if (weekdayMatch) {
    const weekday = WEEKDAY_INDEX.get(weekdayMatch[1]);
    const daysUntilNextWeek = 7 - now.getDay() + weekday;
    target.setDate(target.getDate() + daysUntilNextWeek);
    setClock(target, ...detectClock(text, 9, 0));
    return target;
  }

  const dateMatch = text.match(/(\d{1,2})月(\d{1,2})[日号]?(?:\s*(\d{1,2})[:点](\d{1,2})?)?/u);
  if (dateMatch) {
    target.setMonth(Number(dateMatch[1]) - 1, Number(dateMatch[2]));
    setClock(target, Number(dateMatch[3] ?? 9), Number(dateMatch[4] ?? 0));
    if (target <= now) target.setFullYear(target.getFullYear() + 1);
    return target;
  }

  return null;
}

function detectIntervalMs(text) {
  if (/每天|每日/.test(text)) return 86_400_000;
  if (/每周|每星期/.test(text)) return 7 * 86_400_000;
  if (/每月/.test(text)) return 30 * 86_400_000;
  return null;
}

function extractReminderText(text, summary, title) {
  const cleaned = text
    .replace(/^\s*提醒我\s*/u, "")
    .replace(/(\d+\s*(分钟|分|小时|天)后)/gu, "")
    .replace(/\d+\s*h(?:ours?)?\s*later/giu, "")
    .replace(/(明早|明晚|明天早上|明天晚上|明天|今晚|下周[日天一二三四五六]|每天|每日|每周|每星期|每月)/gu, "")
    .replace(/\d{1,2}月\d{1,2}[日号]?/gu, "")
    .trim();
  return cleaned || summary || title || "回看这条记录";
}

function buildReminderName(text) {
  return `提醒: ${text}`.slice(0, 40);
}

function detectClock(text, fallbackHour, fallbackMinute) {
  const match = text.match(/(\d{1,2})[:点](\d{1,2})?/u);
  if (!match) return [fallbackHour, fallbackMinute];
  return [Number(match[1]), Number(match[2] ?? 0)];
}

function setClock(date, hour, minute) {
  date.setHours(hour, minute, 0, 0);
}

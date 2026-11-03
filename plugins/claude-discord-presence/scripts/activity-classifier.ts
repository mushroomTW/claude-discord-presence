// 從 Claude 對話紀錄尾端的 JSONL 內容推斷目前的活動狀態。
// assistant 訊息是逐 block 寫入（thinking、tool_use、text 各自成行），
// 由後往前找到第一筆代表活動的紀錄即可。
const EDIT_TOOL_NAMES = /^(Edit|MultiEdit|Write|NotebookEdit)$/i;

interface ContentBlock {
  type?: string;
  name?: unknown;
}

interface TranscriptRecord {
  type?: string;
  message?: { content?: unknown };
}

function classifyAssistantContent(content: (ContentBlock | null)[]) {
  const toolUse = content.find((block) => block?.type === 'tool_use');
  if (toolUse) return EDIT_TOOL_NAMES.test(String(toolUse.name || '')) ? 'Editing' : 'Running tools';
  if (content.some((block) => block?.type === 'text')) return 'Waiting';
  if (content.some((block) => block?.type === 'thinking')) return 'Thinking';
  return null;
}

function classifyUserContent(content: unknown) {
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return 'Reading results';
  // 使用者送出提示後，模型接著開始思考。
  return 'Thinking';
}

function classifyRecord(record: TranscriptRecord) {
  const content = record?.message?.content;
  if (record.type === 'assistant' && Array.isArray(content)) {
    return classifyAssistantContent(content);
  }
  if (record.type === 'user') {
    return classifyUserContent(content);
  }
  if (record.type === 'progress') return 'Running tools';
  // attachment、mode、custom-title、queue-operation、system 等紀錄不代表活動。
  return null;
}

export function classifyActivity(text: unknown): string {
  for (const value of String(text).split(/\r?\n/).reverse()) {
    if (!value) continue;
    try {
      const label = classifyRecord(JSON.parse(value));
      if (label) return label;
    } catch {
      // 略過不完整或無法辨識的紀錄。
    }
  }
  return 'Working';
}

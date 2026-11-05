import type { Message, Part, ServerEvent } from "../api.ts"

/**
 * Transcript hiển thị = messages đã lưu + phần đang stream.
 * Reducer này áp sự kiện SSE lên mảng messages theo cùng cấu trúc store
 * (assistant message có parts text / tool-call / tool-result), để sau reload
 * vẫn render giống hệt.
 */
export interface ChatState {
  messages: Message[]
  running: boolean
  error?: string
  notices: string[]
}

export function applyEvent(state: ChatState, ev: ServerEvent, sessionID: string): ChatState {
  if (!("sessionID" in ev) || ev.sessionID !== sessionID) return state
  switch (ev.type) {
    case "turn":
      return { ...state, running: ev.running, error: ev.error, messages: ev.running ? state.messages : closeAssistant(state.messages) }
    case "text":
      return { ...state, messages: appendText(state.messages, ev.delta) }
    case "tool-start":
      return { ...state, messages: appendPart(state.messages, { type: "tool-call", callID: ev.callID, name: ev.name, args: ev.args }) }
    case "tool-end":
      return { ...state, messages: appendPart(state.messages, { type: "tool-result", callID: ev.callID, name: ev.name, output: ev.output, isError: ev.isError }) }
    case "notice":
      return { ...state, notices: [...state.notices.slice(-20), ev.text] }
    default:
      return state
  }
}

const STREAM_ID = "__streaming__"

function streaming(messages: Message[]): Message | undefined {
  const last = messages[messages.length - 1]
  return last?.id === STREAM_ID ? last : undefined
}

function appendText(messages: Message[], delta: string): Message[] {
  const cur = streaming(messages)
  if (!cur) {
    return [...messages, { id: STREAM_ID, role: "assistant", createdAt: Date.now(), parts: [{ type: "text", text: delta }] }]
  }
  const parts = [...cur.parts]
  const last = parts[parts.length - 1]
  if (last?.type === "text") parts[parts.length - 1] = { type: "text", text: last.text + delta }
  else parts.push({ type: "text", text: delta })
  return [...messages.slice(0, -1), { ...cur, parts }]
}

function appendPart(messages: Message[], part: Part): Message[] {
  const cur = streaming(messages)
  if (!cur) return [...messages, { id: STREAM_ID, role: "assistant", createdAt: Date.now(), parts: [part] }]
  return [...messages.slice(0, -1), { ...cur, parts: [...cur.parts, part] }]
}

/** Turn kết thúc: gắn id thật cho message đang stream để lần render sau không nối nhầm. */
function closeAssistant(messages: Message[]): Message[] {
  const cur = streaming(messages)
  if (!cur) return messages
  return [...messages.slice(0, -1), { ...cur, id: `local_${cur.createdAt}` }]
}

export function userMessage(text: string): Message {
  return { id: `local_${Date.now()}`, role: "user", source: "user", createdAt: Date.now(), parts: [{ type: "text", text }] }
}

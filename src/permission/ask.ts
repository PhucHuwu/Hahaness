export interface AskRequest {
  id: string
  sessionID: string
  agent: string
  action: string
  resource: string
  description: string
}

export type AskReply = { kind: "once" } | { kind: "always" } | { kind: "reject"; feedback?: string }

export type AskHandler = (req: AskRequest) => Promise<AskReply>

/**
 * Gate tuần tự: nhiều tool cần hỏi cùng lúc thì hỏi lần lượt, user không bị
 * dồn nhiều prompt một lúc.
 */
export class AskGate {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private handler: AskHandler) {}

  ask(req: AskRequest, signal?: AbortSignal): Promise<AskReply> {
    const run = this.chain.then(() => {
      if (signal?.aborted) return { kind: "reject", feedback: "interrupted" } as AskReply
      return this.handler(req)
    })
    this.chain = run.catch(() => {})
    return run
  }
}

export class PermissionRejected extends Error {
  constructor(public action: string, public resource: string, public feedback?: string) {
    super(feedback ? `Permission rejected: ${feedback}` : `Permission rejected for ${action} ${resource}`)
  }
}

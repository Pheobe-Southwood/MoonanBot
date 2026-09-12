import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

interface Flow {
  id: string;
  providerId: string;
  state: "running" | "completed" | "failed" | "cancelled";
  events: Array<AuthEvent | { type: "prompt"; prompt: AuthPrompt } | { type: "done" } | { type: "error"; message: string }>;
  waiting: { resolve: (answer: string) => void; reject: (error: Error) => void } | undefined;
  controller: AbortController;
  listeners: Set<(event: Flow["events"][number]) => void>;
}

export class OAuthFlowManager {
  private readonly flows = new Map<string, Flow>();

  create(providerId: string, run: (interaction: AuthInteraction) => Promise<void>): string {
    const flow: Flow = { id: randomUUID(), providerId, state: "running", events: [], waiting: undefined, controller: new AbortController(), listeners: new Set() };
    this.flows.set(flow.id, flow);
    const emit = (event: Flow["events"][number]) => {
      flow.events.push(event);
      for (const listener of flow.listeners) listener(event);
    };
    const interaction: AuthInteraction = {
      signal: flow.controller.signal,
      notify: emit,
      prompt: async (prompt) => {
        emit({ type: "prompt", prompt });
        return await new Promise<string>((resolve, reject) => { flow.waiting = { resolve, reject }; });
      },
    };
    void run(interaction).then(() => {
      flow.state = "completed";
      emit({ type: "done" });
    }).catch((error) => {
      if (flow.state === "cancelled") return;
      flow.state = "failed";
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return flow.id;
  }

  get(id: string): Flow | undefined { return this.flows.get(id); }

  answer(id: string, answer: string): void {
    const flow = this.flows.get(id);
    if (!flow?.waiting) throw new Error("oauth_flow_not_waiting");
    const waiting = flow.waiting;
    flow.waiting = undefined;
    waiting.resolve(answer);
  }

  cancel(id: string): void {
    const flow = this.flows.get(id);
    if (!flow) return;
    flow.state = "cancelled";
    flow.controller.abort();
    flow.waiting?.reject(new Error("OAuth flow cancelled"));
    flow.waiting = undefined;
  }

  subscribe(id: string, listener: (event: Flow["events"][number]) => void): () => void {
    const flow = this.flows.get(id);
    if (!flow) throw new Error("oauth_flow_not_found");
    flow.listeners.add(listener);
    return () => flow.listeners.delete(listener);
  }
}

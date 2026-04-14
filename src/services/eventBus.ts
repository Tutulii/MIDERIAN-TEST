import { AgentEventType, AgentEventPayloads } from "../types/events";
import { logger } from "../utils/logger";

type EventHandler<T extends AgentEventType> = (
  payload: AgentEventPayloads[T]
) => void | Promise<void>;

class EventBus {
  private listeners: {
    [K in AgentEventType]?: EventHandler<K>[];
  } = {};

  public subscribe<T extends AgentEventType>(
    eventType: T,
    handler: EventHandler<T>
  ): void {
    if (!this.listeners[eventType]) {
      this.listeners[eventType] = [];
    }
    this.listeners[eventType]!.push(handler as any);
  }

  public publish<T extends AgentEventType>(
    eventType: T,
    payload: AgentEventPayloads[T]
  ): void {
    // Suppress debug logging for high-frequency routine events to keep logs clean
    const QUIET_EVENTS: string[] = ["agent_alive", "treasury_checked", "force_recovery"];
    if (!QUIET_EVENTS.includes(eventType as string)) {
      logger.debug("event_published", {
        event_type: eventType,
        payload: payload as Record<string, unknown>,
      });
    }

    const handlers = this.listeners[eventType];
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          logger.error("event_handler_error", { event_type: eventType }, error);
        }
      });
    }
  }
}

export const eventBus = new EventBus();

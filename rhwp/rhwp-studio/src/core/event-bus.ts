type Handler = (...args: unknown[]) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((h) => h(...args));
  }

  removeAll(): void {
    this.handlers.clear();
  }
}

interface PageSubscription {
  /** 대상 버스에 실제로 거는 함수. 세션 쪽 같은 핸들러와 Set 에서 겹치지 않게 감싼다. */
  readonly relay: Handler;
  off: () => void;
}

/**
 * 화면에 붙은 문서 세션의 EventBus 로 전달하는 페이지용 버스.
 *
 * 페이지 코드가 `on` 으로 건 구독은 현재 세션 버스에 걸리고, `retarget` 하면 새 세션 버스로
 * 옮겨 간다. 그래서 세션 코드(에이전트 브리지 등)가 자기 버스에 낸 이벤트도 붙어 있는 동안에는
 * 페이지 구독자가 듣는다. `emit` 은 현재 세션 버스로 내고(세션 구독자도 듣는다), `emitPage` 는
 * 이 퍼사드로 건 페이지 구독자에게만 낸다. 세션 버스 안에서 페이지 구독은 그 버스의 기존
 * 구독 뒤에 붙는다.
 */
export class AttachableEventBus extends EventBus {
  private target: EventBus;
  private readonly page = new Map<string, Map<Handler, PageSubscription>>();

  constructor(initial: EventBus) {
    super();
    if (initial instanceof AttachableEventBus) {
      throw new Error('AttachableEventBus cannot wrap another AttachableEventBus');
    }
    this.target = initial;
  }

  override on(event: string, handler: Handler): () => void {
    let handlers = this.page.get(event);
    if (!handlers) {
      handlers = new Map();
      this.page.set(event, handlers);
    }
    // EventBus 와 같이 같은 (이벤트, 핸들러) 는 한 번만 등록된다.
    if (!handlers.has(handler)) {
      const relay: Handler = (...args) => handler(...args);
      handlers.set(handler, { relay, off: this.target.on(event, relay) });
    }
    return () => {
      const subscriptions = this.page.get(event);
      const subscription = subscriptions?.get(handler);
      if (!subscriptions || !subscription) return;
      subscription.off();
      subscriptions.delete(handler);
      if (subscriptions.size === 0) this.page.delete(event);
    };
  }

  override emit(event: string, ...args: unknown[]): void {
    this.target.emit(event, ...args);
  }

  /** 이 퍼사드로 구독한 페이지 핸들러에게만 낸다. 세션 버스의 구독자는 듣지 않는다. */
  emitPage(event: string, ...args: unknown[]): void {
    const handlers = this.page.get(event);
    if (!handlers) return;
    for (const handler of [...handlers.keys()]) {
      // 앞선 핸들러가 구독을 끊었으면 부르지 않는다 (EventBus.emit 의 Set 순회와 같은 결과).
      if (handlers.has(handler)) handler(...args);
    }
  }

  /** 페이지 구독을 새 세션 버스로 옮긴다. 옛 버스에는 페이지 구독이 남지 않는다. */
  retarget(bus: EventBus): void {
    if (bus === this.target) return;
    if (bus instanceof AttachableEventBus) {
      throw new Error('AttachableEventBus cannot target another AttachableEventBus');
    }
    this.target = bus;
    for (const [event, handlers] of this.page) {
      for (const subscription of handlers.values()) {
        subscription.off();
        subscription.off = bus.on(event, subscription.relay);
      }
    }
  }

  current(): EventBus {
    return this.target;
  }

  /** 페이지 구독만 모두 끊는다. 세션 버스의 다른 구독자는 건드리지 않는다. */
  override removeAll(): void {
    for (const handlers of this.page.values()) {
      for (const subscription of handlers.values()) subscription.off();
    }
    this.page.clear();
  }
}

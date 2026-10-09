import { randomUUID } from 'node:crypto';

// A window's visible document uses the window session. Documents whose agent
// keeps working in the background each need their own hub session. The hub
// holds 64 sessions in total, so one window may not take them all.
export const MAX_EXTRA_AGENT_SESSIONS_PER_WINDOW = 15;

export class SessionManager {
  #createId;
  #getHubContext;
  #getSessionCapabilities;
  #closeHubSession;
  #launchId;
  #sessions = new Map();
  #senderSessions = new Map();
  #windowSessions = new WeakMap();
  // Extra hub sessions: sessionId -> owning window session.
  #agentSessions = new Map();

  constructor({
    launchId,
    getHubContext,
    getSessionCapabilities,
    closeHubSession = async () => {},
    createId = randomUUID,
  } = {}) {
    if (!launchId) throw new Error('SessionManager requires a launchId');
    if (typeof getHubContext !== 'function') throw new Error('SessionManager requires getHubContext');
    if (typeof getSessionCapabilities !== 'function') {
      throw new Error('SessionManager requires getSessionCapabilities');
    }
    this.#launchId = launchId;
    this.#getHubContext = getHubContext;
    this.#getSessionCapabilities = getSessionCapabilities;
    this.#closeHubSession = closeHubSession;
    this.#createId = createId;
  }

  addWindow(window, launch = {}) {
    const sessionId = this.#createId();
    const sender = window?.webContents;
    const senderId = sender?.id;
    if (!Number.isInteger(senderId)) throw new Error('Session window requires an owned webContents');
    if (this.#senderSessions.has(senderId)) throw new Error(`webContents ${senderId} already owns a session`);

    const session = {
      sessionId,
      window,
      sender,
      senderId,
      agentSessionIds: new Set(),
      launch: {
        openFiles: [...(launch.openFiles ?? [])],
        source: launch.source ?? 'launch',
      },
    };
    this.#sessions.set(sessionId, session);
    this.#senderSessions.set(senderId, session);
    this.#windowSessions.set(window, session);
    return session;
  }

  removeWindow(window) {
    const session = window && this.#windowSessions.get(window);
    if (!session || session.window !== window) return false;
    this.releaseAgentSessions(window);
    this.#windowSessions.delete(window);
    this.#senderSessions.delete(session.senderId);
    this.#sessions.delete(session.sessionId);
    return true;
  }

  sessionForSender(sender) {
    const session = this.#senderSessions.get(sender?.id);
    if (!session || session.sender !== sender || session.window.isDestroyed?.() || sender.isDestroyed?.()) {
      throw new Error('IPC sender does not own a desktop session');
    }
    return session;
  }

  /**
   * Without `agentSessionId` this is the window's own session. An extra
   * session resolves only for the window that created it.
   */
  async contextForSender(sender, agentSessionId = null) {
    const session = this.sessionForSender(sender);
    const sessionId = agentSessionId === null || agentSessionId === undefined
      ? session.sessionId
      : this.#ownedAgentSession(session, agentSessionId);
    const hub = await this.#getHubContext();
    const capabilities = await this.#getSessionCapabilities(sessionId, hub);
    // Registration re-creates a hub session that was closed while it ran.
    if (!this.#isLive(sessionId)) {
      void Promise.resolve()
        .then(() => this.#closeHubSession(sessionId))
        .catch(() => {});
      throw new Error('Desktop session was released');
    }
    return Object.freeze({
      launchId: this.#launchId,
      sessionId,
      hubUrl: hub.hubUrl,
      hubToken: capabilities.studio,
      referenceToken: capabilities.reference,
      templateToken: capabilities.template,
    });
  }

  /** A new hub session id owned by the sender's window. Registered on first context. */
  addAgentSession(sender) {
    const session = this.sessionForSender(sender);
    if (session.agentSessionIds.size >= MAX_EXTRA_AGENT_SESSIONS_PER_WINDOW) {
      throw new Error('This window has too many agent sessions');
    }
    const sessionId = this.#createId();
    if (this.#sessions.has(sessionId) || this.#agentSessions.has(sessionId)) {
      throw new Error('Session id collision');
    }
    this.#agentSessions.set(sessionId, session);
    session.agentSessionIds.add(sessionId);
    return sessionId;
  }

  /** Forget one extra session and close it on the hub so its provider process exits. */
  async releaseAgentSession(sender, agentSessionId) {
    const session = this.sessionForSender(sender);
    if (this.#agentSessions.get(agentSessionId) !== session) return false;
    this.#agentSessions.delete(agentSessionId);
    session.agentSessionIds.delete(agentSessionId);
    await this.#closeHubSession(agentSessionId);
    return true;
  }

  /**
   * Close every extra session of a window: on close, renderer death and
   * reload. Only the window session survives a reload.
   */
  releaseAgentSessions(window) {
    const session = window && this.#windowSessions.get(window);
    if (!session) return [];
    const released = [...session.agentSessionIds];
    session.agentSessionIds.clear();
    for (const sessionId of released) {
      this.#agentSessions.delete(sessionId);
      void Promise.resolve()
        .then(() => this.#closeHubSession(sessionId))
        .catch(() => {});
    }
    return released;
  }

  sessionById(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  focusSession(sessionId) {
    const window = this.sessionById(sessionId)?.window;
    if (!window || window.isDestroyed?.()) return false;
    if (window.isMinimized?.()) window.restore();
    window.show?.();
    window.focus?.();
    return true;
  }

  windows() {
    return [...this.#sessions.values()]
      .map((session) => session.window)
      .filter((window) => !window.isDestroyed?.());
  }

  get size() {
    return this.#sessions.size;
  }

  #ownedAgentSession(session, agentSessionId) {
    if (typeof agentSessionId !== 'string' || this.#agentSessions.get(agentSessionId) !== session) {
      throw new Error('IPC sender does not own this agent session');
    }
    return agentSessionId;
  }

  #isLive(sessionId) {
    return this.#sessions.has(sessionId) || this.#agentSessions.has(sessionId);
  }
}

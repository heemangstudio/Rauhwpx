// HTTP previews on LAN/Tailscale are not secure contexts, so randomUUID may
// be absent. Install before importing the fixtures and production sidebar.
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

// Reset before importing production modules, which hydrate IndexedDB on import.
const url = new URL(location.href);
if (url.searchParams.get('reset') === '1') {
  localStorage.clear();
  sessionStorage.clear();
  const databases = await indexedDB.databases();
  await Promise.all(
    databases
      .filter((database) => database.name)
      .map(
        (database) =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(database.name!);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () =>
              reject(
                new Error('Close other sidebar preview tabs before resetting.'),
              );
          }),
      ),
  );
  url.searchParams.delete('reset');
  history.replaceState(null, '', url);
}
// `chats=sample` restores the sample chats on every load. They go through the
// thread store's legacy localStorage import, the only path that keeps their
// past timestamps, so they must be written before the store hydrates on import.
// `chats=engine-trap` adds the shown document's chat stopped by an engine trap.
const chatsParam = url.searchParams.get('chats');
if (chatsParam === 'sample' || chatsParam === 'engine-trap') {
  const {
    engineTrapInterruptedChat, sampleChats, sampleReloadQuestionDraft, sampleRunningTurnWork, SAMPLE_WORKING_CHAT_ID,
  } = await import('./fixtures.ts');
  const key = 'rhwp-agent-threads';
  const now = Date.now();
  const seeded = [
    ...sampleChats(now),
    ...(chatsParam === 'engine-trap' ? [engineTrapInterruptedChat(now)] : []),
  ];
  // `chats=sample&reload=running|question` opens as if the page reloaded while the working
  // chat's turn kept running: its stored copy is the newest, and `question` adds the draft the
  // old page saved.
  const reload = chatsParam === 'sample' ? url.searchParams.get('reload') : null;
  const working = seeded.find((thread) => thread.id === SAMPLE_WORKING_CHAT_ID);
  if (working && (reload === 'running' || reload === 'question')) {
    working.updatedAt = now;
    // 그 턴이 시작될 때 남긴 열린 표식과 지금까지의 작업 — 다시 잡은 턴의 실제 끝이 접는다.
    working.messages.push(...sampleRunningTurnWork(working.agent, now));
    if (reload === 'question') working.pendingUserQuestion = sampleReloadQuestionDraft(now);
  }
  const ids = new Set(seeded.map((thread) => thread.id));
  let pending: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(parsed)) pending = parsed;
  } catch { /* Unreadable legacy data is replaced by the samples. */ }
  const kept = pending.filter((row) => !ids.has(String((row as { id?: unknown } | null)?.id)));
  localStorage.setItem(key, JSON.stringify([...kept, ...seeded]));
  // fixtures 가 채팅 저장소를 함께 불러와 이미 읽어 들였을 수 있다 — 쓴 표본을 다시 읽게 한다.
  const { reloadThreadsFromStorage } = await import('../agent/threads.ts');
  await reloadThreadsFromStorage();
}
await import('./main.ts');
export {};

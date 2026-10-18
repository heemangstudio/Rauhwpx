// 브라우저 요청 카드의 허브 쪽 연결. 사이트 사용·로그인 저장·직접 하기·비밀 카드를 만들고, 승인을 정책에 쓴 뒤 채팅을 이어 간다.
// 결정은 browser-policy 의 check() 하나가 내리고, 이 모듈은 무엇을 물을지와 승인이 무엇을 쓰는지만 정한다.
import { SITE_ACCESS_ACTIONS, browserOrigin, sameSite, siteName, siteScope } from './browser-policy.mjs';

function failure(code, message) { return Object.assign(new Error(message), { code }); }
const quoted = (value) => `"${String(value ?? '').replace(/[\r\n"“”]+/g, ' ').trim().slice(0, 80)}"`;
const SCOPES = new Set(['chat', 'always']);
const sameChat = (left, right) => ['threadId', 'documentId', 'projectId'].every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
const SITE_KINDS = new Set(['browser-site-access', 'browser-use-account', 'secret-use']);

/** 거절을 도구 결과·Studio 응답에 싣는 모양. 정책 거절이면 다음 호출(request)까지 담는다. */
export function denialPayload(error, fallback = 'BROWSER_REQUEST_FAILED') {
  const payload = { code: error?.code ?? fallback, message: String(error?.message ?? 'The browser request failed.') };
  if (typeof error?.retryable === 'boolean') payload.retryable = error.retryable;
  for (const key of ['reason', 'site', 'origin', 'request', 'blocked', 'item', 'performed']) if (error?.[key] !== undefined) payload[key] = error[key];
  return payload;
}

/** 사용자가 답한 브라우저·비밀 카드 뒤에 에이전트에게 보내는 고정 문장. */
export function browserContinuationText(request, outcome, detail = {}) {
  const site = request.site ?? (request.origin ? siteName(request.origin) : 'the website');
  if (outcome.status === 'denied') {
    const subject = request.kind === 'secret-save' ? `the secret ${quoted(request.secretLabel)}`
      : request.kind === 'browser-sign-in' || request.kind === 'browser-code' ? `the browser handoff on ${request.origin}`
        : request.kind === 'browser-save-account' ? `saving a login for ${site}`
          : `access to ${site}`;
    return `The user declined ${subject}. Continue without it and do not ask for it again this turn.`;
  }
  if (request.kind === 'browser-code') return `The user entered the verification code on ${request.origin}; continue.`;
  if (request.kind === 'browser-sign-in') return `The user finished signing in on ${request.origin}; continue.`;
  const where = request.siteDomain ? `${request.siteDomain} and its subdomains` : site;
  const scope = detail.scope === 'always' ? 'in every chat' : 'for this chat';
  if (request.kind === 'browser-save-account' && detail.federated) {
    return `The user signed in to ${where} with another account such as Google, so there is no password to save. The browser session is signed in and the site is allowed ${scope}. Reload the tab if it still shows the sign-in page, and do not ask to save a login for this site again. Continue.`;
  }
  if (request.kind === 'browser-save-account') {
    const login = detail.account ? ` Fill it with browser_fill_account (accountId ${detail.account.id}), then submit the form.` : '';
    return `The user saved a login for ${where} and allowed the site ${scope}.${login} Continue.`;
  }
  if (request.kind === 'secret-save') {
    return `The user saved the secret ${quoted(detail.label ?? request.secretLabel)} (secretId ${detail.secretId ?? request.secretId}) and allowed its site ${scope}. Type it with browser_fill_secret; you never see its value. Continue.`;
  }
  const logins = (request.logins ?? []).filter((login) => !login.agentBlocked || request.item?.accountId === login.id);
  const secrets = (request.secrets ?? []).filter((secret) => !secret.blocked || request.item?.secretId === secret.id);
  const lines = [
    ...logins.slice(0, 3).map((login) => ` Saved login ${quoted(login.label)} (accountId ${login.id}): fill it with browser_fill_account.`),
    ...secrets.slice(0, 3).map((secret) => ` Saved secret ${quoted(secret.label)} (secretId ${secret.id}): type it with browser_fill_secret.`),
  ];
  const lifted = request.blocked?.length ? ` The owner turned ${request.blocked.join(', ')} back on.` : '';
  return `The user allowed ${where} ${scope}: reading while signed in, website changes, and its saved logins and secrets.${lifted}${lines.join('')} Retry what you were doing.`;
}

/**
 * @param {{ policy: any, broker: any, ownedBrowser: any, userSecrets: any,
 *   publish: (request: Record<string, any>) => any,
 *   settle: (requestId: string, outcome: Record<string, any>, continuation: string | null) => any }} deps
 */
export function createBrowserRequests({ policy, broker, ownedBrowser, userSecrets, publish, settle }) {
  /** 활성 런타임의 로그인(네이티브면 보관함, 관리형이면 허브 로그인)과 이 채팅이 볼 수 있는 비밀 중 이 사이트의 것. 정확한 출처가 먼저다. */
  async function siteItems(origin, actor) {
    const requested = browserOrigin(origin);
    const native = ownedBrowser.usesNativeVault?.() === true;
    const stored = native ? await ownedBrowser.nativeAccounts().catch(() => [])
      : ((await broker.listAccounts().catch(() => null))?.accounts ?? []).filter((account) => account.profileId === 'default');
    const logins = stored.filter((account) => { try { return sameSite(account.origin, requested); } catch { return false; } })
      .sort((a, b) => Number(b.origin === requested) - Number(a.origin === requested))
      .map((account) => ({ id: account.id, label: account.label || account.username || siteName(account.origin), origin: account.origin, source: native ? 'vault' : 'hub', agentBlocked: account.agentBlocked === true }));
    const secrets = (await userSecrets?.forSite?.(requested, actor?.threadId).catch(() => [])) ?? [];
    return { logins, secrets: secrets.map((secret) => ({ id: secret.id, label: secret.label, kind: secret.kind, origins: secret.origins, blocked: secret.blocked === true })) };
  }

  /** 카드를 만들고(같은 채팅·같은 사이트면 열린 카드를 그대로) Studio 에 한 번만 보인다. */
  async function openCard(actor, input) {
    const request = await broker.requestAccount({ actor, ...input });
    if (!request.duplicate) {
      try { publish(request); } catch (error) { broker.discardAccountRequest(request.requestId); throw error; }
    }
    return request;
  }

  /** browser_request_account. 이미 사이트 사용이 있으면 카드 없이 granted 를 돌려준다. */
  async function requestSiteAccess(actor, args = {}) {
    let kind = args.kind ?? 'account';
    if (kind === 'sign-in' || kind === 'code') {
      if (!args.tabId || !ownedBrowser.ownsTarget(actor, { tabId: args.tabId })) throw failure('BROWSER_TAB_NOT_FOUND', 'The browser tab is unavailable to this chat.');
      const request = await openCard(actor, { kind, origin: args.origin, tabId: args.tabId, label: args.label, reason: args.reason });
      return { pending: true, requestId: request.requestId, origin: request.origin, kind };
    }
    const origin = browserOrigin(args.origin);
    const site = siteName(origin);
    const items = await siteItems(origin, actor);
    if (args.accountId && !items.logins.some((login) => login.id === args.accountId)) {
      const elsewhere = ownedBrowser.usesNativeVault?.() ? await ownedBrowser.nativeAccount(args.accountId).catch(() => null)
        : ((await broker.listAccounts().catch(() => null))?.accounts ?? []).find((account) => account.id === args.accountId);
      if (elsewhere) throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'The saved account belongs to a different website.');
    }
    // 저장된 로그인이 있으면 저장 양식 대신 사이트 카드 하나로 묻는다.
    if (kind === 'account' && items.logins.length) kind = 'site';
    if (kind === 'account') {
      const request = await openCard(actor, { kind: 'account', origin, tabId: args.tabId, label: args.label, reason: args.reason });
      return { pending: true, requestId: request.requestId, origin, kind, site };
    }
    const blockedHere = await policy.blockedActionsFor(origin);
    // 사이트 사용에 필요한 차단, 에이전트가 넘긴 차단, 이 채팅이 최근에 부딪힌 차단만 카드에 올린다.
    const wanted = new Set([...SITE_ACCESS_ACTIONS, ...(Array.isArray(args.blocked) ? args.blocked : []), ...(policy.recentBlockedActions?.(actor, origin) ?? [])]);
    const blocked = blockedHere.filter((action) => wanted.has(action));
    const offLogin = args.accountId ? items.logins.find((login) => login.id === args.accountId && login.agentBlocked) : null;
    const item = offLogin ? { accountId: offLogin.id } : null;
    if (!blocked.length && !item && await policy.hasSiteAccess(actor, origin)) return { granted: true, site, origin };
    const request = await openCard(actor, { kind: 'site', origin, tabId: args.tabId, label: args.label, reason: args.reason, logins: items.logins, secrets: items.secrets, blocked, item });
    return { pending: true, requestId: request.requestId, origin, kind: 'site', site };
  }

  /** sites.approve: 차단을 푸는 카드는 항상, 아니면 고른 범위. 같은 채팅·같은 사이트의 열린 카드는 모두 닫는다. */
  async function approveSite(actor, { requestId, scope } = {}) {
    const pending = await broker.getAccountRequest(String(requestId ?? ''));
    if (!pending) throw failure('BROWSER_ACCOUNT_REQUEST_EXPIRED', 'The site request expired. Ask the agent again.');
    if (!SITE_KINDS.has(pending.kind)) throw failure('BROWSER_ACCOUNT_REQUEST_INVALID', 'This request is not a site access request.');
    const blocked = pending.blocked ?? [];
    const chosen = blocked.length || pending.item ? 'always' : (scope ?? 'chat');
    if (!SCOPES.has(chosen)) throw failure('BROWSER_INVALID_POLICY', 'Choose chat or always for this site approval.');
    if (!sameChat(pending.actor, actor)) throw failure('BROWSER_ACCOUNT_CONSENT_REQUIRED', 'This website request belongs to a different chat.');
    const threadId = pending.actor?.threadId ?? actor.threadId;
    const origins = [pending.origin, ...(pending.origins ?? []).filter((key) => !sameSite(key, pending.origin))];
    for (const [index, origin] of origins.entries()) {
      await policy.grantSiteAccess({ actor, threadId, origin, scope: chosen, unblock: index === 0 ? blocked : [], label: siteName(origin) });
    }
    if (pending.item?.accountId) {
      if (ownedBrowser.usesNativeVault?.()) await ownedBrowser.setNativeLoginBlocked(pending.item.accountId, false);
      else await broker.setLoginBlocked({ actor, accountId: pending.item.accountId, blocked: false });
    }
    if (pending.item?.secretId) await userSecrets.setBlocked(pending.item.secretId, false);
    // 승인을 모두 쓴 뒤에 카드를 닫는다. 도중에 실패하면 같은 카드로 다시 승인할 수 있다.
    await broker.settleRequest({ actor, requestId: pending.requestId });
    const continuation = browserContinuationText(pending, { status: 'granted' }, { scope: chosen });
    settle(pending.requestId, { status: 'granted' }, continuation);
    // 같은 사이트를 기다리던 다른 카드도 이 승인으로 끝난다.
    for (const sibling of await broker.pendingSiteRequests(pending.actor, pending.origin)) {
      await broker.settleRequest({ actor, requestId: sibling.requestId }).catch(() => {});
      settle(sibling.requestId, { status: 'granted' }, browserContinuationText(sibling, { status: 'granted' }, { scope: chosen }));
    }
    const scopeInfo = siteScope(pending.origin);
    return { approved: true, scope: chosen, origins: [scopeInfo.key], domain: scopeInfo.domain, site: scopeInfo.domain ?? new URL(scopeInfo.key).host, ...(blocked.length ? { unblocked: blocked } : {}) };
  }

  /** accounts.complete: 사용자가 그 탭에서 직접 마쳤다. 로그인 표시와 이 채팅의 사이트 사용을 남기고 탭을 돌려준다. */
  async function completeHandoff(actor, { requestId } = {}) {
    const done = await broker.completeHandoff({ actor, requestId: String(requestId ?? '') });
    const request = done.request;
    await policy.markSignedIn({ profileId: ownedBrowser.profileId(), origin: request.origin, source: 'handoff' });
    if (request.actor?.threadId) await policy.grantSiteAccess({ actor, threadId: request.actor.threadId, origin: request.origin, scope: 'chat' });
    await ownedBrowser.refreshSites?.().catch(() => {});
    if (request.tabId) await ownedBrowser.returnControl({ tabId: request.tabId }).catch(() => {});
    settle(request.requestId, { status: 'granted' }, browserContinuationText(request, { status: 'granted' }));
    return { completed: true, origin: request.origin, site: done.site };
  }

  /** 저장 카드: 활성 런타임의 저장소(네이티브면 보관함)에 넣고, 범위를 주면 그 사이트를 그 범위로 허용한다. */
  async function saveLogin(actor, { requestId, account = {}, username, password, scope } = {}) {
    const pending = await broker.getAccountRequest(String(requestId ?? ''));
    if (!pending || pending.kind !== 'browser-save-account') throw failure('BROWSER_ACCOUNT_REQUEST_EXPIRED', 'The website account request expired. Request it again.');
    const chosen = SCOPES.has(scope) ? scope : null;
    let saved;
    if (ownedBrowser.usesNativeVault?.()) {
      if (account.origin && !sameSite(account.origin, pending.origin)) throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'The account belongs to a different website. Request it again.');
      if (typeof username !== 'string' || typeof password !== 'string' || !password) throw failure('BROWSER_ACCOUNT_INVALID', 'Enter a valid username and password.');
      saved = await ownedBrowser.saveNativeLogin({ origin: account.origin ? browserOrigin(account.origin) : pending.origin, username, password });
      await broker.settleRequest({ actor, requestId: pending.requestId, kinds: ['browser-save-account'] });
    } else saved = (await broker.saveLogin({ actor, requestId: pending.requestId, account, username, password })).account;
    if (chosen) await policy.grantSiteAccess({ actor, threadId: pending.actor?.threadId ?? actor.threadId, origin: pending.origin, scope: chosen });
    await ownedBrowser.refreshSites?.().catch(() => {});
    const safe = saved ? { id: saved.id, label: saved.label, origin: saved.origin, site: siteName(saved.origin), agentBlocked: saved.agentBlocked === true } : null;
    settle(pending.requestId, { status: 'granted' }, browserContinuationText(pending, { status: 'granted' }, { scope: chosen, account: safe }));
    return { account: safe, scope: chosen };
  }

  /** 저장 카드의 'Google 등으로 로그인함': 비밀번호 없이 이 브라우저 세션이 로그인됐다. 로그인 표시와 사이트 사용만 남긴다. */
  async function confirmFederatedSignIn(actor, { requestId, scope } = {}) {
    const pending = await broker.getAccountRequest(String(requestId ?? ''));
    if (!pending || pending.kind !== 'browser-save-account') throw failure('BROWSER_ACCOUNT_REQUEST_EXPIRED', 'The website account request expired. Request it again.');
    if (!sameChat(pending.actor, actor)) throw failure('BROWSER_ACCOUNT_CONSENT_REQUIRED', 'This website request belongs to a different chat.');
    const chosen = SCOPES.has(scope) ? scope : 'chat';
    await policy.markSignedIn({ profileId: ownedBrowser.profileId(), origin: pending.origin, source: 'federated' });
    await policy.grantSiteAccess({ actor, threadId: pending.actor?.threadId ?? actor.threadId, origin: pending.origin, scope: chosen });
    await broker.settleRequest({ actor, requestId: pending.requestId, kinds: ['browser-save-account'] });
    await ownedBrowser.refreshSites?.().catch(() => {});
    settle(pending.requestId, { status: 'granted' }, browserContinuationText(pending, { status: 'granted' }, { scope: chosen, federated: true }));
    return { signedIn: true, origin: pending.origin, scope: chosen };
  }

  /**
   * request_secret. 쓸 수 있는 값이 있고 그 사이트를 이미 쓸 수 있으면 granted, 값이 있지만 사이트 사용이 없거나 꺼져 있으면
   * 비밀 줄이 있는 사이트 카드, 값이 없으면 null 을 돌려준다(서버가 저장 카드를 연다).
   */
  async function secretRequest(actor, { existing } = {}) {
    if (!existing || existing.valueMissing) return null;
    const usable = !existing.blocked && (await Promise.all(existing.origins.map((origin) => policy.check({ actor, action: 'account-use', url: origin })))).every((decision) => decision.allowed);
    if (usable) return { status: 'granted', secretId: existing.id, label: existing.label, origins: existing.origins };
    const origin = existing.origins[0];
    const items = await siteItems(origin, actor);
    const secret = { id: existing.id, label: existing.label, kind: existing.kind, origins: existing.origins, blocked: existing.blocked === true };
    const request = await openCard(actor, { kind: 'site', origin, origins: existing.origins, label: existing.label, logins: items.logins,
      secrets: [secret, ...items.secrets.filter((entry) => entry.id !== existing.id)], blocked: [], item: existing.blocked ? { secretId: existing.id } : null });
    return { pending: true, requestId: request.requestId, kind: 'site', secretId: existing.id };
  }

  /** 비밀 저장 카드가 끝났다. 비밀의 사이트마다 같은 범위로 사이트 사용을 남긴다. */
  async function secretSaved(actor, { request, secret, scope }) {
    const threadId = request.threadId ?? actor.threadId;
    const seen = [];
    for (const origin of secret.origins) {
      if (seen.some((value) => sameSite(value, origin))) continue;
      seen.push(origin);
      await policy.grantSiteAccess({ actor, threadId, origin, scope, label: siteName(origin) });
    }
    return browserContinuationText(request, { status: 'granted' }, { scope, label: secret.label, secretId: secret.id });
  }

  /** browser_status 의 비밀: 값 없이, 지금 이 채팅이 쓸 수 있는지(usable)를 함께 준다. */
  async function statusSecrets(actor) {
    const secrets = await userSecrets.agentList(actor.threadId).catch(() => []);
    return Promise.all(secrets.map(async (secret) => ({ ...secret,
      usable: !secret.blocked && (await Promise.all(secret.origins.map((origin) => policy.check({ actor, action: 'account-use', url: origin })))).some((decision) => decision.allowed) })));
  }

  return { siteItems, requestSiteAccess, approveSite, completeHandoff, confirmFederatedSignIn, saveLogin, secretRequest, secretSaved, statusSecrets };
}

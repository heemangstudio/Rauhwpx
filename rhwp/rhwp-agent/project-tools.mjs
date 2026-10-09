/**
 * 연구 프로젝트 MCP 도구를 허브에서 바로 실행한다 (reference-tools.mjs 와 같은 자리).
 * 세션은 채팅 시작 때 묶인 프로젝트 하나만 다룬다.
 */

export const PROJECT_TOOL_NAMES = Object.freeze(['project_read', 'project_edit', 'project_import', 'find_home_files']);
const PROJECT_TOOLS = new Set(PROJECT_TOOL_NAMES);
const DEFAULT_ITEM_LIMIT = 50;
const MAX_LINKS = 500;

function projectToolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function itemRow(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    column: item.column,
    ...(item.tags.length > 0 ? { tags: item.tags } : {}),
    ...(item.pinned ? { pinned: true } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.kind === 'file'
      ? {
        fileKind: item.fileKind,
        chunkCount: item.chunkCount,
        ...(item.pageCount ? { pageCount: item.pageCount } : {}),
        ...(item.status !== 'ready' ? { status: item.status } : {}),
        ...(item.librarian?.status && item.librarian.status !== 'done' && item.librarian.status !== 'skipped'
          ? { librarian: item.librarian.status }
          : {}),
      }
      : {}),
    ...(item.trashedAt ? { trashedAt: item.trashedAt } : {}),
  };
}

function matchesQuery(item, query) {
  if (!query) return true;
  const needle = query.normalize('NFKC').toLocaleLowerCase('ko-KR');
  return [item.title, item.summary, item.originalName]
    .some((value) => typeof value === 'string' && value.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(needle));
}

async function readProject({ args, projectId, projectStore }) {
  const view = args.view;
  if (view === 'summary') {
    const project = await projectStore.get(projectId);
    const recent = await projectStore.listActivity(projectId, { limit: 5 });
    const trashed = (await projectStore.get(projectId, { trash: true })).items.filter((item) => item.trashedAt).length;
    return {
      id: project.id,
      name: project.name,
      goal: project.goal,
      revision: project.revision,
      columns: project.columns.map((column) => ({
        ...column,
        count: project.items.filter((item) => item.column === column.id).length,
      })),
      tags: project.tags.map((tag) => tag.name),
      documents: project.members.map((member) => ({ id: member.nodeId, name: member.name })),
      counts: {
        files: project.items.filter((item) => item.kind === 'file').length,
        notes: project.items.filter((item) => item.kind === 'note').length,
        links: project.links.length,
        trash: trashed,
      },
      pinned: project.items.filter((item) => item.pinned).map((item) => ({ id: item.id, title: item.title })),
      librarian: project.librarian,
      recent: recent.map((entry) => ({ id: entry.id, at: entry.at, actor: entry.actor?.kind, summary: entry.summary })),
    };
  }
  if (view === 'items') {
    const project = await projectStore.get(projectId, { trash: args.trash === true });
    const filtered = project.items.filter((item) => (args.trash === true ? Boolean(item.trashedAt) : true)
      && (!args.column || item.column === args.column)
      && (!args.tag || item.tags.includes(args.tag))
      && (!args.kind || item.kind === args.kind)
      && matchesQuery(item, args.query));
    const offset = args.offset ?? 0;
    const limit = args.limit ?? DEFAULT_ITEM_LIMIT;
    return {
      revision: project.revision,
      total: filtered.length,
      offset,
      items: filtered.slice(offset, offset + limit).map(itemRow),
    };
  }
  if (view === 'item' || view === 'note') {
    if (typeof args.id !== 'string' || !args.id) throw projectToolError('INVALID_ARGS', `view ${view} requires id`);
    const item = await projectStore.getItem(projectId, args.id);
    if (view === 'note') {
      if (item.kind !== 'note') throw projectToolError('INVALID_ARGS', `${item.id} is a ${item.kind}, not a note`);
      return projectStore.readNote(projectId, item.id);
    }
    const project = await projectStore.get(projectId, { trash: true });
    const { locked: _locked, ...rest } = item;
    return {
      ...rest,
      links: project.links.filter((link) => link.from === item.id || link.to === item.id),
    };
  }
  if (view === 'links') {
    const project = await projectStore.get(projectId);
    const links = args.id
      ? project.links.filter((link) => link.from === args.id || link.to === args.id)
      : project.links;
    return { revision: project.revision, total: links.length, links: links.slice(0, MAX_LINKS) };
  }
  if (view === 'activity') {
    const entries = await projectStore.listActivity(projectId, { limit: args.limit ?? 20 });
    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        at: entry.at,
        actor: entry.actor,
        summary: entry.summary,
        ...(entry.undoOf ? { undoOf: entry.undoOf } : {}),
      })),
    };
  }
  throw projectToolError('INVALID_ARGS', `Unknown project_read view ${String(view)}`);
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/**
 * @param {{
 *   tool: string, args: any, session: any, projectStore: any,
 *   ingest?: any, homeSearch?: any, allowedRoots?: string[], sessionKey?: string,
 * }} input
 * @returns {Promise<{handled: boolean, result: any}>}
 */
export async function executeProjectTool({
  tool,
  args,
  session,
  projectStore,
  ingest = null,
  homeSearch = null,
  allowedRoots = [],
  sessionKey = null,
}) {
  if (!PROJECT_TOOLS.has(tool)) return { handled: false, result: null };
  const projectId = session?.projectId;
  if (!projectId || !projectStore) throw projectToolError('PROJECT_NOT_BOUND', 'This chat has no research project yet');
  const actor = {
    kind: 'agent',
    ...(typeof session.threadId === 'string' ? { threadId: session.threadId } : {}),
    ...(typeof session.agent === 'string' ? { agent: session.agent } : {}),
  };
  if (tool === 'project_read') {
    return { handled: true, result: await readProject({ args, projectId, projectStore }) };
  }
  if (tool === 'project_edit') {
    return {
      handled: true,
      result: await projectStore.applyOps(projectId, {
        ops: args.ops.map(stripUndefined),
        actor,
        expectedRevision: args.expectedRevision,
      }),
    };
  }
  if (tool === 'find_home_files') {
    if (!homeSearch?.available) throw projectToolError('HOME_SEARCH_DISABLED', 'Home folder search is off or unavailable');
    return {
      handled: true,
      result: await homeSearch.find({ query: args.query, types: args.types, limit: args.limit, sessionKey }),
    };
  }
  if (!ingest) throw projectToolError('PROJECT_INGEST_UNAVAILABLE', 'Project import is unavailable');
  const common = stripUndefined({ projectId, name: args.name, column: args.column, tags: args.tags, actor });
  let imported;
  if (args.text !== undefined) imported = await ingest.importText({ ...common, text: args.text, url: args.url });
  else if (args.path !== undefined) imported = await ingest.importPath({ ...common, path: args.path, allowedRoots });
  else if (args.homeHit !== undefined) {
    if (!homeSearch?.available) throw projectToolError('HOME_SEARCH_DISABLED', 'Home folder import is off or unavailable');
    imported = await ingest.importHomeHit({ ...common, hitId: args.homeHit, sessionKey });
  } else imported = await ingest.importUrl({ ...common, url: args.url });
  const item = imported?.item;
  return { handled: true, result: { item: item ? itemRow(item) : null } };
}

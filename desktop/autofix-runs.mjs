import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 자동 수정 실행 기록. 실행마다 <userData>/autofix-runs/<id>/ 에 맥락·프롬프트·진단 기록·에이전트 출력·
// 백업을 남긴다. 다음 실행은 앞선 실행이 무엇을 바꿨고 그 뒤 오류가 다시 났는지를 맥락으로 받는다.

export const AUTOFIX_RUNS_DIR = 'autofix-runs';
/** 남겨 두는 실행 수. 새 실행을 만들기 전에 오래된 것부터 지운다(백업도 함께 지워진다). */
export const AUTOFIX_RUNS_KEPT = 10;
export const AUTOFIX_RUN_RECORD = 'run.json';
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;

/** 시각 순서로 정렬되는 실행 이름: 2026-10-28T03-12-45-120Z-1a2b3c4d */
export function autofixRunId(date, random = randomUUID) {
  return `${date.toISOString().replace(/[:.]/g, '-')}-${random().replace(/-/g, '').slice(0, 8)}`;
}

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 앞선 실행 기록을 맥락에 실을 만큼만 남긴다. 에이전트가 쓴 글이므로 길이를 자른다. */
export function summarizeAutofixRun(record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string') return null;
  const answer = record.answer && typeof record.answer === 'object' ? record.answer : {};
  return {
    id: record.id,
    surface: clip(record.surface, 80),
    title: clip(record.title, 200),
    status: clip(record.status, 20) || 'unknown',
    verified: clip(record.verified, 20) || null,
    provider: clip(record.provider, 20),
    model: clip(record.model, 80),
    cause: clip(answer.cause, 600),
    category: clip(answer.category, 40),
    touched: Array.isArray(answer.touched)
      ? answer.touched.filter((item) => typeof item === 'string' && item.trim()).slice(0, 10).map((item) => clip(item, 200))
      : [],
  };
}

/**
 * root 에 실행 폴더를 만든다. root 에 쓸 수 없으면(사용자 데이터 폴더의 권한·디스크 문제도 고칠 대상이다)
 * fallbackRoot 를 쓴다. 기록 쓰기는 실행마다 차례로 한다.
 */
export function createAutofixRunStore({ root, fallbackRoot = null, keep = AUTOFIX_RUNS_KEPT, now = () => new Date(), random = randomUUID }) {
  const chains = new Map();

  async function runIds(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name)).map((entry) => entry.name).sort();
    } catch {
      return [];
    }
  }

  async function prune(dir) {
    const ids = await runIds(dir);
    for (const id of ids.slice(0, Math.max(0, ids.length - (keep - 1)))) {
      await rm(path.join(dir, id), { recursive: true, force: true }).catch(() => {});
    }
  }

  async function readRecord(dir) {
    try {
      return JSON.parse(await readFile(path.join(dir, AUTOFIX_RUN_RECORD), 'utf8'));
    } catch {
      return null;
    }
  }

  function serial(run, task) {
    const next = (chains.get(run.dir) ?? Promise.resolve()).then(task);
    chains.set(run.dir, next.catch(() => {}));
    return next;
  }

  return {
    root,
    /** @returns {Promise<{ id: string, dir: string, backupDir: string }>} */
    async create() {
      const id = autofixRunId(now(), random);
      let lastError = null;
      for (const base of [root, fallbackRoot].filter(Boolean)) {
        try {
          await prune(base);
          const dir = path.join(base, id);
          const backupDir = path.join(dir, 'backup');
          await mkdir(backupDir, { recursive: true });
          return { id, dir, backupDir };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error('no autofix run folder');
    },
    write(run, name, text) {
      return serial(run, () => writeFile(path.join(run.dir, name), text, 'utf8'));
    },
    /** run.json 에 patch 를 덧쓴다. */
    record(run, patch) {
      return serial(run, async () => {
        const next = { ...(await readRecord(run.dir) ?? {}), ...patch, id: run.id };
        await writeFile(path.join(run.dir, AUTOFIX_RUN_RECORD), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        return next;
      });
    },
    /** 최근 실행부터 limit 개. exclude 는 지금 실행. */
    async previous({ limit, exclude = null } = {}) {
      const out = [];
      for (const id of (await runIds(root)).reverse()) {
        if (out.length >= limit) break;
        if (id === exclude) continue;
        const summary = summarizeAutofixRun(await readRecord(path.join(root, id)));
        if (summary) out.push(summary);
      }
      return out;
    },
  };
}

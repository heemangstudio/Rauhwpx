#!/usr/bin/env node
// Every release must ship notes the home release card can show on first launch.
// Fails unless RELEASE_NOTES in rhwp-studio has at least MIN_RELEASE_NOTES
// non-empty entries for the package.json version (or the version given as an argument).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const NOTES_FILE = 'rhwp/rhwp-studio/src/ui/update-hippo/release-notes.ts';

export const MIN_RELEASE_NOTES = 1;

/** A version's notes: `{ added?: string[], fixed?: string[] }`. Returns every entry, or null when malformed. */
function entries(note) {
  if (!note || typeof note !== 'object' || Array.isArray(note)) return null;
  const lists = [note.added ?? [], note.fixed ?? []];
  return lists.every(Array.isArray) ? lists.flat() : null;
}

/** Returns the problem with the notes for `version`, or null when they are releasable. */
export function releaseNotesProblem(version, notes, min = MIN_RELEASE_NOTES) {
  const items = entries(notes[version]);
  if (!items) {
    return `No release notes for ${version}. Add a '${version}' entry with added/fixed lists to RELEASE_NOTES in ${NOTES_FILE}.`;
  }
  const blank = items.filter((item) => typeof item !== 'string' || !item.trim()).length;
  if (blank) return `Release notes for ${version} have ${blank} empty entr${blank === 1 ? 'y' : 'ies'} in ${NOTES_FILE}.`;
  if (items.length < min) {
    return `Release notes for ${version} have ${items.length} entr${items.length === 1 ? 'y' : 'ies'}; at least ${min} are required in ${NOTES_FILE}.`;
  }
  return null;
}

async function main() {
  const version = process.argv[2]
    ?? JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const { RELEASE_NOTES } = await import(pathToFileURL(path.join(ROOT, NOTES_FILE)).href);
  const problem = releaseNotesProblem(version, RELEASE_NOTES);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Release notes for ${version}: ${entries(RELEASE_NOTES[version]).length} entries.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

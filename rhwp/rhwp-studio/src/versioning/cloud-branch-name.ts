import { hashBytes } from './hash.ts';
import { branchName, type BranchName } from './types.ts';

const ADJECTIVES = [
  'pixel', 'amber', 'velvet', 'cosmic', 'misty', 'lunar', 'solar', 'frosty',
  'ember', 'coral', 'mossy', 'silver', 'golden', 'crystal', 'shadow', 'thunder',
  'starry', 'rusty', 'dusky', 'sunny', 'stormy', 'glassy', 'minty', 'ashen',
  'copper', 'jade', 'ivory', 'cobalt', 'scarlet', 'violet', 'azure', 'cinder',
  'breezy', 'drifty', 'gentle', 'hidden', 'nimble', 'quiet', 'swift', 'tiny',
  'wild', 'brave', 'clever', 'dreamy', 'fuzzy', 'lucky', 'mellow', 'sleepy',
  'spark', 'echo', 'maple', 'willow', 'pebble', 'comet', 'nova', 'aurora',
  'meadow', 'harbor', 'canyon', 'glacier', 'orchid', 'tulip', 'clover', 'sable',
] as const;

const CREATURES = [
  'canary', 'griffin', 'phoenix', 'kraken', 'wyvern', 'kirin', 'basilisk', 'sphinx',
  'pegasus', 'unicorn', 'hydra', 'chimera', 'dragon', 'selkie', 'kitsune', 'tanuki',
  'otter', 'lynx', 'heron', 'falcon', 'raven', 'badger', 'marten', 'ferret',
  'puffin', 'narwhal', 'axolotl', 'pangolin', 'quokka', 'ibis', 'kestrel', 'magpie',
  'wren', 'finch', 'stoat', 'hare', 'fox', 'owl', 'moth', 'newt',
  'gecko', 'koi', 'manta', 'orca', 'seal', 'yak', 'lemur', 'tapir',
  'roc', 'thunderbird', 'jackalope', 'wolpertinger', 'hippogriff', 'manticore', 'leviathan', 'cockatrice',
  'salamander', 'dryad', 'sprite', 'golem', 'bunyip', 'haetae', 'bulgasari', 'imugi',
] as const;

/** Attempts before falling back to the collision-free legacy hash name. */
const FRIENDLY_ATTEMPTS = 8;

function digest(value: string): string {
  return hashBytes(new TextEncoder().encode(value)).slice('blake3:'.length);
}

/**
 * Stable branch names for one Cloud start, most readable first
 * (`Cloud pixel-canary`). Later names only take over when an earlier one
 * already belongs to another Cloud start in the same repository.
 */
export function cloudBranchNameCandidates(startId: string): BranchName[] {
  const names: BranchName[] = [];
  for (let attempt = 0; attempt < FRIENDLY_ATTEMPTS; attempt += 1) {
    const hex = digest(attempt === 0 ? startId : `${startId}#${attempt}`);
    const adjective = ADJECTIVES[Number.parseInt(hex.slice(0, 4), 16) % ADJECTIVES.length];
    const creature = CREATURES[Number.parseInt(hex.slice(4, 8), 16) % CREATURES.length];
    const name = branchName(`Cloud ${adjective}-${creature}`);
    if (!names.includes(name)) names.push(name);
  }
  names.push(legacyCloudBranchName(startId));
  return names;
}

/** Name used before friendly names; still resolved so older Cloud starts keep merging. */
export function legacyCloudBranchName(startId: string): BranchName {
  return branchName(`Cloud ${digest(startId).slice(0, 16)}`);
}

export function isLegacyCloudBranchName(name: string): boolean {
  return /^Cloud [0-9a-f]{16}$/.test(name);
}

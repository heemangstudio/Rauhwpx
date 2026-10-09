import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only inputs that change rhwp/pkg. Tests, samples, docs, tools and the apps that
// consume the engine do not, so editing them reuses the cached WASM package.
export const WASM_INPUTS = [
  'rhwp/src',
  'rhwp/Cargo.toml',
  'rhwp/Cargo.lock',
  'rhwp/rust-toolchain.toml',
  'rhwp/build.rs',
  'rhwp/.cargo',
  // The engine embeds this file as its blank-document template.
  'rhwp/saved/blank2010.hwp',
  // Pins wasm-opt (build-wasm.mjs) and wasm-pack (setup-rust).
  'scripts/build-wasm.mjs',
  '.github/actions/setup-rust/action.yml',
];

export function wasmSourceFingerprint(cwd = process.cwd()) {
  // Git object ids of each input at HEAD; missing paths are simply absent.
  const tree = execFileSync('git', ['ls-tree', '--full-tree', 'HEAD', '--', ...WASM_INPUTS], { cwd, encoding: 'utf8' });
  return createHash('sha256').update(tree).digest('hex');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(wasmSourceFingerprint());

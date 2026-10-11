import { setFlagsFromString } from 'node:v8';

// 테스트는 짧게 돌고 끝나므로 V8 의 최적화 WASM 재컴파일(TurboFan)이 CPU 만 먹는다.
// 기준 컴파일러(Liftoff)만 쓰게 해 엔진·CanvasKit WASM 을 쓰는 파일의 CPU 시간을 줄인다.
// WASM 모듈을 컴파일하기 전에 import 해야 한다.
setFlagsFromString('--liftoff-only --no-wasm-tier-up --no-wasm-dynamic-tiering');

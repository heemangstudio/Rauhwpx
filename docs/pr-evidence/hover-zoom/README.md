Hover and zoom verification used a generated table in the running Studio editor with the real WASM engine. The before capture serves the two input-handler modules from base commit `f994e6f6`; the after capture serves this change. Each recording starts with a table-boundary hover, changes document zoom from 100% to 80% with a stationary pointer, then uses Ctrl+wheel. The before marker keeps its previous width and position. The after marker is cleared and hit-tested against the current layout.

[Before screenshot](before.png) · [After screenshot](after.png) · [Before recording](before.webm) · [After recording](after.webm)

The recordings ran on local Vite URLs `http://127.0.0.1:57445` and `http://127.0.0.1:57576`. The normal Studio runtime was also started at `http://127.0.0.1:7700`; toolbar interaction in the collaborative preview timed out, so visual capture used headless Chrome through the repository's Vite/real-engine workflow.

The permanent regression flow is `npm --prefix rhwp/rhwp-studio run e2e:smoke -- 09-hover-zoom`. It checks row and column markers against engine cell bounds during direct zoom and Ctrl+wheel animation, stationary-pointer restoration, leaving with a queued hover, hyperlink/protected-cell transitions, and connector preview projection. Its generated documents and link URI are local test fixtures; no provider call is needed.

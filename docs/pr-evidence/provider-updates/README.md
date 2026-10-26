# Unified update verification

Captured in development Electron at `http://127.0.0.1:7700`, using an isolated user-data profile, `RHWP_FAKE_UPDATE=3.0.8` and `RHWP_FAKE_PROVIDER_UPDATES=partial-failure`. Downloads and provider installations are simulated; the Electron coordinator, IPC, hippo rendering, animation and restart handoff are production code.

- [Available updates](available.png): app, Claude and Codex share one action. The original hippo artwork is unchanged.
- [During updates](updating.png): the app download continues after the simulated Claude failure, Codex finishes, and the full banner remains visible.

The live UI check clicked Update all, observed the hippo's downward transition and return with progress, checked the banner bounds, and verified the separate final provider results. Additional live fixture runs exercised provider-only updates without a restart, retry after partial failure, Later, rejected restart preparation, and a full Electron relaunch recovering the persisted results. No real provider CLI was updated.

Repeat the fixtures using the instructions in [releasing.md](../../releasing.md#installing-desktop-updates).

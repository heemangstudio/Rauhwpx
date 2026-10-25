# Missing-picture UI assignment

Headless Chrome at `http://127.0.0.1:7723/?engine=heemang`, 2026-10-25. Studio `a69d316b` used engine `e2c92f9`, WASM 6,322,393 bytes, SHA256 `7aabb6e7462f49df01d85fa78bc098501b66a39cdbca19cf4c2d5901d318e4bc`. The local hub used provider fixtures with no provider calls. Document operations, mouse events, file chooser, image decoding, history and reopening used the actual editor.

The harness generates an unassigned picture frame from the real mixed-text fixture by setting its image reference to `0` and removing the image manifest item and binary. It retains the existing frame, description and surrounding text. That HWPX is exported to HWP, and each input runs the same checks:

- Mouse selection reports a missing image, and double-click opens the real file chooser. Cancellation leaves document bytes and undo/redo availability unchanged.
- Selecting an invalid PNG displays the rejection toast and leaves document bytes and history unchanged.
- Selecting the generated 32×24 PNG assigns its exact 556 bytes. The 18,000×9,000 HU frame, position, z-order, identity, description and picture margins remain unchanged. Crop bounds use the replacement's full natural dimensions.
- One undo restores the unassigned image and original crop; redo restores the replacement. Both HWP and HWPX exports reopen in Studio with identical replacement bytes and the same frame. All four reopened outputs passed; no page errors or legacy-engine requests occurred.

`summary.json` records the two runs. Screenshots show the unassigned frame, invalid-file rejection and assigned image. `old-assignment.json` confirms that the baseline WASM also assigns and saves/reopens these same fixtures in both formats. Reproduce with the intended combined vendor package installed:

```sh
HV_CANDIDATE_VITE_PORT=7723 node rhwp/rhwp-studio/e2e/heemang-verify/missing-picture.mjs
```

A separate damaged-reference probe retained the original nonzero image reference and manifest entry while removing only the binary. After converting that file to HWP and assigning a replacement, native HWP save failed with `missing embedded bytes for BinData/BIN0001.png`; `broken-reference-native.json` records the fresh-Doc reproduction without history. Baseline WASM also failed to export that damaged HWP after assignment, reporting an unregistered `binaryItemIDRef`. The successful UI acceptance above uses the standard zero-ID unassigned frame; damaged-source save robustness remains a separate finding.

No production code changed. Original vendor files were restored and both test servers stopped.

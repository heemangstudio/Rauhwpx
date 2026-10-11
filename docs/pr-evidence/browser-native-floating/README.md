# Native floating browser and drag recovery

The floating toolbar previously lived in the editor DOM while website content lived in Electron native views. A sidebar guest could cover the floating toolbar and intercept its drag handle. Geometry projections could also reapply an old position during a drag.

The floating toolbar now lives in a frameless child BrowserWindow with the existing website WebContentsView. Native window dragging owns the position and size; later DOM projections cannot overwrite it. Geometry events update the saved preview rectangle locally without querying the hub. Moving the preview no longer clamps it against the editor rectangle. Closing releases the lightweight chrome renderer while preserving the website guest.

Verified in the running Rauhwpx-pr475 Electron build at http://127.0.0.1:7745/, CDP 9475, with adsf.hwpx. Opened Muxy in a separate floating view while RiroSchool stayed docked in the sidebar. WindowServer reported the floating child above the editor; its toolbar and website visibly covered the sidebar guest. Dragged down and right from (469,295) to (569,375), sent an old (469,295) attach request, and confirmed it stayed at (569,375). A second native drag returned it to (469,295), matching the saved DOM rectangle. The native website target stayed unchanged. Zoom 75% -> 85% -> 75% and capture into chat succeeded without docking or moving the window. Removed the verification capture afterward. School content and credentials were not saved as visual evidence.

Focused checks: desktop-owned-browser suite (3 passing); native presentation fixture after close-button changes (passing); Studio tsc --noEmit (passing). The fixture verifies viewport resizing, retained form and localStorage state, native keyboard focus, stale geometry rejection, chrome destruction and close notification, dock/popout transitions, and hub reconnection.

Final live close check after reloading the main-process change: clicked the native floating toolbar's close button. The child chrome was destroyed, the same website target remained, and the app returned it to dock mode without reopening a floating window.

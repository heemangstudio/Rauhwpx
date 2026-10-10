const { app, WebContentsView, session } = require("electron");
const { createServer } = require("node:http");
const { execFileSync } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = mkdtempSync(path.join(os.tmpdir(), "rauhwpx-seed-probe-"));
app.setPath("userData", root);
app.on("window-all-closed", () => {});
const mode = process.env.RHWP_PROBE_MODE || "baseline";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const views = [];
let server;
let seed;
app.whenReady().then(async () => {
  try {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, {
          location: `http://localhost:${server.address().port}/redirected`,
        });
        res.end();
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        "<!doctype html><title>Native memory fixture</title><input id=draft><script>window.framesDrawn=0;window.timerTicks=0;function frame(){framesDrawn++;requestAnimationFrame(frame)}requestAnimationFrame(frame);setInterval(()=>timerTicks++,10)</script>",
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const shared = session.fromPartition("probe");
    const prefs = {
      session: shared,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    };
    if (mode === "seed") {
      seed = new WebContentsView({ webPreferences: prefs });
      seed.setVisible(false);
      await seed.webContents.loadURL("about:blank");
    }
    const start = performance.now();
    for (let i = 0; i < 8; i++) {
      const view =
        mode === "seed"
          ? new WebContentsView({ webContents: seed.webContents.clone() })
          : new WebContentsView({ webPreferences: prefs });
      view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
      view.setVisible(false);
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      views.push(view);
      await view.webContents.loadURL("about:blank");
      view.webContents.navigationHistory.clear();
      await view.webContents.loadURL(origin + "/" + i);
      await view.webContents.executeJavaScript(
        `document.querySelector('#draft').value='draft-${i}';window.name='tab-${i}';sessionStorage.setItem('private', 'secret-${i}')`,
      );
    }
    const loadMs = performance.now() - start;
    const snap = async (label) => {
      const tabs = await Promise.all(
        views.map((v) =>
          v.webContents.executeJavaScript(
            '({visibility:document.visibilityState,framesDrawn,timerTicks,draft:document.querySelector("#draft").value,history:history.length,name:window.name,opener:window.opener===null,storage:sessionStorage.getItem("private"),origin:location.origin})',
          ),
        ),
      );
      const rows = execFileSync("ps", ["-axo", "pid,ppid,rss,%cpu"], {
        encoding: "utf8",
      })
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .filter(
          (r) => Number(r[0]) === process.pid || Number(r[1]) === process.pid,
        );
      console.log(
        JSON.stringify({
          electron: process.versions.electron,
          mode,
          label,
          root,
          loadMs,
          pids: views.map((v) => v.webContents.getOSProcessId()),
          tabs,
          rssKiB: rows.reduce((s, r) => s + Number(r[2]), 0),
          processes: rows,
        }),
      );
    };
    await delay(1000);
    await snap("initial");
    await delay(3000);
    await snap("after-3s");
    const donor = views[0];
    await donor.webContents.executeJavaScript(`window.name='targeted';`);
    await views[1].webContents.executeJavaScript(
      `window.open('${origin}/unexpected','targeted')`,
    );
    await delay(300);
    console.log(
      JSON.stringify({
        label: "named-target-check",
        url: donor.webContents.getURL(),
        unchanged: donor.webContents.getURL() === origin + "/0",
      }),
    );
    const other = new WebContentsView({
      webContents: (seed ?? views[0]).webContents.clone(),
    });
    other.setVisible(false);
    views.push(other);
    await other.webContents.loadURL("about:blank");
    other.webContents.navigationHistory.clear();
    await other.webContents.loadURL(origin + "/fresh");
    console.log(
      JSON.stringify({
        label: "fresh-clone-state",
        value: await other.webContents.executeJavaScript(
          '({name:window.name,opener:window.opener===null,storage:sessionStorage.getItem("private"),history:history.length,typeofRequire:typeof require})',
        ),
        pids: views.map((v) => v.webContents.getOSProcessId()),
        prefs: other.webContents.getLastWebPreferences(),
      }),
    );
    await other.webContents.loadURL(origin + "/redirect");
    console.log(
      JSON.stringify({
        label: "cross-origin-redirect",
        donorPid: views[0].webContents.getOSProcessId(),
        pid: other.webContents.getOSProcessId(),
        url: other.webContents.getURL(),
        storage: await other.webContents.executeJavaScript(
          'sessionStorage.getItem("private")',
        ),
      }),
    );
    for (const v of views) v.webContents.close();
    seed?.webContents.close();
    server.close();
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
setTimeout(() => app.exit(2), 30000).unref();

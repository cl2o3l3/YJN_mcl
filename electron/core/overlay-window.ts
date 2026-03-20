/**
 * 游戏内覆盖层窗口
 * 透明、置顶、不可聚焦的小窗口，显示 peer 列表和 RTT
 */

import { BrowserWindow, ipcMain, screen } from 'electron'

let overlayWin: BrowserWindow | null = null

const OVERLAY_WIDTH = 260
const OVERLAY_HEIGHT = 200

export function createOverlayWindow(): BrowserWindow | null {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.show()
    return overlayWin
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenW } = primaryDisplay.workAreaSize

  overlayWin = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: screenW - OVERLAY_WIDTH - 16,
    y: 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  overlayWin.setIgnoreMouseEvents(true, { forward: true })

  overlayWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`)

  overlayWin.on('closed', () => { overlayWin = null })

  return overlayWin
}

export function destroyOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close()
  }
  overlayWin = null
}

export function updateOverlayPeers(peers: any[]) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    const safeJson = JSON.stringify(peers).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    overlayWin.webContents.executeJavaScript(`render(JSON.parse('${safeJson}'))`)
      .catch(() => { /* overlay may be closing */ })
  }
}

export function registerOverlayHandlers() {
  ipcMain.handle('overlay:show', () => {
    createOverlayWindow()
  })

  ipcMain.handle('overlay:hide', () => {
    destroyOverlayWindow()
  })

  ipcMain.handle('overlay:update', (_e, peers: any[]) => {
    updateOverlayPeers(peers)
  })
}

const OVERLAY_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', sans-serif;
    background: transparent;
    color: #fff;
    overflow: hidden;
  }
  .overlay {
    background: rgba(0, 0, 0, 0.6);
    border-radius: 10px;
    padding: 10px 12px;
    backdrop-filter: blur(6px);
  }
  .title {
    font-size: 11px;
    font-weight: 600;
    color: rgba(255,255,255,0.6);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .peer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 13px;
  }
  .peer-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    margin-right: 6px;
    flex-shrink: 0;
  }
  .dot-connected { background: #2ecc71; }
  .dot-connecting { background: #f39c12; }
  .dot-disconnected { background: #e74c3c; }
  .rtt {
    font-size: 11px;
    font-family: monospace;
    margin-left: 8px;
    flex-shrink: 0;
  }
  .rtt-good { color: #2ecc71; }
  .rtt-ok { color: #f39c12; }
  .rtt-bad { color: #e74c3c; }
  .rtt-unknown { color: rgba(255,255,255,0.4); }
  .empty { font-size: 12px; color: rgba(255,255,255,0.4); }
</style>
</head>
<body>
<div class="overlay">
  <div class="title">P2P 联机</div>
  <div id="peers" class="empty">无连接</div>
</div>
<script>
  var peersEl = document.getElementById('peers');
  function rttClass(rtt) {
    if (rtt <= 0) return 'rtt-unknown';
    if (rtt < 50) return 'rtt-good';
    if (rtt < 150) return 'rtt-ok';
    return 'rtt-bad';
  }
  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function render(peers) {
    if (!peers || peers.length === 0) {
      peersEl.innerHTML = '<div class="empty">无连接</div>';
      return;
    }
    peersEl.innerHTML = peers.map(function(p) {
      var dotCls = 'dot-' + (p.state || 'connecting');
      var rttText = p.rtt > 0 ? p.rtt + 'ms' : '...';
      var rCls = rttClass(p.rtt);
      return '<div class="peer">' +
        '<span class="dot ' + dotCls + '"></span>' +
        '<span class="peer-name">' + escHtml(p.name) + '</span>' +
        '<span class="rtt ' + rCls + '">' + rttText + '</span>' +
      '</div>';
    }).join('');
  }
</script>
</body>
</html>`

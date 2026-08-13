'use strict';

const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { remuxToMp4, probeFfmpeg } = require('./remux');

const BAR_WIDTH = 264;
const BAR_HEIGHT = 60;
const MARGIN = 24;

let win = null;

// ---------------------------------------------------------------------------
// Position memory
// ---------------------------------------------------------------------------

function boundsFile() {
  return path.join(app.getPath('userData'), 'bar-position.json');
}

function loadPosition() {
  try {
    const saved = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    const onSomeDisplay = screen.getAllDisplays().some((d) => {
      const { x, y, width, height } = d.workArea;
      return saved.x >= x - 40 && saved.y >= y - 40 &&
        saved.x <= x + width - 40 && saved.y <= y + height - 40;
    });
    if (onSomeDisplay) return saved;
  } catch { /* no saved position yet */ }

const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - BAR_WIDTH) / 2),
    y: workArea.y + workArea.height - BAR_HEIGHT - MARGIN
  };
}

function savePosition() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify({ x, y }));
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Screen source
// ---------------------------------------------------------------------------

function installCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      });

    if (!sources.length) return callback({});

    // Whole primary display. desktopCapturer reports display_id as a string.
    const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((s) => s.display_id === primaryId) || sources[0];

    // 'loopback' captures what the speakers are playing. Windows only.
    callback({ video: source, audio: 'loopback' });
    } catch (err) {
      console.error('Could not enumerate screens:', err);
      callback({});
    }
  }, { useSystemPicker: false });
}

// ---------------------------------------------------------------------------
// Recording sink — chunks stream straight to disk, never accumulate in memory
// ---------------------------------------------------------------------------

let sink = null; // { path, stream, bytes, mime }

/**
* A hard kill (Task Manager, power loss) leaves a temp take behind. Sweep
* anything older than a day on startup so %TEMP% does not silently fill with
* abandoned recordings.
*/
async function sweepTemp() {
  const dir = path.join(os.tmpdir(), 'tally');
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of await fs.promises.readdir(dir)) {
      const p = path.join(dir, name);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.promises.unlink(p).catch(() => {});
    }
  } catch { /* nothing to sweep */ }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n++})${ext}`);
  }
  return candidate;
}


  ipcMain.handle('recording:open', async (_e, { mime }) => {
    if (sink) throw new Error('A recording is already open.');

                 const dir = path.join(os.tmpdir(), 'tally');
    fs.mkdirSync(dir, { recursive: true });

                 const target = path.join(dir, `take-${Date.now()}.webm`);
    sink = {
      path: target,
      stream: fs.createWriteStream(target),
      bytes: 0,
      mime: mime || ''
    };
    return { path: target };
  });

// Chunks arrive via invoke rather than send: the promise round-trip gives us
// ordering and natural backpressure, which a fire-and-forget send does not.
ipcMain.handle('recording:chunk', async (_e, buffer) => {
  if (!sink) return { bytes: 0 };

               const data = Buffer.from(buffer);
  sink.bytes += data.length;

               if (!sink.stream.write(data)) {
                 await new Promise((resolve) => sink.stream.once('drain', resolve));
               }
  return { bytes: sink.bytes };
});

ipcMain.handle('recording:abort', async () => {
  if (!sink) return;
  const { stream, path: p } = sink;
  sink = null;
  await new Promise((resolve) => stream.end(resolve));
  fs.promises.unlink(p).catch(() => {});
});

ipcMain.handle('recording:close', async () => {
  if (!sink) throw new Error('No recording is open.');

               const { stream, path: temp, bytes, mime } = sink;
  sink = null;

               await new Promise((resolve, reject) => {
                 stream.on('error', reject);
                 stream.end(resolve);
               });

               if (bytes === 0) {
                 await fs.promises.unlink(temp).catch(() => {});
                 throw new Error('Recording was empty — nothing was captured.');
               }

               const downloads = app.getPath('downloads');
  const output = uniquePath(downloads, `Screen recording ${stamp()}`, '.mp4');

               // H.264 in WebM stream-copies into MP4. VP9 cannot, and has to be re-encoded
               // or the resulting file will not play on most Windows software.
               const canCopyVideo = /h264|avc1/i.test(mime);

               try {
                 await remuxToMp4(temp, output, {
                   copyVideo: canCopyVideo,
                   onProgress: (seconds) => {
                     if (win && !win.isDestroyed()) {
                       win.webContents.send('recording:progress', { seconds, reencoding: !canCopyVideo });
                     }
                   }
                 });
               } catch (err) {
                 // Never lose the take. Hand back the raw WebM rather than nothing.
  const rescue = uniquePath(downloads, `Screen recording ${stamp()}`, '.webm');
                 await fs.promises.copyFile(temp, rescue).catch(() => {});
                 await fs.promises.unlink(temp).catch(() => {});
                 throw new Error(`${err.message}\nSaved the raw recording to ${rescue} instead.`);
               }

               await fs.promises.unlink(temp).catch(() => {});
  return { path: output, reencoded: !canCopyVideo };
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createBar() {
  const { x, y } = loadPosition();

win = new BrowserWindow({
  x, y,
  width: BAR_WIDTH,
  height: BAR_HEIGHT,
  frame: false,
  transparent: true,
  resizable: false,
  maximizable: false,
  minimizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  hasShadow: false,
  backgroundColor: '#00000000',
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false
  }
});

// 'screen-saver' outranks fullscreen apps. The plain alwaysOnTop flag does not.
win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);

// Keeps the bar out of its own recording, and out of anyone else's.
win.setContentProtection(true);

win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

let saveTimer = null;
  win.on('move', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 400);
  });

win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------------------
// Misc IPC
// ---------------------------------------------------------------------------

ipcMain.handle('bar:close', () => {
  savePosition();
  app.quit();
});

ipcMain.handle('bar:reveal', (_e, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
  else shell.openPath(app.getPath('downloads'));
});

ipcMain.handle('ffmpeg:probe', () => probeFfmpeg());

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (process.platform !== 'win32') {
  console.error('Tally targets Windows only.');
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

app.whenReady().then(() => {
  installCaptureHandler();
  createBar();
  sweepTemp();
});

app.on('before-quit', () => {
  if (sink) { sink.stream.end(); sink = null; }
});

app.on('window-all-closed', () => app.quit());
}

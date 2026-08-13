'use strict';

const housing = document.getElementById('housing');
const timeEl = document.getElementById('time');
const labelEl = document.getElementById('label');
const primary = document.getElementById('primary');
const hold = document.getElementById('hold');
const dismiss = document.getElementById('dismiss');

const STATES = {
idle: { label: 'Ready', primaryTitle: 'Start recording', holdTitle: 'Pause', holdEnabled: false },
arming: { label: 'Starting', primaryTitle: 'Cancel', holdTitle: 'Pause', holdEnabled: false },
recording: { label: 'Recording', primaryTitle: 'Stop and save', holdTitle: 'Pause', holdEnabled: true },
held: { label: 'Paused', primaryTitle: 'Stop and save', holdTitle: 'Resume', holdEnabled: true },
saving: { label: 'Saving', primaryTitle: 'Saving', holdTitle: 'Pause', holdEnabled: false }
};

let state = 'idle';
let elapsedMs = 0; // accumulated across pauses
let segmentStart = 0; // performance.now() when the current run began
let ticker = null;

// --- counter ---------------------------------------------------------------

function format(ms) {
const total = Math.floor(ms / 1000);
const h = String(Math.floor(total / 3600)).padStart(2, '0');
const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
const s = String(total % 60).padStart(2, '0');
return `${h}:${m}:${s}`;
}

function paintTime() {
const running = state === 'recording' ? performance.now() - segmentStart : 0;
timeEl.textContent = format(elapsedMs + running);
}

function startTicker() {
stopTicker();
segmentStart = performance.now();
ticker = setInterval(paintTime, 250);
paintTime();
}

function stopTicker() {
if (ticker) { clearInterval(ticker); ticker = null; }
}

// --- state -----------------------------------------------------------------

function setState(next) {
state = next;
const cfg = STATES[next];

housing.dataset.state = next;
labelEl.textContent = cfg.label;

primary.title = cfg.primaryTitle;
primary.querySelector('.sr').textContent = cfg.primaryTitle;
primary.disabled = next === 'saving';

hold.title = cfg.holdTitle;
hold.querySelector('.sr').textContent = cfg.holdTitle;
hold.disabled = !cfg.holdEnabled;
}

function resetCounter() {
stopTicker();
elapsedMs = 0;
segmentStart = 0;
timeEl.textContent = '00:00:00';
}

let flashTimer = null;
function flash(text, ms = 3500) {
clearTimeout(flashTimer);
labelEl.textContent = text;
flashTimer = setTimeout(() => {
if (STATES[state]) labelEl.textContent = STATES[state].label;
}, ms);
}
// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

// H.264 first: it stream-copies into MP4 for free. VP9 would force a full
// re-encode on save, so it is only a fallback.
const MIME_PREFERENCE = [
'video/webm;codecs=h264,opus',
'video/webm;codecs=h264',
'video/webm;codecs=vp9,opus',
'video/webm;codecs=vp8,opus',
'video/webm'
];

function pickMime() {
return MIME_PREFERENCE.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

let recorder = null;
let stream = null;
let lastFile = null;

// ondataavailable fires while a previous chunk may still be in flight. This
// chain keeps writes strictly ordered without buffering video in memory.
let writeChain = Promise.resolve();
let writeError = null;

function queueChunk(blob) {
writeChain = writeChain.then(async () => {
if (writeError) return;
try {
const buf = await blob.arrayBuffer();
await window.tally.recording.chunk(buf);
} catch (err) {
writeError = err;
console.error('Chunk write failed:', err);
}
});
}

/**
 * Acquire the screen and build the recorder, but do not start it. Splitting
 * this from captureBegin is what makes the countdown honest: permission and
 * file setup are resolved before 3 is ever shown, so the take starts the
 * instant the counter hits zero.
 */
async function captureArm() {
const mime = pickMime();

try {
stream = await navigator.mediaDevices.getDisplayMedia({
video: { frameRate: 30 },
audio: true
});
} catch (err) {
// The user cancelled, or no screen source came back.
if (err.name !== 'NotAllowedError') {
console.error(err);
flash('No screen source');
}
return false;
}

writeChain = Promise.resolve();
writeError = null;

try {
await window.tally.recording.open(mime);
} catch (err) {
console.error(err);
releaseStream();
flash('Could not open file');
return false;
}

try {
recorder = new MediaRecorder(stream, {
mimeType: mime || undefined,
videoBitsPerSecond: 8_000_000,
audioBitsPerSecond: 128_000
});
} catch (err) {
console.error(err);
await window.tally.recording.abort();
releaseStream();
flash('Recorder failed');
return false;
}
recorder.ondataavailable = (e) => { if (e.data && e.data.size) queueChunk(e.data); };
recorder.onerror = (e) => { writeError = e.error || new Error('Recorder error'); };

// If the recorder pauses or resumes for any reason other than a button press,
// the bar follows it rather than the other way round.
recorder.onpause = () => {
if (stopping || state !== 'recording') return;
freezeCounter();
setState('held');
};
recorder.onresume = () => {
if (stopping || state !== 'held') return;
setState('recording');
startTicker();
};

// If the source disappears (display unplugged, sharing revoked), close out
// cleanly instead of leaving a half-written file.
stream.getVideoTracks()[0].addEventListener('ended', () => {
if (state === 'arming') armAbort = true;
else if (state === 'recording' || state === 'held') finish();
});

return true;
}

function captureBegin() {
if (!recorder || recorder.state !== 'inactive') return false;
recorder.start(1000); // emit a chunk every second
return true;
}

/** Tear down an armed-but-never-started take. */
async function captureDisarm() {
releaseStream();
try { await window.tally.recording.abort(); } catch { /* nothing open */ }
}

let stopping = false; // suppresses the resume-before-stop from touching the UI

/**
 * MediaRecorder.pause() is not guaranteed to take effect — a recorder that has
 * already errored, or whose track ended a moment ago, silently ignores it.
 * Report the real state back so the bar cannot claim to be paused while frames
 * are still being written.
 */
function capturePause() {
if (!recorder || recorder.state !== 'recording') return false;
recorder.pause();
return recorder.state === 'paused';
}

function captureResume() {
if (!recorder || recorder.state !== 'paused') return false;
recorder.resume();
return recorder.state === 'recording';
}

function releaseStream() {
if (stream) {
stream.getTracks().forEach((t) => t.stop());
stream = null;
}
recorder = null;
}

async function captureStop() {
if (!recorder) return null;

stopping = true;
try {
await new Promise((resolve) => {
recorder.addEventListener('stop', resolve, { once: true });
// Some Chromium builds drop the final chunk if stop() is called while
// paused, so unpause first. The stopping flag keeps this off the UI.
if (recorder.state === 'paused') recorder.resume();
recorder.stop();
});
} finally {
stopping = false;
}

releaseStream();

await writeChain; // let every pending chunk land
if (writeError) {
await window.tally.recording.abort();
throw writeError;
}

return window.tally.recording.close(); // ffmpeg runs here, returns the mp4 path
}
// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

const COUNTDOWN_FROM = 3;
let armAbort = false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Returns false if the user cancelled part-way through. */
async function runCountdown() {
housing.classList.add('counting');
try {
for (let n = COUNTDOWN_FROM; n > 0; n--) {
timeEl.textContent = String(n);
timeEl.classList.remove('beat');
void timeEl.offsetWidth; // restart the animation
timeEl.classList.add('beat');
await sleep(1000);
if (armAbort) return false;
}
} finally {
housing.classList.remove('counting');
timeEl.classList.remove('beat');
}
return true;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

async function begin() {
primary.disabled = true;
const armed = await captureArm();
primary.disabled = false;
if (!armed) return;

lastFile = null;
armAbort = false;
setState('arming');

const proceed = await runCountdown();
if (!proceed || armAbort) {
await captureDisarm();
resetCounter();
setState('idle');
flash('Cancelled');
return;
}

if (!captureBegin()) {
await captureDisarm();
resetCounter();
setState('idle');
flash('Recorder failed');
return;
}

resetCounter();
setState('recording');
startTicker();
}

function freezeCounter() {
if (state === 'recording') elapsedMs += performance.now() - segmentStart;
stopTicker();
paintTime();
}

function suspend() {
if (!capturePause()) { flash('Could not pause'); return; }
freezeCounter();
setState('held');
}

function resume() {
if (!captureResume()) { flash('Could not resume'); return; }
setState('recording');
startTicker();
}

async function finish() {
if (state === 'saving' || state === 'idle') return;
freezeCounter();
setState('saving');

try {
const result = await captureStop();
lastFile = result ? result.path : null;
console.info('saved:', lastFile);
resetCounter();
setState('idle');
flash(result && result.reencoded ? 'Saved (re-encoded)' : 'Saved to Downloads');
} catch (err) {
console.error(err);
releaseStream();
resetCounter();
setState('idle');
flash('Save failed', 6000);
}
}
// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

primary.addEventListener('click', () => {
if (state === 'idle') begin();
else if (state === 'arming') armAbort = true;
else if (state === 'recording' || state === 'held') finish();
});

hold.addEventListener('click', () => {
if (state === 'recording') suspend();
else if (state === 'held') resume();
});

dismiss.addEventListener('click', async () => {
if (state === 'arming') {
armAbort = true;
await captureDisarm(); // otherwise the temp file is orphaned
} else if (state === 'recording' || state === 'held') {
await finish();
}
window.tally.close();
});

// Space toggles pause while live, so you don't have to aim at a 34px target.
window.addEventListener('keydown', (e) => {
if (e.code === 'Escape' && state === 'arming') { armAbort = true; return; }
if (e.code !== 'Space' || e.target.tagName === 'BUTTON') return;
e.preventDefault();
if (state === 'recording') suspend();
else if (state === 'held') resume();
});

window.addEventListener('beforeunload', () => {
if (recorder && recorder.state !== 'inactive') recorder.stop();
releaseStream();
});

// ffmpeg reports how far through the file it is while saving.
window.tally.onProgress(({ seconds, reencoding }) => {
if (state !== 'saving') return;
labelEl.textContent = reencoding ? 'Converting' : 'Saving';
timeEl.textContent = format(seconds * 1000);
});

// --- boot ------------------------------------------------------------------

setState('idle');
resetCounter();

window.tally.probeFfmpeg().then((r) => {
if (!r.ok) flash('ffmpeg missing', 8000);
console.info(r.ok ? `ffmpeg ready: ${r.path}` : 'ffmpeg NOT found', r);
});

console.info('recording format:', pickMime() || '(browser default)');

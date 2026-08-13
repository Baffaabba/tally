'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
/**
* ffmpeg-static ships the binary inside node_modules. Under an asar-packed
* build it lives in app.asar.unpacked, so the path needs rewriting.
*/
function ffmpegPath() {
  const raw = require('ffmpeg-static');
  if (!raw) throw new Error('ffmpeg-static did not resolve a binary path.');
  return raw.replace('app.asar', 'app.asar.unpacked');
}

function probeFfmpeg() {
  try {
    const p = ffmpegPath();
    return { ok: fs.existsSync(p), path: p };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
/**
* Rewrap a WebM recording as MP4.
*
* copyVideo: true — the source is H.264, so the video stream is copied
* verbatim. Only audio is transcoded to AAC (Opus in MP4
* has the same poor-playback problem H.264 solves for
* video). Runs many times faster than realtime.
* copyVideo: false — the source is VP9 and must be re-encoded to H.264.
* Slow, and only used when Chromium refused H.264.
*/
function remuxToMp4(input, output, { copyVideo = true, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(input)) {
      return reject(new Error(`No such recording: ${input}`));
    }

                     fs.mkdirSync(path.dirname(output), { recursive: true });

  const video = copyVideo
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];

                     const args = [
                       '-y',
                       '-i', input,
                       ...video,
                       '-c:a', 'aac',
                       '-b:a', '192k',
                       // MediaRecorder writes no duration header and timestamps start wherever
                       // the first chunk landed. These pin them back to zero.
                       '-avoid_negative_ts', 'make_zero',
                       '-fflags', '+genpts',
                       // Lets a player start before the whole file is buffered.
                       '-movflags', '+faststart',
                       output
                       ];

                     const proc = spawn(ffmpegPath(), args, { windowsHide: true });

                     let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
      if (onProgress) {
        const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });

                     proc.on('error', (err) =>
                       reject(new Error(`Could not launch ffmpeg: ${err.message}`)));

                     proc.on('close', (code) => {
                       if (code === 0) return resolve(output);
                       const hint = copyVideo && /codec|copy|incompatible|Could not find tag/i.test(stderr)
                       ? ' The source video codec cannot be copied into MP4.'
                       : '';
                       reject(new Error(`ffmpeg exited with code ${code}.${hint}\n${stderr.slice(-1200)}`));
                     });
  });
}

module.exports = { remuxToMp4, probeFfmpeg, ffmpegPath };

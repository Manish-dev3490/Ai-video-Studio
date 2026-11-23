import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {EngineContractError, validateTimeline} from './contracts.js';
import {validateWebVtt} from './captions.js';

const engineRoot = fileURLToPath(new URL('../', import.meta.url));
export const readJson = async file => JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
export const writeJson = (file, value, options = {}) => fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', ...options});

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function nativeBinaries() {
  const packages = {
    'win32-x64': '@remotion/compositor-win32-x64-msvc',
    'darwin-arm64': '@remotion/compositor-darwin-arm64',
    'darwin-x64': '@remotion/compositor-darwin-x64',
    'linux-x64': '@remotion/compositor-linux-x64-gnu',
    'linux-arm64': '@remotion/compositor-linux-arm64-gnu',
  };
  const name = packages[`${process.platform}-${process.arch}`];
  if (!name) throw new EngineContractError('UNSUPPORTED_PLATFORM', 'No configured media tool package for this platform.');
  const directory = path.join(engineRoot, 'node_modules', name);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const tools = {directory, ffmpeg: path.join(directory, 'ffmpeg' + suffix), ffprobe: path.join(directory, 'ffprobe' + suffix)};
  if (![tools.ffmpeg, tools.ffprobe].every(file => fs.existsSync(file))) throw new EngineContractError('MEDIA_TOOLS_MISSING', 'Install the engine dependencies with their platform-specific Remotion binaries.');
  return tools;
}

export function runTool(file, args, {binary = false, timeout = 120000} = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {windowsHide: true, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout}, (error, stdout, stderr) => {
      if (error) {
        const failure = new EngineContractError('MEDIA_TOOL_FAILED', 'A local media operation failed.', {tool: path.basename(file), reason: String(stderr || error.message).slice(-2000)});
        reject(failure);
      } else resolve({stdout, stderr});
    });
  });
}

export async function probeMedia(file, {countFrames = false} = {}) {
  const {stdout} = await runTool(nativeBinaries().ffprobe, ['-v', 'error', ...(countFrames ? ['-count_frames'] : []), '-show_format', '-show_streams', '-of', 'json', file]);
  return JSON.parse(stdout);
}

export async function measureNarration(file) {
  const probe = await probeMedia(file);
  const streams = probe.streams.filter(stream => stream.codec_type === 'audio');
  const duration = Number(probe.format?.duration);
  if (streams.length !== 1 || streams[0].codec_name !== 'pcm_s16le' || Number(streams[0].sample_rate) !== 24000 || streams[0].channels !== 1 || !Number.isFinite(duration) || duration <= 0) {
    throw new EngineContractError('INVALID_AUDIO', 'Narration must be a nonempty mono 24 kHz PCM16 WAV.');
  }
  return {durationMs: Math.ceil(duration * 1000), sampleRate: 24000, channels: 1, bytes: Number(probe.format.size), sha256: await sha256File(file)};
}

export function pcmFromWave(wave) {
  if (wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') throw new EngineContractError('INVALID_AUDIO', 'Expected a decoded PCM WAV.');
  let data;
  for (let cursor = 12; cursor + 8 <= wave.length;) {
    const size = wave.readUInt32LE(cursor + 4);
    if (wave.toString('ascii', cursor, cursor + 4) === 'data') {
      data = wave.subarray(cursor + 8, Math.min(wave.length, cursor + 8 + size));
      break;
    }
    cursor += 8 + size + size % 2;
  }
  if (!data?.length || data.length % 2) throw new EngineContractError('INVALID_AUDIO', 'Decoded PCM is empty or truncated.');
  const samples = new Int16Array(data.length / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = data.readInt16LE(index * 2);
  return samples;
}

export function inspectPcmWave(wave) {
  return inspectSamples(pcmFromWave(wave));
}

function inspectSamples(samples) {
  let energy = 0, peak = 0, nonzero = 0, saturated = 0;
  for (const value of samples) {
    energy += value * value;
    peak = Math.max(peak, Math.abs(value));
    if (value !== 0) nonzero++;
    if (Math.abs(value) >= 32767) saturated++;
  }
  return {sampleCount: samples.length, rmsDbfs: 20 * Math.log10(Math.sqrt(energy / samples.length) / 32768), peakDbfs: 20 * Math.log10(peak / 32768), nonzeroSamples: nonzero, saturatedSamples: saturated};
}

export async function audioStats(file) {
  const {stdout} = await runTool(nativeBinaries().ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], {binary: true});
  return inspectPcmWave(stdout);
}

function correlation(source, rendered, offset, start = 0, end = source.length, stride = 8) {
  let x = 0, y = 0, xx = 0, yy = 0, xy = 0, count = 0;
  for (let index = start; index < end; index += stride) {
    const target = index + offset;
    const a = source[index], b = target >= 0 && target < rendered.length ? rendered[target] : 0;
    x += a; y += b; xx += a * a; yy += b * b; xy += a * b; count++;
  }
  const vx = xx - x * x / count, vy = yy - y * y / count;
  return vx > 0 && vy > 0 ? (xy - x * y / count) / Math.sqrt(vx * vy) : 0;
}

/** Codec-tolerant source/output comparison, not transcription or word alignment. */
export function compareNarration(source, rendered, expectedStartSample, sampleRate = 24000, expectedLevelDeltaDb = 0) {
  let best = {correlation: -1, lagSamples: 0};
  for (let lag = -64; lag <= 64; lag++) {
    const value = correlation(source, rendered, expectedStartSample + lag, 0, source.length, 16);
    if (value > best.correlation) best = {correlation: value, lagSamples: lag};
  }
  let voicedWindows = 0, missingWindows = 0, levelMismatchWindows = 0, minimumCorrelation = 1, maximumLevelDeltaDb = 0;
  for (let start = 0; start < source.length; start += sampleRate) {
    const end = Math.min(source.length, start + sampleRate);
    let energy = 0, outputEnergy = 0;
    for (let index = start; index < end; index += 4) {
      energy += source[index] ** 2;
      const outputIndex = expectedStartSample + best.lagSamples + index;
      outputEnergy += (outputIndex >= 0 && outputIndex < rendered.length ? rendered[outputIndex] : 0) ** 2;
    }
    const rms = Math.sqrt(energy / Math.ceil((end - start) / 4)) / 32768;
    if (rms < 10 ** (-45 / 20)) continue;
    voicedWindows++;
    const value = correlation(source, rendered, expectedStartSample + best.lagSamples, start, end, 4);
    const levelDeltaDb = 10 * Math.log10(outputEnergy / energy);
    const deviationDb = Math.abs(levelDeltaDb - expectedLevelDeltaDb);
    maximumLevelDeltaDb = Math.max(maximumLevelDeltaDb, deviationDb);
    if (!Number.isFinite(levelDeltaDb) || deviationDb > 3) levelMismatchWindows++;
    minimumCorrelation = Math.min(minimumCorrelation, value);
    if (value < 0.9) missingWindows++;
  }
  return {...best, voicedWindows, missingWindows, levelMismatchWindows, expectedLevelDeltaDb, maximumLevelDeviationDb: Number.isFinite(maximumLevelDeltaDb) ? maximumLevelDeltaDb : null, minimumWindowCorrelation: minimumCorrelation, matched: best.correlation >= 0.95 && voicedWindows > 0 && missingWindows === 0 && levelMismatchWindows === 0};
}

export async function validateExport({storyboard, timeline, videoPath, captionPath, audio}) {
  validateTimeline(storyboard, timeline);
  const captionText = await fsp.readFile(captionPath, 'utf8');
  const captions = validateWebVtt({timeline, text: captionText, language: storyboard.settingsSnapshot.language});
  const probe = await probeMedia(videoPath, {countFrames: true});
  const videos = probe.streams.filter(stream => stream.codec_type === 'video');
  const audios = probe.streams.filter(stream => stream.codec_type === 'audio');
  const video = videos[0], narration = audios[0];
  const durationSec = Number(video?.duration ?? probe.format?.duration);
  const timelineSec = timeline.durationInFrames / timeline.fps;
  const containerSec = Number(probe.format?.duration);
  const checks = {
    oneVideoAndOneAudio: videos.length === 1 && audios.length === 1,
    codecs: video?.codec_name === 'h264' && narration?.codec_name === 'aac',
    profile: video?.width === 1280 && video?.height === 720 && video?.r_frame_rate === '30/1' && video?.pix_fmt === 'yuv420p',
    frameCount: Number(video?.nb_read_frames) === timeline.durationInFrames,
    timelineDuration: Math.abs(durationSec - timelineSec) < 1 / 30,
    targetTolerance: Math.abs(durationSec - storyboard.targetDurationSec) <= 5 + 0.000001,
    containerPadding: Math.abs(containerSec - durationSec) <= 0.1,
    audioDuration: Math.abs(Number(narration?.duration) - timelineSec) <= 0.1,
    sampleRate: Number(narration?.sample_rate) === 48000,
    stereoAudio: narration?.channels === 2,
    noEmbeddedSubtitleTrack: !probe.streams.some(stream => stream.codec_type === 'subtitle'),
    captionSidecar: Boolean(captions),
    narrationMetadataFits: audio.length === storyboard.scenes.length && audio.every((entry, index) => entry.sceneId === timeline.scenes[index].sceneId && entry.durationMs <= timeline.scenes[index].measuredAudioDurationMs && timeline.scenes[index].audioOffsetInFrames + Math.ceil(entry.durationMs * 30 / 1000) <= timeline.scenes[index].durationInFrames),
  };
  const decode = await runTool(nativeBinaries().ffmpeg, ['-v', 'error', '-xerror', '-i', videoPath, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'rawvideo', '-c:a', 'pcm_s16le', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null']);
  checks.fullDecode = !String(decode.stderr).trim();
  const {stdout: renderedWave} = await runTool(nativeBinaries().ffmpeg, ['-v', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], {binary: true});
  const renderedSamples = pcmFromWave(renderedWave);
  const stats = inspectSamples(renderedSamples);
  checks.nonSilentAudio = Number.isFinite(stats.rmsDbfs) && stats.rmsDbfs > -60 && stats.nonzeroSamples > 0;
  checks.noSaturatedAudio = stats.saturatedSamples === 0;
  const renderedNarration = [];
  for (let index = 0; index < audio.length; index++) {
    const source = pcmFromWave(await fsp.readFile(audio[index].filePath));
    const timing = timeline.scenes[index];
    const expectedStart = Math.round((timing.startFrame + timing.audioOffsetInFrames) * 24000 / timeline.fps);
    // Remotion's mono-to-stereo equal-power mix gives each channel 1/sqrt(2)
    // of the mono amplitude. FFmpeg's stereo-to-mono decode averages channels.
    const expectedLevelDeltaDb = -3.010299956639812;
    renderedNarration.push({sceneId: timing.sceneId, ...compareNarration(source, renderedSamples, expectedStart, 24000, expectedLevelDeltaDb)});
  }
  checks.eachSceneAudioMatchesSource = renderedNarration.length === storyboard.scenes.length && renderedNarration.every(item => item.matched);
  const passed = Object.values(checks).every(Boolean);
  const report = {passed, checks, targetDurationSec: storyboard.targetDurationSec, videoDurationSec: durationSec, containerDurationSec: containerSec, durationInFrames: timeline.durationInFrames, bytes: Number(probe.format.size), audio: stats, renderedNarration, captionCues: timeline.scenes.reduce((sum, scene) => sum + scene.captionSegments.length, 0), probe};
  if (!passed) throw new EngineContractError('OUTPUT_VALIDATION_FAILED', 'The export did not pass technical media validation.', report);
  return report;
}

export async function toolVersions() {
  const tools = nativeBinaries();
  const [ffmpeg, ffprobe] = await Promise.all([runTool(tools.ffmpeg, ['-version']), runTool(tools.ffprobe, ['-version'])]);
  return {ffmpeg: ffmpeg.stdout.split(/\r?\n/u)[0], ffprobe: ffprobe.stdout.split(/\r?\n/u)[0]};
}

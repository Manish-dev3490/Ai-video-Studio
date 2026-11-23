import {createHash} from 'node:crypto';
import {open, mkdir} from 'node:fs/promises';
import path from 'node:path';

export const KOKORO_SAMPLE_RATE = 24000;

export function speechError(code, message, cause) {
  const error = new Error(message, cause ? {cause} : undefined);
  error.code = code;
  return error;
}

export function inspectPcm(samples, sampleRate = KOKORO_SAMPLE_RATE) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw speechError('TTS_INVALID_AUDIO', 'Narration must contain nonempty Float32 PCM audio.');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw speechError('TTS_INVALID_AUDIO', 'Narration sample rate is invalid.');
  }
  let peak = 0;
  let squareSum = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      throw speechError('TTS_INVALID_AUDIO', 'Narration contains nonfinite samples.');
    }
    peak = Math.max(peak, Math.abs(sample));
    squareSum += sample * sample;
  }
  const rms = Math.sqrt(squareSum / samples.length);
  if (peak <= 0.00001 || rms <= 0.000001) {
    throw speechError('TTS_SILENT_AUDIO', 'Narration is empty or effectively silent.');
  }
  if (peak > 1) {
    throw speechError('TTS_CLIPPED_AUDIO', 'Narration exceeds the PCM range; do not silently clip it.');
  }
  return {
    sampleRate,
    sampleCount: samples.length,
    durationMs: Math.ceil(samples.length * 1000 / sampleRate),
    peak,
    rms,
  };
}

export function encodePcm16Wav(samples, sampleRate = KOKORO_SAMPLE_RATE) {
  inspectPcm(samples, sampleRate);
  const dataBytes = samples.length * 2;
  if (dataBytes > 0xffffffff - 36) {
    throw speechError('TTS_AUDIO_TOO_LARGE', 'Narration exceeds the supported WAV size.');
  }
  const wav = Buffer.allocUnsafe(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    wav.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + index * 2);
  }
  return wav;
}

/** Linear gain only: sample count, timing and natural speech rate are unchanged. */
export function normalizePcm(samples, {targetRmsDb = -20, peakCeilingDb = -1, maxGainDb = 12} = {}) {
  const before = inspectPcm(samples);
  if (![targetRmsDb, peakCeilingDb, maxGainDb].every(Number.isFinite) || targetRmsDb >= 0 || peakCeilingDb >= 0 || maxGainDb < 0 || maxGainDb > 24) {
    throw speechError('TTS_INVALID_NORMALIZATION', 'Narration normalization settings are invalid.');
  }
  const gain = Math.min(10 ** (targetRmsDb / 20) / before.rms, 10 ** (peakCeilingDb / 20) / before.peak, 10 ** (maxGainDb / 20));
  const normalized = Float32Array.from(samples, sample => sample * gain);
  const after = inspectPcm(normalized);
  return {
    samples: normalized,
    metadata: {
      method: 'LINEAR_RMS_WITH_PEAK_CEILING', targetRmsDb, peakCeilingDb, maxGainDb,
      gainDb: 20 * Math.log10(gain),
      beforeRmsDbfs: 20 * Math.log10(before.rms), afterRmsDbfs: 20 * Math.log10(after.rms),
      beforePeakDbfs: 20 * Math.log10(before.peak), afterPeakDbfs: 20 * Math.log10(after.peak),
      sampleCountUnchanged: normalized.length === samples.length,
    },
  };
}

export async function writeNarrationWav(outputPath, samples, sampleRate = KOKORO_SAMPLE_RATE) {
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.wav') {
    throw speechError('TTS_INVALID_OUTPUT', 'Narration output must be an internally resolved absolute WAV path.');
  }
  const metadata = inspectPcm(samples, sampleRate);
  const wav = encodePcm16Wav(samples, sampleRate);
  await mkdir(path.dirname(outputPath), {recursive: true});
  let file;
  try {
    file = await open(outputPath, 'wx');
    await file.writeFile(wav);
  } catch (cause) {
    if (cause.code === 'EEXIST') {
      throw speechError('TTS_OUTPUT_EXISTS', 'Narration output already exists; overwriting is disabled.', cause);
    }
    throw speechError('TTS_WRITE_FAILED', 'Unable to write narration output.', cause);
  } finally {
    await file?.close();
  }
  return {...metadata, filePath: outputPath, sha256: createHash('sha256').update(wav).digest('hex'), sizeBytes: wav.length};
}

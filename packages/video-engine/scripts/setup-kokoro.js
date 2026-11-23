import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_MODEL_PATH = path.join(ENGINE_ROOT, '.cache', 'kokoro', MODEL_REVISION);
const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const voiceFile = path.join(ENGINE_ROOT, 'node_modules/kokoro-js/voices/af_heart.bin');

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyKokoroSetup(modelPath = DEFAULT_MODEL_PATH) {
  const manifestPath = path.join(modelPath, 'model-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('KOKORO_SETUP_REQUIRED: run npm run setup:kokoro once before offline rendering.');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (manifest.modelId !== MODEL_ID || manifest.revision !== MODEL_REVISION || manifest.dtype !== 'q8') throw new Error('KOKORO_MODEL_MISMATCH');
  for (const name of modelFiles) {
    const record = manifest.files.find(item => item.path === name);
    const file = path.join(modelPath, name);
    if (!record || !fs.existsSync(file) || (await sha256(file)) !== record.sha256) throw new Error(`KOKORO_MODEL_INTEGRITY: ${name}`);
  }
  if (!fs.existsSync(voiceFile) || (await sha256(voiceFile)) !== manifest.voice.sha256) throw new Error('KOKORO_VOICE_INTEGRITY');
  return manifest;
}

export async function setupKokoro({modelPath = DEFAULT_MODEL_PATH, onProgress = console.log} = {}) {
  if (fs.existsSync(path.join(modelPath, 'model-manifest.json'))) return verifyKokoroSetup(modelPath);
  await fsp.mkdir(modelPath, {recursive: true});
  const metadataResponse = await fetch(`https://huggingface.co/api/models/${MODEL_ID}/revision/${MODEL_REVISION}?blobs=true`, {signal: AbortSignal.timeout(60000)});
  if (!metadataResponse.ok) throw new Error(`Model metadata download failed: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  if (metadata.sha !== MODEL_REVISION) throw new Error('Unexpected model revision returned by Hugging Face');
  const records = [];
  for (const name of modelFiles) {
    const item = metadata.siblings?.find(sibling => sibling.rfilename === name);
    if (!item) throw new Error(`Pinned repository does not contain ${name}`);
    const destination = path.join(modelPath, name);
    await fsp.mkdir(path.dirname(destination), {recursive: true});
    const expectedSha256 = item.lfs?.sha256 ?? null;
    if (!fs.existsSync(destination) || (expectedSha256 && (await sha256(destination)) !== expectedSha256)) {
      const partial = destination + '.part';
      if (fs.existsSync(partial)) await fsp.unlink(partial);
      onProgress(`Downloading pinned Kokoro file: ${name}`);
      const response = await fetch(`https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${name}?download=true`, {signal: AbortSignal.timeout(300000)});
      if (!response.ok || !response.body) throw new Error(`Download failed for ${name}: HTTP ${response.status}`);
      if (Number(response.headers.get('content-length') || 0) > 150 * 1024 * 1024) throw new Error('Unexpected model file size');
      try {
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, {flags: 'wx'}));
        const digest = await sha256(partial);
        if (expectedSha256 && digest !== expectedSha256) throw new Error(`Pinned model checksum mismatch: ${name}`);
        await fsp.rename(partial, destination);
      } catch (error) {
        if (fs.existsSync(partial)) await fsp.unlink(partial);
        throw error;
      }
    }
    records.push({path: name, bytes: (await fsp.stat(destination)).size, sha256: await sha256(destination), expectedSha256});
  }
  if (!fs.existsSync(voiceFile)) throw new Error('Bundled af_heart voice missing from installed kokoro-js');
  const manifest = {
    modelId: MODEL_ID, revision: MODEL_REVISION, dtype: 'q8', device: 'cpu', downloadedAt: new Date().toISOString(),
    source: `https://huggingface.co/${MODEL_ID}/tree/${MODEL_REVISION}`,
    license: 'Apache-2.0 (model card)', files: records,
    voice: {id: 'af_heart', source: 'kokoro-js 1.2.1 bundled voices', bytes: (await fsp.stat(voiceFile)).size, sha256: await sha256(voiceFile)},
    generationRequiresNetwork: false,
  };
  await fsp.writeFile(path.join(modelPath, 'model-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  return verifyKokoroSetup(modelPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = process.argv.includes('--verify-only') ? await verifyKokoroSetup() : await setupKokoro();
    console.log(JSON.stringify({modelPath: DEFAULT_MODEL_PATH, revision: manifest.revision, files: manifest.files.length, modelBytes: manifest.files.reduce((total, item) => total + item.bytes, 0), offlineReady: true}));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

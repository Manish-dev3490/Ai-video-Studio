import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson} from '../src/media.js';
import {DEFAULT_BROWSER_EXECUTABLE, DEFAULT_MODEL_PATH, prepareVideo, renderExplainer, renderPrepared} from '../src/index.js';

const usage = 'node scripts/render.js --input <approved-storyboard.json> --output-dir <fresh-directory> [--model-dir <local-model>] [--browser <installed-chrome>] [--prepare-only]\nnode scripts/render.js --output-dir <prepared-directory> [--browser <installed-chrome>] --render-only';

export function parseRenderArguments(argv) {
  const values = {};
  const valueFlags = new Map([['--input', 'input'], ['--output-dir', 'outputDir'], ['--model-dir', 'modelPath'], ['--browser', 'browserExecutable']]);
  const switches = new Map([['--prepare-only', 'prepareOnly'], ['--render-only', 'renderOnly'], ['--help', 'help']]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const key = valueFlags.get(flag) || switches.get(flag);
    if (!key || Object.hasOwn(values, key)) throw new Error('INVALID_ARGUMENTS');
    if (switches.has(flag)) values[key] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
      values[key] = path.resolve(value);
    }
  }
  if (values.help) return values;
  if (!values.outputDir || (values.prepareOnly && values.renderOnly) || (values.renderOnly && (values.input || values.modelPath || values.prepareOnly)) || (!values.renderOnly && !values.input)) throw new Error('INVALID_ARGUMENTS');
  return values;
}

async function main() {
  const args = parseRenderArguments(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage + '\n'); return; }
  const options = {outputDir: args.outputDir, modelPath: args.modelPath || DEFAULT_MODEL_PATH, browserExecutable: args.browserExecutable || DEFAULT_BROWSER_EXECUTABLE, onProgress: event => process.stdout.write(JSON.stringify(event) + '\n')};
  let result;
  if (args.renderOnly) result = await renderPrepared(options);
  else {
    options.storyboard = await readJson(args.input);
    result = await (args.prepareOnly ? prepareVideo(options) : renderExplainer(options));
  }
  process.stdout.write(JSON.stringify({status: args.prepareOnly ? 'PREPARED' : result.status, outputDir: result.outputDir, ...(result.videoPath ? {videoPath: result.videoPath, captionPath: result.captionPath, validationPassed: result.validation.passed} : {}), timings: result.timings}) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // No raw provider responses, environment values, stacks or internal paths.
    const code = /^[A-Z0-9_]{1,80}$/u.test(error.code || error.message || '') ? error.code || error.message : 'LOCAL_RENDER_FAILED';
    const message = code === 'INVALID_ARGUMENTS' ? usage : error.name === 'EngineContractError' ? error.message : 'The local render did not complete. Inspect the private run artifacts and verify local setup.';
    process.stderr.write(JSON.stringify({code, message, retryable: false}) + '\n');
    process.exitCode = 1;
  });
}

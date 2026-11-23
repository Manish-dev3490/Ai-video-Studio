// Browser-safe, deterministic layout helpers. Runtime schema validation remains
// the Node pipeline's responsibility; these checks protect the render boundary.
export const WIDTH = 1280;
export const HEIGHT = 720;
export const FPS = 30;
export const COMPOSITION_ID = 'ExplainerVideo';
export const SUPPORTED_TEMPLATES = Object.freeze(['TITLE', 'STEPS', 'STACK_QUEUE', 'FLOWCHART', 'KEY_POINTS']);
export const BODY = Object.freeze({width: 1152, height: 438});

export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const smooth = value => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};
export const sceneProgress = (frame, duration) => clamp((frame + 1) / Math.max(1, duration));

export function pageState(progress, length, pageSize = 4) {
  const pages = Math.max(1, Math.ceil(length / pageSize));
  const scaled = clamp(progress) * pages;
  const page = Math.min(pages - 1, Math.floor(scaled));
  return {page, pages, start: page * pageSize, end: Math.min(length, (page + 1) * pageSize), progress: clamp(scaled - page)};
}

export function cardGrid(count, width = BODY.width, height = BODY.height) {
  const columns = count === 1 ? 1 : 2;
  const rows = Math.ceil(count / columns);
  const gap = 18;
  return {columns, rows, gap, cardWidth: (width - gap * (columns - 1)) / columns, cardHeight: (height - gap * (rows - 1)) / rows};
}

function characterWidth(character) {
  if (/\s/u.test(character)) return 0.29;
  if (/[ilI.,'`!:;|]/u.test(character)) return 0.28;
  if (/[MW@#%&]/u.test(character)) return 0.94;
  if (/[A-Z0-9]/u.test(character)) return 0.65;
  if (/[a-z]/u.test(character)) return 0.55;
  return 1;
}

export function estimatedTextLines(text, width, fontSize) {
  let lines = 0;
  for (const paragraph of String(text).split('\n')) {
    let used = 0;
    lines++;
    for (const word of paragraph.split(/(\s+)/u)) {
      const wordWidth = Array.from(word).reduce((total, char) => total + characterWidth(char) * fontSize, 0);
      if (wordWidth > width) {
        for (const char of Array.from(word)) {
          const next = characterWidth(char) * fontSize;
          if (used + next > width && used > 0) { lines++; used = 0; }
          used += next;
        }
      } else if (used + wordWidth > width && used > 0) {
        lines++;
        used = /^\s+$/u.test(word) ? 0 : wordWidth;
      } else {
        used += wordWidth;
      }
    }
  }
  return lines;
}

export function fitFont(text, width, height, maximum = 26, minimum = 12, lineHeight = 1.2) {
  // Deliberately conservative width estimate; browser QA also checks actual DOM.
  for (let size = maximum; size >= minimum; size -= 0.5) {
    if (estimatedTextLines(text, width, size) * size * lineHeight <= height) return size;
  }
  return minimum;
}

export function flowchartLayout(nodes, width = BODY.width, height = 344) {
  const rows = nodes.length <= 4 ? 1 : nodes.length <= 8 ? 2 : 3;
  const columns = Math.ceil(nodes.length / rows);
  const innerWidth = width - 36;
  const innerHeight = height - 16;
  const gapX = 48;
  const gapY = 24;
  const nodeWidth = Math.min(286, (innerWidth - (columns - 1) * gapX) / columns);
  const nodeHeight = Math.min(112, (innerHeight - (rows - 1) * gapY) / rows);
  const totalWidth = columns * nodeWidth + (columns - 1) * gapX;
  const totalHeight = rows * nodeHeight + (rows - 1) * gapY;
  return nodes.map((node, index) => ({
    ...node,
    index,
    x: (width - totalWidth) / 2 + (index % columns) * (nodeWidth + gapX),
    y: (height - totalHeight) / 2 + Math.floor(index / columns) * (nodeHeight + gapY),
    width: nodeWidth,
    height: nodeHeight,
  }));
}

export function stackState(progress, count) {
  const p = clamp(progress);
  if (p >= 0.995) return {phase: 'COMPLETE', visible: 0, active: 0};
  if (p < 0.55) {
    const visible = Math.min(count, Math.floor(p / 0.55 * count) + 1);
    return {phase: 'PUSH', visible, active: visible - 1};
  }
  const returned = Math.min(count - 1, Math.floor((p - 0.55) / 0.45 * count));
  return {phase: 'RETURN', visible: count - returned, active: count - returned - 1};
}

export function assertRenderProps(props) {
  const {storyboard, timeline, audioSources} = props || {};
  if (!storyboard || storyboard.status !== 'APPROVED' || !Array.isArray(storyboard.scenes)) throw new Error('Rendering requires an approved storyboard.');
  if (![30, 60, 90].includes(storyboard.targetDurationSec) || storyboard.settingsSnapshot?.durationSec !== storyboard.targetDurationSec) throw new Error('Storyboard target/settings mismatch.');
  if (storyboard.settingsSnapshot?.mode !== 'FACELESS' || storyboard.settingsSnapshot?.language !== 'en' || storyboard.settingsSnapshot?.aspectRatio !== '16:9') throw new Error('Only the tested faceless English landscape profile is supported.');
  if (!timeline || timeline.fps !== FPS || !Number.isSafeInteger(timeline.durationInFrames) || timeline.durationInFrames < 1 || timeline.durationInFrames > 2850 || !Array.isArray(timeline.scenes)) throw new Error('Invalid measured render timeline.');
  if (Math.abs(timeline.durationInFrames / FPS - storyboard.targetDurationSec) > 5) throw new Error('Measured timeline is outside target tolerance.');
  if (storyboard.scenes.length < 2 || storyboard.scenes.length > 18 || storyboard.scenes.length !== timeline.scenes.length) throw new Error('Storyboard/timeline scene count mismatch.');
  if (!audioSources || typeof audioSources !== 'object' || Array.isArray(audioSources)) throw new Error('Resolved audio sources are required.');
  const seen = new Set();
  let cursor = 0;
  for (let index = 0; index < storyboard.scenes.length; index++) {
    const scene = storyboard.scenes[index];
    const timing = timeline.scenes[index];
    if (!scene || typeof scene.sceneId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(scene.sceneId) || seen.has(scene.sceneId)) throw new Error('Scene IDs must be valid and unique.');
    seen.add(scene.sceneId);
    if (!SUPPORTED_TEMPLATES.includes(scene.template)) throw new Error('Scene template is not enabled.');
    if (typeof scene.narration !== 'string' || !scene.narration.trim() || !scene.visualProps || typeof scene.visualProps.title !== 'string') throw new Error('Scene narration and template props are required.');
    if (!timing || timing.sceneId !== scene.sceneId || timing.startFrame !== cursor || !Number.isSafeInteger(timing.durationInFrames) || timing.durationInFrames < 1 || !Number.isSafeInteger(timing.audioOffsetInFrames) || timing.audioOffsetInFrames < 0 || !Number.isSafeInteger(timing.measuredAudioDurationMs) || timing.measuredAudioDurationMs < 1) throw new Error('Scene timeline is not canonical.');
    if (timing.audioOffsetInFrames + Math.ceil(timing.measuredAudioDurationMs * FPS / 1000) > timing.durationInFrames) throw new Error('Narration would be clipped.');
    if (!Object.hasOwn(audioSources, scene.sceneId) || typeof audioSources[scene.sceneId] !== 'string' || !/^narration\/[A-Za-z0-9_-]+\.wav$/u.test(audioSources[scene.sceneId])) throw new Error('Audio sources must be internally resolved narration WAV files.');
    cursor += timing.durationInFrames;
  }
  if (cursor !== timeline.durationInFrames || Object.keys(audioSources).length !== seen.size) throw new Error('Render duration/audio resources do not match the timeline.');
  return {width: WIDTH, height: HEIGHT, fps: FPS, durationInFrames: cursor};
}

import {fitFont, cardGrid, flowchartLayout} from '../../../../packages/video-engine/src/remotion/layout.js';
import {interAdvances} from './inter-metrics.js';
import {ApiError} from '../http.js';

// Match the renderer's chosen size, then check wrapping with measured advances.
// Ignoring negative tracking/kerning and reserving width makes this conservative.
export function measuredTextLines(text, width, size, weight = 600) {
  const advances = interAdvances[weight];
  const available = width * .98;
  const advance = character => (advances[character] ?? 2.2) * size;
  let lines = 1, used = 0;
  for (const word of String(text).trim().replace(/\s+/gu, ' ').split(' ')) {
    const characters = Array.from(word);
    const length = characters.reduce((sum, character) => sum + advance(character), 0);
    const gap = used ? advance(' ') : 0;
    if (length <= available) {
      if (used && used + gap + length > available) {lines++; used = length;}
      else used += gap + length;
    } else {
      if (used) {lines++; used = 0;}
      for (const character of characters) {
        const next = advance(character);
        if (used && used + next > available) {lines++; used = 0;}
        used += next;
      }
    }
  }
  return lines;
}

export function assertTextFit(storyboard) {
  function check(text, field, width, height, maximum, minimum, lineHeight, weight = 600) {
    if (typeof text !== 'string' || !text.trim()) return;
    const size = fitFont(text, width, height, maximum, minimum, lineHeight);
    if (measuredTextLines(text, width, size, weight) * size * lineHeight > height - .5) {
      throw new ApiError(422, 'LAYOUT_REVIEW_REQUIRED', 'Shorten this visual label or split it into shorter words so it fits the video clearly.', {details: {field, profile: 'INTER_720P_MEASURED_ADVANCES'}});
    }
  }
  for (const [index, scene] of storyboard.scenes.entries()) {
    const props = scene.visualProps, field = `scenes[${index}].visualProps`;
    if (scene.template === 'TITLE') {
      check(props.title, field + '.title', 1080, 300, 82, 38, 1.08, 700);
      check(props.subtitle, field + '.subtitle', 1060, 142, 29, 20, 1.25, 400);
      continue;
    }
    check(props.title, field + '.title', 1152, 104, 46, 28, 1.12, 700);
    if (['STEPS', 'KEY_POINTS'].includes(scene.template)) {
      const key = scene.template === 'STEPS' ? 'steps' : 'points', entries = props[key];
      for (let start = 0; start < entries.length; start += 4) {
        const visible = entries.slice(start, start + 4), grid = cardGrid(visible.length);
        visible.forEach((text, local) => check(text, `${field}.${key}[${start + local}]`, grid.cardWidth - 44, grid.cardHeight - 88, visible.length === 1 ? 40 : 30, 14, 1.2));
      }
    } else if (scene.template === 'STACK_QUEUE') {
      const dual = props.layout === 'STACK_AND_QUEUE';
      props.items.forEach((text, item) => check(text, `${field}.items[${item}]`, dual ? 482 : 428, dual ? 68 : 356, dual ? 27 : 42, dual ? 13 : 18, 1.18));
    } else if (scene.template === 'FLOWCHART') {
      const nodes = flowchartLayout(props.nodes), byId = new Map(nodes.map(node => [node.id, node]));
      nodes.forEach((node, item) => check(node.label, `${field}.nodes[${item}].label`, node.width - 36, node.height - 32, 24, 10, 1.15));
      props.edges.forEach((edge, item) => check(edge.label || `${byId.get(edge.from)?.label} → ${byId.get(edge.to)?.label}`, `${field}.edges[${item}].label`, 1056, 48, 25, 12, 1.2, 400));
    }
  }
  return storyboard;
}

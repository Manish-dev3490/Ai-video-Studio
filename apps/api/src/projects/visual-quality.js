import {ApiError} from '../http.js';
import {assertTextFit} from './text-fit.js';

/**
 * The preserved renderer puts up to four nodes in one row and draws direct
 * connectors. Restrict new work to a single ordered chain so connectors cannot
 * cross intervening nodes or share a forward/return corridor. Complex graphs
 * need a separately validated renderer; never silently remove their edges.
 */
export function assertVisualQuality(storyboard) {
  for (const [index, scene] of (storyboard?.scenes || []).entries()) {
    if (scene.template !== 'FLOWCHART') continue;
    const {nodes, edges} = scene.visualProps || {};
    if (!Array.isArray(nodes) || nodes.length < 2 || nodes.length > 4 || !Array.isArray(edges) || edges.length !== nodes.length - 1 || edges.some((edge, edgeIndex) => edge.from !== nodes[edgeIndex]?.id || edge.to !== nodes[edgeIndex + 1]?.id)) {
      throw new ApiError(422, 'LAYOUT_REVIEW_REQUIRED', 'Use 2–4 flowchart nodes connected once in their displayed order. Use a STEPS scene for cycles, branches or more complex relationships.', {details: {field: `scenes[${index}].visualProps`, profile: 'ORDERED_LINEAR_FLOWCHART', maximumNodes: 4}});
    }
  }
  return assertTextFit(storyboard);
}

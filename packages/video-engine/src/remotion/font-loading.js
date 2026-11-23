export const PINNED_FONT_WEIGHTS = Object.freeze([400, 600, 700]);
const fontStyle = weight => `${weight} 24px Inter`;
const sampleText = 'Explainer video';

/** Wait for the actual pinned faces, then for layout-triggered font loading. */
export async function loadPinnedFonts(fontSet) {
  if (!fontSet || typeof fontSet.load !== 'function' || !fontSet.ready) throw new Error('Browser font loading is unavailable.');
  const faces = await Promise.all(PINNED_FONT_WEIGHTS.map(weight => fontSet.load(fontStyle(weight), sampleText)));
  if (faces.some(result => !Array.isArray(result) || result.length === 0)) throw new Error('Pinned Inter font did not load.');
  await fontSet.ready;
  if (typeof fontSet.check === 'function' && PINNED_FONT_WEIGHTS.some(weight => !fontSet.check(fontStyle(weight), sampleText))) throw new Error('Pinned Inter font is not ready for layout.');
}

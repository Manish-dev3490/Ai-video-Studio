import {speechError} from './audio.js';

export function normalizeNarrationWhitespace(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Bounded sentence/word chunks retain every approved word and punctuation. */
export function splitNarration(text, maxCharacters = 240) {
  if (typeof text !== 'string' || !text.trim() || /[\u0000-\u0008\u000e-\u001f\u007f]/u.test(text)) {
    throw speechError('TTS_INVALID_TEXT', 'Narration must be nonblank text without unsafe control characters.');
  }
  if (Array.from(text).length > 1200) {
    throw speechError('TTS_TEXT_TOO_LONG', 'Scene narration exceeds the approved 1200-character upper limit.');
  }
  if (!Number.isInteger(maxCharacters) || maxCharacters < 40 || maxCharacters > 300) {
    throw speechError('TTS_INVALID_CHUNK_LIMIT', 'Narration chunks must use a 40–300 character bound.');
  }
  const normalized = normalizeNarrationWhitespace(text);
  const sentences = [...new Intl.Segmenter('en', {granularity: 'sentence'}).segment(normalized)].map(item => item.segment.trim());
  const result = [];
  for (const sentence of sentences) {
    let chunk = '';
    for (const word of sentence.match(/\S+/gu) || []) {
      if (Array.from(word).length > maxCharacters) {
        throw speechError('TTS_TOKEN_TOO_LONG', 'An unbroken narration token exceeds the speech chunk limit; revise the narration.');
      }
      const candidate = chunk ? chunk + ' ' + word : word;
      if (Array.from(candidate).length > maxCharacters) {
        result.push(chunk);
        chunk = word;
      } else {
        chunk = candidate;
      }
    }
    if (chunk) result.push(chunk);
  }
  if (!result.length || normalizeNarrationWhitespace(result.join(' ')) !== normalized) {
    throw speechError('TTS_TEXT_COVERAGE', 'Speech segmentation did not preserve all narration text.');
  }
  return result;
}

/** Upstream generates with truncation=true; verify the same phonemes untruncated. */
export function assertContextFits(tokenCount, maximum = 512) {
  if (!Number.isInteger(tokenCount) || tokenCount <= 2 || tokenCount > maximum) {
    throw speechError('TTS_CONTEXT_OVERFLOW', 'A narration segment exceeds the speech model context; revise it instead of accepting truncated speech.');
  }
}

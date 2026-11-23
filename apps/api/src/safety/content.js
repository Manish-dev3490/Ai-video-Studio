import {ApiError} from '../http.js';

// Deliberately bounded, deterministic preflight for clearly unsafe English
// requests. This complements provider filtering and human reports; it is not a
// semantic classifier and must not be described as comprehensive moderation.
const prohibited = [
  /\b(?:how\s+(?:to|do\s+i|can\s+i)|instructions?\s+(?:for|to)|step[-\s]by[-\s]step|recipe\s+(?:for|to)|to)\b.{0,100}\b(?:make|build|assemble|construct)\s+(?:(?:a|an)\s+)?(?:working\s+|improvised\s+|pipe\s+)?(?:bomb|explosive(?:s|\s+device)?)\b/iu,
  /\b(?:write|create|generate|give|provide)\b.{0,35}\b(?:code|script|malware|instructions?|steps?)\s+(?:(?:that|which)\s+)?(?:(?:will|can)\s+)?(?:to\s+)?(?:steals?|exfiltrates?|harvests?)\b.{0,45}\b(?:passwords?|session\s+cookies?|login\s+credentials?|access\s+tokens?)\b/iu,
  /\b(?:how\s+(?:to|do\s+i|can\s+i)|instructions?\s+(?:to|for))\s+(?:steal|exfiltrate|harvest)\b.{0,45}\b(?:passwords?|session\s+cookies?|login\s+credentials?|access\s+tokens?)\b/iu,
  /\b(?:sexual|pornographic|explicit\s+sexual|nude)\s+(?:images?|videos?|pictures?|scenes?|content)\s+(?:of|with|featuring)\s+(?:a\s+|an\s+)?(?:child|children|minors?|underage|(?:[0-9]|1[0-7])[- ]year[- ]old)\b/iu,
  /\b(?:create|generate|make|show)\b.{0,70}\b(?:child|children|minors?|underage)\b.{0,45}\b(?:having\s+sex|performing\s+sexual|naked|nude|pornographic)\b/iu,
  /\b(?:create|generate|make|produce)\b.{0,90}\b(?:non[- ]?consensual|without\s+(?:their|her|his)\s+consent|revenge\s+porn)\b.{0,90}\b(?:sexual|porn|nude|deepfake)\b/iu,
  /\b(?:create|generate|make|produce)\b.{0,90}\b(?:sexual|porn|nude|deepfake)\b.{0,90}\b(?:non[- ]?consensual|without\s+(?:their|her|his)\s+consent|revenge\s+porn)\b/iu,
  /\b(?:impersonate|deepfake|fake\s+(?:a\s+)?(?:video|voice))\b.{0,140}\b(?:trick|deceive|defraud|scam|without\s+(?:their|her|his)\s+consent)\b/iu,
  /\b(?:write|create|generate|give|provide)\b.{0,45}\b(?:instructions?|steps?|recipe|guide)\b.{0,90}\b(?:poison|kill|murder)\s+(?:someone|a\s+person|my\s+(?:wife|husband|neighbor|neighbour))\b/iu,
];

export function safetyShadow(text) {
  return text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '').replace(/\s+/gu, ' ');
}

export function assertSafeContent(text) {
  if (typeof text === 'string' && prohibited.some(pattern => pattern.test(safetyShadow(text)))) {
    throw new ApiError(422, 'CONTENT_REJECTED', 'This content cannot be used to create a video. Remove harmful instructions, sexual exploitation or deceptive impersonation and choose a safe educational topic.');
  }
  return text;
}

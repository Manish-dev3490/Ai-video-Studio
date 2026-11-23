import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';

const repository = fileURLToPath(new URL('../', import.meta.url));
const file = path.join(repository, '.env');
const content = ['NODE_ENV=development', 'APP_ORIGIN=http://127.0.0.1:5173', 'API_HOST=127.0.0.1', 'API_PORT=4100', 'MONGODB_URI=mongodb://127.0.0.1:27018/ai_video_studio_phase3', 'JWT_SECRET=' + randomBytes(48).toString('base64url'), 'CSRF_SECRET=' + randomBytes(48).toString('base64url'), 'GEMINI_API_KEY=', 'GEMINI_MODEL=gemini-2.5-flash', 'DAILY_GENERATION_LIMIT=3', 'ASSISTANT_DAILY_LIMIT=30', 'MAIL_TRANSPORT=local', 'MAIL_FROM=AI Video Studio <no-reply@localhost.invalid>', 'RESEND_API_KEY=', 'MAIL_ENCRYPTION_SECRET=' + randomBytes(48).toString('base64url'), ''].join('\n');
try {
  await fs.writeFile(file, content, {flag: 'wx', mode: 0o600});
  process.stdout.write('Local configuration created in ignored .env. Secret values are not printed. Run npm run dev.\n');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  process.stdout.write('Existing .env preserved. No configuration or secrets were overwritten.\n');
}

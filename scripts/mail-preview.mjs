import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../apps/api/src/config.js';
import {privateMailPreviewRoot} from '../apps/api/src/mail.js';

const config = loadConfig();
if (config.mailMode !== 'local' || config.isProduction) {
  process.stdout.write('Private local email preview is disabled for this transport.\n');
} else {
  const directory = await privateMailPreviewRoot(config);
  let entries = [];
  try {entries = await fs.readdir(directory, {withFileTypes: true});} catch (error) {if (error.code !== 'ENOENT') throw error;}
  const messages = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{24}\.json$/u.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || stat.size > 100000) continue;
    const message = JSON.parse(await fs.readFile(file, 'utf8'));
    messages.push({subject: message.subject, received: stat.mtime, file});
  }
  messages.sort((first, second) => second.received - first.received);
  if (!messages.length) process.stdout.write('No local preview emails yet. Request verification or a password reset in the app.\n');
  for (const message of messages.slice(0, 10)) {
    // Default output is a locator, not the capability link or recipient.
    process.stdout.write(`${message.received.toISOString()}  ${message.subject}\n${message.file}\n`);
  }
  process.stdout.write('Open a listed private JSON file to read its message and action link. Nothing is served publicly.\n');
}

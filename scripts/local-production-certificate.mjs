import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate, createPrivateKey, createPublicKey} from 'node:crypto';
import {ensureDirectoryUnder} from '../apps/api/src/jobs/files.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
export const isLocalHostname = name => typeof name === 'string' && (name === 'localhost' || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+localhost$/u.test(name)) && name.length <= 253;
const failure = code => Object.assign(new Error('Local HTTPS certificate setup could not be verified. No certificate trust store was changed.'), {code});

export async function readLocalCertificate({certFile, keyFile, hostname}) {
  if (!isLocalHostname(hostname)) throw failure('LOCAL_TLS_HOST_INVALID');
  if (typeof certFile === 'string' && typeof keyFile === 'string' && path.resolve(certFile) === path.resolve(keyFile)) throw failure('LOCAL_TLS_PAIR_INVALID');
  const output = {};
  for (const [field, file] of [['cert', certFile], ['key', keyFile]]) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !path.resolve(file).startsWith(path.resolve(root, 'var') + path.sep)) throw failure('LOCAL_TLS_PATH_INVALID');
    const parent = await fs.lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw failure('LOCAL_TLS_PATH_INVALID');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100 || stat.size > 16384 || path.relative(file, await fs.realpath(file)) !== '') throw failure('LOCAL_TLS_FILE_INVALID');
    output[field] = await fs.readFile(file);
  }
  try {
    if (output.cert.includes('PRIVATE KEY') || output.key.includes('CERTIFICATE')) throw failure('LOCAL_TLS_PAIR_INVALID');
    const certificate = new X509Certificate(output.cert), privateKey = createPrivateKey(output.key);
    const supplied = createPublicKey(privateKey).export({type: 'spki', format: 'der'});
    if (!certificate.publicKey.export({type: 'spki', format: 'der'}).equals(supplied) || !certificate.checkHost(hostname) || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now() + 60000 || certificate.ca || privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) throw failure('LOCAL_TLS_PAIR_INVALID');
    return {...output, validUntil: new Date(certificate.validTo).toISOString()};
  } catch {throw failure('LOCAL_TLS_PAIR_INVALID');}
}

/** Local-only self-signed leaf. Never installs a CA or changes an OS trust store. */
export async function ensureLocalCertificate({directory, hostname = 'studio.localhost', powershellExecutable = 'C:/Users/manish kumar/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'}) {
  if (process.platform !== 'win32' || !isLocalHostname(hostname) || !path.isAbsolute(directory) || !path.resolve(directory).startsWith(path.resolve(root, 'var') + path.sep)) throw failure('LOCAL_TLS_OPTIONS_INVALID');
  const resolved = await ensureDirectoryUnder(root, path.resolve(directory));
  const certFile = path.join(resolved, 'local-cert.pem'), keyFile = path.join(resolved, 'local-key.pem');
  const exists = async file => {try {await fs.lstat(file); return true;} catch (error) {if (error.code === 'ENOENT') return false; throw error;}};
  const present = await Promise.all([exists(certFile), exists(keyFile)]);
  if (present.every(Boolean)) {await readLocalCertificate({certFile, keyFile, hostname}); return {certFile, keyFile, created: false};}
  if (present.some(Boolean)) throw failure('LOCAL_TLS_PARTIAL_PAIR');
  const lock = await fs.open(path.join(resolved, '.certificate.lock'), 'wx', 0o600);
  try {
    const script = `$ErrorActionPreference='Stop'
$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$cert=$null
try {
  $request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN='+$env:AVS_LOCAL_TLS_HOST,$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName($env:AVS_LOCAL_TLS_HOST)
  if ($env:AVS_LOCAL_TLS_HOST -ne 'localhost') {$san.AddDnsName('localhost')}
  $san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
  $request.CertificateExtensions.Add($san.Build())
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment),$true))
  $eku=[System.Security.Cryptography.OidCollection]::new()
  [void]$eku.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku,$false))
  $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(30))
  $values=@{'local-cert.pem'=$cert.ExportCertificatePem();'local-key.pem'=$rsa.ExportPkcs8PrivateKeyPem()}
  foreach($name in $values.Keys){
    $file=[System.IO.FileStream]::new([System.IO.Path]::Combine($env:AVS_LOCAL_TLS_DIRECTORY,$name),[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
    try {$bytes=[System.Text.Encoding]::UTF8.GetBytes($values[$name]+[Environment]::NewLine);$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
  }
} finally {if($cert){$cert.Dispose()};$rsa.Dispose()}`;
    const environment = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (process.env[name]) environment[name] = process.env[name];
    Object.assign(environment, {AVS_LOCAL_TLS_DIRECTORY: resolved, AVS_LOCAL_TLS_HOST: hostname});
    try {await run(powershellExecutable, ['-NoProfile', '-NonInteractive', '-Command', script], {env: environment, windowsHide: true, timeout: 30000, maxBuffer: 4096});}
    catch {throw failure('LOCAL_TLS_CREATION_FAILED');}
    await readLocalCertificate({certFile, keyFile, hostname});
    return {certFile, keyFile, created: true};
  } finally {await lock.close(); await fs.unlink(path.join(resolved, '.certificate.lock'));}
}

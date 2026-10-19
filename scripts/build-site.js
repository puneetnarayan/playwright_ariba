// Builds site/PR_Portal_Inspector_Recorder.zip from the app files in this repo (no dependencies).
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const TOP = 'PR_Portal_Inspector_Recorder';
const INCLUDE = ['server.js', 'lookup.js', 'lookup-config.json', 'package.json', 'README.txt', 'HELP.html', 'Start-Here.hta', 'Start-App.bat', 'Run-Server.bat', 'Env-Setup.bat', 'First-Run-Setup.ps1', 'scripts/dep-hash.js', 'public', 'input/README.txt'];

const table = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function walk(rel, out) {
  const abs = path.join(ROOT, rel), st = fs.statSync(abs);
  if (st.isDirectory()) fs.readdirSync(abs).sort().forEach(n => walk(path.join(rel, n), out));
  else out.push(rel.split(path.sep).join('/'));
}
const files = []; INCLUDE.forEach(p => walk(p, files));
files.push('output/.gitkeep');

const parts = [], central = []; let offset = 0;
const add = (name, data) => {
  const nameBuf = Buffer.from(TOP + '/' + name), comp = zlib.deflateRawSync(data), crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  parts.push(local, nameBuf, comp);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
  c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
  c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
};
for (const f of files) add(f, fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f)) : Buffer.alloc(0));
const cd = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);

fs.mkdirSync(SITE, { recursive: true });
const zipPath = path.join(SITE, TOP + '.zip');
fs.writeFileSync(zipPath, Buffer.concat([...parts, cd, end]));
const version = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7);
fs.writeFileSync(path.join(SITE, 'version.json'), JSON.stringify({ commit: version, builtAt: new Date().toISOString(), files: files.length, bytes: fs.statSync(zipPath).size }, null, 2));
console.log(`Built ${zipPath} (${files.length} files, commit ${version})`);

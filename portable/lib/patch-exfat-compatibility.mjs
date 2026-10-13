// Windows exFAT: retain full file identity checks and publish by no-replace rename.
// Pinned to reviewed upstream bytes; unknown/partial vendor patches fail closed.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const hashes={
 'pinned-write.js':'c739599f4c75581438d3a2913f68db25ecb926f2556cf4df5eda80b685f36146',
 'root-write-verification.js':'52ff89d18ef177474bf063a3adf245dc9a1e32dac66f30d551b683a2f62121b6',
 'publish-copy-stage.js':'a1003721d5c21cb471837c2af92e74f0cb4226241735fc9213e23e881f9a144c',
};
const sha=s=>createHash('sha256').update(s).digest('hex');
export function patchExfatCompatibility(core) {
 const packageDir=path.join(core,'node_modules/@openclaw/fs-safe');
 if(JSON.parse(fs.readFileSync(path.join(packageDir,'package.json'))).version!=='0.24.2')throw Error('Unreviewed fs-safe version');
 if(JSON.parse(fs.readFileSync(path.join(core,'node_modules/openclaw/package.json'))).version!=='2026.10.2')throw Error('Unreviewed OpenClaw version');
 const base=path.join(packageDir,'dist');
 const changes=new Map();
 function patch(file,from,to){if(!changes.has(file))changes.set(file,[]);changes.get(file).push([from,to]);}
const gate='process.platform === "win32" && process.env.FS_SAFE_NATIVE_MODE === "off" && process.env.OPENCLAW_PORTABLE_RENAME_IDENTITY === "verify-content-with-lock"';
patch('pinned-write.js','if (renameIdentity !== "verify-content-with-lock") {',`if (renameIdentity !== "verify-content-with-lock" && !(renameIdentity === undefined && ${gate})) {`);
patch('root-write-verification.js','    let needsPathOpen = false;',`    // Rebase onto the same retained handle after exFAT rename. Never accept a different file on the volume.
    if (${gate}) {
        const current = fsSync.fstatSync(params.fd, { bigint: true });
        if (current.dev !== params.expectedIdentity.dev) throw new FsSafeError("path-mismatch", "write moved across volumes");
        params = { ...params, expectedIdentity: {dev: current.dev, ino: current.ino} };
    }
    let needsPathOpen = false;`);
patch('publish-copy-stage.js','import path from "node:path";',`import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";`);
patch('publish-copy-stage.js','    fs.linkSync(temporaryPath, targetPath);',`    let moved = false;
    let publishedIdentity = identity;
    try { fs.linkSync(temporaryPath, targetPath); }
    catch (error) {
        if (!(${gate}) || !["EISDIR", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error?.code)) throw error;
        if (path.dirname(temporaryPath) !== path.dirname(targetPath)) throw error;
        try {
            execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./uclaw-exfat-publish.ps1", import.meta.url)), "-Source", temporaryPath, "-Destination", targetPath], {windowsHide:true,timeout:15000,stdio:["ignore","pipe","pipe"]});
        } catch (cause) {
            if (String(cause.stderr).trim() === "183" || String(cause.stderr).trim() === "80") throw new FsSafeError("already-exists", "destination already exists");
            throw new FsSafeError("helper-failed", "exclusive rename failed", {cause});
        }
        moved = true;
        assertSyncDirectoryGuard(params.parentGuard);
        const opened = fs.fstatSync(params.fd, {bigint:true});
        const published = fs.lstatSync(targetPath, {bigint:true});
        if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n || opened.dev !== identity.dev || !sameFileIdentityForCleanup(opened,published)) throw new FsSafeError("path-mismatch", "exclusive rename identity changed");
        publishedIdentity = opened;
    }`);
patch('publish-copy-stage.js','params.onPublished?.(identity);','params.onPublished?.(publishedIdentity);');
patch('publish-copy-stage.js','    try {\n        const parent =',`    if (moved) {
        if (observerRejected) throw observerError;
        return;
    }
    try {
        const parent =`);
const helper = `param([string]$Source,[string]$Destination)
$ErrorActionPreference='Stop'
$sourcePath=[IO.Path]::GetFullPath($Source)
$destinationPath=[IO.Path]::GetFullPath($Destination)
if([IO.Path]::GetDirectoryName($sourcePath) -ne [IO.Path]::GetDirectoryName($destinationPath)){throw 'Same-directory publication required'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UClawExclusiveMove {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool MoveFileEx(string existingName, string newName, uint flags);
}
'@
if(-not [UClawExclusiveMove]::MoveFileEx($sourcePath,$destinationPath,8)){
 [Console]::Error.WriteLine([Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1
}
`;
 const prepared=[];
 for(const [file,replacements] of changes){
  const target=path.join(base,file),source=fs.readFileSync(target,'utf8');
  let restored=source;
  for(const [from,to] of [...replacements].reverse())restored=restored.replace(to,()=>from);
  if(replacements.every(([,to])=>source.split(to).length===2)&&sha(restored)===hashes[file])continue;
  if(sha(source)!==hashes[file])throw Error('Unreviewed vendor bytes: '+file);
  let output=source;
  for(const [from,to] of replacements){if(output.split(from).length!==2)throw Error('Unexpected anchor: '+file);output=output.replace(from,()=>to);}
  prepared.push([target,output]);
 }
 const helperPath=path.join(base,'uclaw-exfat-publish.ps1');
 if(fs.existsSync(helperPath)&&fs.readFileSync(helperPath,'utf8')!==helper)throw Error('Unreviewed exclusive rename helper');
 prepared.push([helperPath,helper]);
 for(const [target,output] of prepared){fs.writeFileSync(target+'.uclaw-stage',output);fs.renameSync(target+'.uclaw-stage',target);}
 return {version:'2026.10.2',files:prepared.map(([p])=>path.basename(p))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(patchExfatCompatibility(path.resolve(process.argv[2]))));

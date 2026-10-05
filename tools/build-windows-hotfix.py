"""Build a script/UI hotfix with the unchanged, checksum-pinned released runtime.

Usage: python tools/build-windows-hotfix.py --base-archive BASE.zip --output-dir DIR
The source checkout must be clean. The output contains only tracked portable
files and app/ from the official v2.2.5 archive, never local test data or runtimes.
"""
import argparse, hashlib, json, pathlib, shutil, subprocess, zipfile

BASE_TAG='v2.2.5'
BASE_SHA256='6754acbd9e591f15837eda73758681dfc5f44a9f49e7996d857c1cc8b4914ad9'
BASE_URL='https://github.com/dongsheng123132/u-claw/releases/download/v2.2.5/u-claw-portable-windows-v2.2.5.zip'

def sha256(path):
    with open(path,'rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def main():
    args=argparse.ArgumentParser(description=__doc__)
    args.add_argument('--base-archive',type=pathlib.Path,required=True)
    args.add_argument('--output-dir',type=pathlib.Path,required=True)
    options=args.parse_args()
    root=pathlib.Path(__file__).resolve().parent.parent
    def git(*arguments):return subprocess.check_output(['git',*arguments],cwd=root)
    if git('status','--porcelain').strip():raise SystemExit('Build requires a clean source checkout')
    revision=git('rev-parse','HEAD').decode().strip()
    tag='v'+(root/'VERSION').read_text(encoding='utf-8').strip()
    if not tag.startswith('v2.2.'):raise SystemExit('This builder is scoped to the 2.2.x hotfix line')
    pin=(root/'OPENCLAW_VERSION').read_text().strip()
    if pin!='2026.9.2' or (root/'portable/OPENCLAW_VERSION').read_text().strip()!=pin:
        raise SystemExit('Unchanged OpenClaw 2026.9.2 runtime required')
    if sha256(options.base_archive)!=BASE_SHA256:raise SystemExit('Official base archive SHA256 mismatch')
    options.output_dir.mkdir(parents=True,exist_ok=True)
    output=options.output_dir/('u-claw-portable-windows-'+tag+'.zip')
    if output.exists():raise SystemExit('Output already exists; do not overwrite a release artifact')
    prefix='u-claw-portable-windows-'+tag+'/'
    base_prefix='u-claw-portable-windows-'+BASE_TAG+'/'
    tracked=[pathlib.Path(p.decode('utf-8')) for p in git('ls-files','-z','--','portable/').split(b'\0') if p]
    source_manifest=[];runtime_count=0
    with zipfile.ZipFile(options.base_archive) as base, zipfile.ZipFile(output,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as target:
        package=json.loads(base.read(base_prefix+'app/core/node_modules/openclaw/package.json'))
        if package['version']!=pin:raise SystemExit('Base runtime version mismatch')
        for item in base.infolist():
            if not item.filename.startswith(base_prefix+'app/'):continue
            rel=pathlib.PurePosixPath(item.filename[len(base_prefix):])
            if rel.is_absolute() or '..' in rel.parts:raise SystemExit('Unsafe archive path')
            metadata=zipfile.ZipInfo(prefix+str(rel)+('/' if item.is_dir() else ''),item.date_time)
            metadata.compress_type=item.compress_type
            metadata.external_attr=item.external_attr
            metadata.create_system=item.create_system
            if item.is_dir():target.writestr(metadata,b'')
            else:
                with base.open(item) as src,target.open(metadata,'w') as dst:shutil.copyfileobj(src,dst,1024*1024)
                runtime_count+=1
                if runtime_count%10000==0:print(json.dumps({'runtimeFiles':runtime_count}),flush=True)
        for path in tracked:
            relative=path.relative_to('portable')
            if relative.parts[0] in {'app','data'}:raise SystemExit('Tracked runtime or user data is not allowed')
            payload=(root/path).read_bytes()
            if path.suffix.lower() in {'.bat','.cmd','.ps1','.sh','.command','.mjs','.js'}:
                text=payload.decode('utf-8-sig').replace('\r\n','\n').replace('\r','\n')
                payload=(text.replace('\n','\r\n') if path.suffix.lower() in {'.bat','.cmd','.ps1'} else text).encode('utf-8')
            target.writestr(prefix+relative.as_posix(),payload)
            source_manifest.append({'path':relative.as_posix(),'sha256':hashlib.sha256(payload).hexdigest()})
        target.writestr(prefix+'RELEASE-NOTES.md',(root/'docs/release-notes'/f'{tag}.md').read_bytes())
        target.writestr(prefix+'BUILD-INFO.json',json.dumps({'tag':tag,'sourceRevision':revision,'openclaw':pin,'node':'22.22.3','runtimeSource':BASE_URL,'runtimeSourceSha256':BASE_SHA256,'runtimeFiles':runtime_count,'portableFiles':source_manifest},ensure_ascii=False,indent=2)+'\n')
    with zipfile.ZipFile(output) as check:
        invalid=check.testzip()
        if invalid:raise SystemExit('Archive CRC failed: '+invalid)
    digest=sha256(output)
    output.with_suffix(output.suffix+'.sha256').write_text(digest+'  '+output.name+'\n',encoding='ascii')
    print(json.dumps({'archive':str(output),'bytes':output.stat().st_size,'sha256':digest,'sourceRevision':revision,'runtimeFiles':runtime_count,'portableFiles':len(source_manifest)}),flush=True)

if __name__=='__main__':main()

"""Archive a clean stage and verify CRC; never include test state."""
import pathlib, sys, zipfile
stage, output = map(pathlib.Path, sys.argv[1:])
if (stage/'data').exists():
    raise SystemExit('Refuse to publish a stage containing user/test data')
with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for path in sorted(stage.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(stage.parent))
with zipfile.ZipFile(output) as archive:
    bad = archive.testzip()
    if bad: raise SystemExit('CRC failed: ' + bad)

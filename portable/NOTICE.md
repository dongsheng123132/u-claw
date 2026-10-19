# Third-Party Notices

U-Claw's **Lite kernel** (`portable/app/picoclaw/picoclaw.exe`) is the third-party
**PicoClaw** Go binary, vendored as a frozen binary. It is not maintained by U-Claw
and is not automatically updated with OpenClaw.

| Item | Value |
|------|-------|
| Project | PicoClaw (upstream repository; our product name is not an upstream name) |
| Upstream | <https://github.com/sipeed/picoclaw> |
| Version | v0.3.1 (commit `2cf030d2fd3b871d7ec17e3be34c24688aac76da`) |
| License | **MIT** |
| Platform | windows-x64 only |
| Integrity | `portable/picoclaw-runtime.json` records both `sha256` (release zip) and `binary_sha256` (extracted `picoclaw.exe`). `setup.ps1` verifies the archive before extraction and the executable after extraction, without running third-party code. |

## License text (verbatim from the upstream `LICENSE`)

> MIT License
>
> Copyright (c) 2026 PicoClaw contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Integration boundaries

- U-Claw vendors the frozen binary, verifies its hashes, switches Lite/Full, and
  writes the shared wallet key into its data domain. Source is not modified.
- The Lite wallet key is stored **in plaintext** in `data/picoclaw/.security.yml`,
  readable by anyone who can read the USB drive. This is not encryption. If the
  drive is lost, rotate the wallet key to revoke the old credential.
- Backup/restore uses OpenClaw's native backup and therefore does not include
  `data/picoclaw`; re-enable the wallet after restoring into a fresh folder.

# Security

## Supported versions

Only the latest release gets security fixes: 0.1.x today. To update, run the installer from the
[README](README.md#install) again, download the release from the
[releases page](https://github.com/berttoli/mermdraw/releases), or run
`cargo install --git https://github.com/berttoli/mermdraw --force`.

The installers check what they download the same way `addons add` does (below): the SHA-256 against the release's
`SHA256SUMS.txt` always, and the build-provenance attestation when `gh` is installed and logged in. `curl … | sh` runs
the script as it arrives, so to check the installer itself, download `install.sh` first and verify it like an archive
([docs/RELEASING.md](docs/RELEASING.md#verifying-a-release)) before running it.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
[Security → Report a vulnerability](https://github.com/berttoli/mermdraw/security/advisories/new) on
`berttoli/mermdraw`. Don't open a public issue. Fixes ship in a new release, since published tags are never moved
(see [docs/RELEASING.md](docs/RELEASING.md)).

## Addons

`mermdraw addons add NAME` downloads a program and `mermdraw NAME` runs it with your permissions; addons are not
sandboxed. To limit what that trusts:

- **Official addons only.** `addons add` takes plain names (`a-z`, `0-9`, `-`) and downloads only from the releases
  of `github.com/berttoli/mermdraw-NAME` (or from `MERMDRAW_ADDONS_URL`, which you set yourself).
- **Checksum, always.** The archive's SHA-256 must match its line in the release's `SHA256SUMS.txt`, or nothing is
  installed. This catches corrupted and truncated downloads. It cannot catch a release that was replaced along with
  its checksum file, because both come from the same place.
- **Build provenance, when `gh` is installed.** `addons add` runs `gh attestation verify ARCHIVE -R
  berttoli/mermdraw-NAME`, which proves the archive was built by that repository's release workflow. If `gh` rejects
  it, nothing is installed. If [`gh`](https://cli.github.com) isn't installed or logged in, `addons add` says
  `attestation  not checked: …`, and only the checksum protected the download. Install and log in to `gh` to get this
  check.
- **Anything else is your choice.** `mermdraw NAME` also runs a `mermdraw-NAME` it finds on your `PATH`. mermdraw
  didn't install that program and doesn't check it; it's as trusted as anything else on your `PATH`.
  `mermdraw addons ls` shows where each addon comes from.

## The editor server

`mermdraw` serves the editor on your machine only:

- It listens on `127.0.0.1`, never on other interfaces.
- It answers only requests whose `Host` header is `127.0.0.1`, `localhost` or `[::1]`, which blocks DNS-rebinding
  attacks from web pages.
- It serves and writes files only inside the folder it serves: paths with `..`, absolute paths and symlinks that lead
  outside are refused. It writes only markdown (`.md`, `.markdown`) and mermaid (`.mmd`, `.mermaid`) files, and
  accepts only image uploads, which it stores in `assets/` next to the document.

The server has no login. Other programs and users on the same machine can reach its port while it runs, so stop it
(Ctrl+C) on shared machines when you're done.

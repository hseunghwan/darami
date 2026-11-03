# Plan: darami, a wiki app with no server

In dotoriwiki a memo travels from the phone to a gateway on a computer, and the gateway runs `claude -p` or `codex exec` to file it into the wiki. darami moves all of that into the Android app. The app logs in to ChatGPT with Codex's device-code OAuth, calls the model itself, and keeps the wiki in a folder on the phone. No computer, no Tailscale, no pairing.

## Decisions

Settled with the user on 2026-11-03.

| Question | Decision |
| --- | --- |
| Platform | Android only. dotoriwiki's Expo app becomes the whole product, in its own repository. |
| The gateway | Not carried over: the `dotoriwiki` npm command, install, pair, the HTTP and MCP endpoints, the Claude Code plugin, the feed collector. dotoriwiki stays as it is in its own repository. |
| Model | Codex only, through the user's ChatGPT login. No Claude. Anthropic's terms allow a Free, Pro, or Max OAuth login only in Claude Code and claude.ai, and making another app pass as Claude Code is out. |
| Wiki folder | A folder the user picks with Android's folder picker (SAF), so Obsidian or Syncthing can open the same folder. |
| History | No git. Each domain's `wiki/log.md` is the record. |
| Kept features | Text memos, routing, filing, held memos, the activity view, chat with the wiki and filing an answer, photos, article text for links. |
| Dropped features | Feeds, YouTube transcripts (they need `yt-dlp`), MCP and `/memo` from coding agents, `manual(...)` commits of hand edits. |

OpenAI has not published a policy that lets a third-party app use a ChatGPT login. The login works today and other tools use it, but the README must say that the app is for personal use and can break if OpenAI changes the endpoint.

## Done when

1. A fresh install logs in with a ChatGPT device code, picks a folder, writes a preset wiki there, and files a typed memo into the right domain with no computer involved.
2. A memo the model is unsure about waits as held until the user picks the domain.
3. The model can write only under `<domain>/wiki/` of the memo's domain. A test with a fake model that asks to write elsewhere gets refused, and nothing outside changes.
4. Chat answers questions from the wiki without changing any file, and filing an answer goes through the same confinement as ingest.
5. The same folder opened in Obsidian on the phone shows the pages, and a wiki dotoriwiki made opens in the app as it is.
6. The app has no gateway client left, and the README in English and Korean describes the app on its own.

## Facts this plan rests on

Checked against `openai/codex` on GitHub and Expo SDK 58 on 2026-11-03.

- **Device-code login.** POST `https://auth.openai.com/api/accounts/deviceauth/usercode` with `{client_id}` returns `device_auth_id`, `user_code`, and a poll `interval`. The user opens `https://auth.openai.com/codex/device` and types the code. Polling POST `.../deviceauth/token` with `{device_auth_id, user_code}` answers 403 or 404 until the user approves, then returns `authorization_code` and the PKCE `code_verifier`. The app exchanges the code at `https://auth.openai.com/oauth/token` with `redirect_uri` `https://auth.openai.com/deviceauth/callback`. Codex's client id is `app_EMoamEEZ73f0CkXaXp7hrann`. The code expires in 15 minutes. A personal account may have to allow device-code login in ChatGPT's security settings first.
- **Refresh.** The same token endpoint takes `grant_type=refresh_token`. Errors `refresh_token_expired`, `refresh_token_reused`, and `refresh_token_invalidated` mean the user must log in again.
- **Model endpoint.** Codex calls the Responses API at `https://chatgpt.com/backend-api/codex/responses` with the access token and the ChatGPT account id from the id token. P0 must find which other headers and request fields the endpoint requires, from a real call.
- **Folder access.** `Directory.pickDirectoryAsync()` in `expo-file-system` returns a SAF directory whose `File` and `Directory` objects read and write `content://` URIs.
- **Streaming.** The app already reads a streamed response body with `getReader()` in `src/lib/gateway.ts`, so the Responses SSE stream needs no new dependency.

## What P0 found

Checked on 2026-11-03, from Node on the Mac and from the app on an Android 16 emulator.

- The endpoint takes requests with `originator: darami`. Plain text, a strict `json_schema` answer, and a function call with its output sent back all work. The request carries `instructions` as a field. It needs `stream: true` and `store: false`.
- The models are the ones the ChatGPT plan lists at `GET /backend-api/codex/models`. On a Plus plan that was `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, and the `gpt-5.6` family. Any other model gets a 400 saying it is not supported with a ChatGPT account.
- Timings with `gpt-6-luna` on the phone: classify with low effort 3.3 s, a function call 1.5 s, the turn after its output 1.7 s.
- Device-code login works on the phone. The code answer has `interval` as a string and `expires_at` as an ISO date. The refresh takes JSON and returns a new refresh token, which the app saves.
- A bad token gets a 401 with a `detail` message. Rate limits were not hit, so their handling (`Retry-After`, then `resets_in_seconds`, then five minutes) is a guess until a real 429 is recorded.
- Never test a refresh with the tokens of a logged-in Codex CLI. A refresh token works once, so the CLI's login would break.

## What P1 found

Checked on 2026-11-03 under jest on Node 24.

- The engine in `src/core/` is dotoriwiki's formats and rules: config, ledger, pages, sources, text, the memo-file half of photos, and the path shapes. None of dotoriwiki's `WikiImpl` came along. Routing, jobs, held memos, the ledger append, index.md writing, and rollback are P3's to rebuild.
- The Fs port has one method, `readText`, which returns `null` when no file is there and throws on anything else, a folder included. Paths are `WikiPath`s, which only `layout.ts` makes, so an adapter never sees `..`. `src/core/wiki.ts` is the only caller. A method joins the port with the phase that first calls it:

| Method | First caller | What it must keep |
| --- | --- | --- |
| `list(dir)` | P2, to see whether the picked folder is empty. P3, for memo ids | NFC names, sorted, `[]` when the folder is missing. Core drops dot names, so `.stfolder` and `.obsidian/` stay invisible |
| `create(path, text)` returning `'created'` or `'exists'` | P2, to copy a preset. P3, to accept, route, and stage answers | Never overwrites. SAF's `createFile` renames on a clash to `x (1).md`, so the adapter checks the name it got and undoes a rename |
| `write(path, text)` | P3, for index.md and pages | Replaces the whole file through a temp file. A crash leaves the old text or the new, never a mix |
| `append(path, text)` | P3, for log.md | Adds whole lines |
| `remove(path)` | P3, to release a held memo | Does nothing when the file is absent |
| `listTree(dir)` | P3, for index.md and check()'s page names | `.md` paths under `dir`, NFC, sorted, dot segments dropped |
| `readBytes`, `writeBytes` | P6, for photos | |

- The port's contract says an adapter finds an NFD name on disk by its NFC path. The node adapter does not, because jest's fixtures are NFC. P2's SAF adapter must, for a folder synced from a Mac.
- `npm run typecheck` runs two programs. `tsconfig.app.json` is what the phone ships, with no ambient types, so `Buffer` in a core file and an app import of `src/fs/node` both fail it with TS2591. `tsconfig.json` is the whole repo with jest and node types. `src/core/__tests__/boundary.test.ts` checks what tsc cannot: core imports only itself and `yaml`, and uses no `import.meta`, `require`, or `process`.
- `yaml` is pinned to 2.9.1, dotoriwiki's version, because memo and page frontmatter is its `stringify` output. Under jest-expo it resolves to `dist/index.js` and runs with no `moduleNameMapper`. Metro should take `browser/`, the ESM build of the same source. P2's first device run confirms it.
- `node:assert/strict`'s `deepEqual` checks prototypes, and under jest an array from a Node built-in such as `readdirSync` is not the test's `Array`. Equal contents still fail. Copy such a value into a new array before comparing it.
- `src/core/__tests__/fixtures/made-by-dotoriwiki/` is a wiki dotoriwiki 91f0aac wrote, with feed, agent, photo, moved, held, and answer memos. `compat.test.ts` reads it back byte for byte. `scripts/make-dotoriwiki-fixture.ts <dotoriwiki-checkout>` makes it again, by hand, under Node 24.
- An `@` import in a CLAUDE.md that leaves the wiki folder, an absolute path included, now keeps its line as written. dotoriwiki inlined it from anywhere on the Mac.
- Config messages are dotoriwiki's words, so a few still say "gateway" or `models.json`. They change when P3 decides what `model_profile` names on the phone.
- P2's first emulator run must check what Hermes does with these, since jest ran them on Node's full ICU:
  - `/\p{Cc}/u` in config.ts's domain name check
  - `Intl.DateTimeFormat` with `timeZoneName: 'longOffset'` in `isoWithOffset`
  - `validTz`, which relies on `Intl` throwing for an unknown zone
  - `localeCompare(…, 'ko')` in `renderIndex`, where another order means index.md bytes that differ from dotoriwiki's
  - `String.prototype.normalize`
  - `TextEncoder` in `utf8Length`
  - `new URL` in `trimUrl`, since React Native's URL polyfill may accept links Node rejects
- P3 must keep reading what dotoriwiki wrote: `gateway stopped mid-job`, the reason on an interrupted attempt in log.md, the ledger words, the memo link labels, the problem rule names, and the `lint` job kind.
- `check()` takes no git words. P3 fills `changes` from the loop's record of its writes, as added, modified, or deleted, and `reviewBefore` from `_review.md` as it was when the job started.

## What P2 found

Checked on 2026-11-03 on the Android 16 emulator, with expo-file-system 58.0.13 and the external storage provider. A throwaway probe screen measured SAF first. Then `darami://fs-check` ran `src/fs/contract.ts` on SAF and passed 17 of 17 cases.

- A child built with `new File(dir, name)` resolves to the picked folder itself, without an error. The adapter builds each document URI from the tree id. This works only for `com.android.externalstorage.documents`, whose ids are `<volume>:<path>`. A folder from any other provider is refused when it is picked.
- `createFile` never fails on a clash. It renames the new file to `c.md (1)`, and it does the same for `C.md` next to `c.md`, because lookups ignore case. Lookups also ignore Unicode normalization: an NFC path finds an NFD name. `list()` returns names as stored, and the adapter turns them into NFC.
- A `null` MIME type turns `a.md` into `a.md.txt`. `application/octet-stream` keeps every name exactly.
- `write()` does not truncate. Writing `B` over `AAAAAAAAAA` gives `BAAAAAAAAA`. The adapter writes only through a handle opened with `FileMode.Truncate`.
- `File.delete()` on a folder deletes everything in it, and `rename()` throws. SAF therefore has no temp-then-rename write. The port's contract no longer promises atomic writes. `create` treats an empty file as a create cut off before its write and fills it.
- A revoked grant answers `exists` false and `list()` `[]`. Every method checks the root before it answers "nothing there", and throws `FolderUnreachable` when the root is gone.
- The grant survives `am force-stop` and a relaunch.
- Timing on the emulator: a file read takes about 19 ms, an existence check about 4 ms, and a walk of the 50 entries in `made-by-dotoriwiki` 682 ms. P3's search tool will likely need an index.
- Hermes gives the same results as Node for every check P1 listed: `/\p{Cc}/u`, `Intl` with `longOffset`, `validTz`, `localeCompare(…, 'ko')`, `normalize`, `TextEncoder`, and `new URL` in `trimUrl`. The emulator's own time zone is `GMT`, so a preset written there gets `time_zone: GMT`.
- On the emulator:
  - An empty folder holding only `.stfolder` got the 17 preset files, with `gitignore` renamed to `.gitignore` and no `(1)` or `.txt` names.
  - A copy of `made-by-dotoriwiki` showed its three domains and one `model_profile` warning, and its 37 files had the same hashes before and after.
  - A folder with other files was refused.
  - A half-written preset, with an emptied `CLAUDE.md` and a missing domain, was finished. The files already there were kept.
- Open for P3. `write` cannot replace a file through a temp file and a rename on SAF. It has two options. One is truncate-and-write guarded by the loop's reread before an edit. The other is a native `DocumentsContract.renameDocument` module, which needs one native build.
- Open risk. SD cards were not measured. If an SD card does not ignore normalization, an NFD name there needs a listing fallback.
- In a dev build, the LogBox warning banner sits over the bottom buttons and takes their taps. Tap the banner once to clear it before driving those buttons from adb.
- A Windows checkout with `core.autocrlf=true` writes CRLF into `presets/` and the fixtures. Files pushed from it to the emulator differ from the repository's bytes.

## Shape

```
src/
  core/      the wiki engine, ported from dotoriwiki's src/wiki/: config, layout, ledger, pages, sources, text, photos
             It sees files only through an Fs port and has no git and no node:* imports.
  fs/        Fs adapters: SAF for the phone, node:fs for jest
  codex/     login, token refresh, the Responses client, and the error mapping
  agent/     the tool loop: list, read, search, write, edit, finish
  jobs/      the queue in expo-sqlite: classify, ingest, file-answer, with attempts and retry-after
  app/, ui/  the screens, now reading local state instead of the gateway
```

The agent loop owns the tools, so confinement is code in the app rather than flags on a CLI. Every write path is resolved against the domain's `wiki/` folder and refused when it leaves it. The loop records each write, so the list of changed pages comes from the loop and not from `git status`. The verdict and page list come from a final `finish` tool call, which plays the role of `--json-schema`.

Jobs run while the app is open. A memo is on disk in `inbox/` as soon as the user sends it, so a job the OS kills is retried on the next launch. `expo-background-task` can run the queue now and then in the background, but the plan does not depend on it.

## Phases

Each phase ends in a check. A later phase starts only after the earlier one passes. App work runs on the Windows machine with the emulator.

| Phase | Change | Check |
| --- | --- | --- |
| P0 | Spike in `src/codex/`: device-code login, token storage in SecureStore, refresh, one classify call, and one tool-call round trip against the Codex endpoint. Record the request shape it accepts and the real error bodies for 401, 429, and an unknown model. | On the emulator: log in, classify a memo, and see one function call and its result go back and forth. If the endpoint refuses a non-Codex client, stop here and decide again with the user. |
| P1 | Port dotoriwiki's `src/wiki/` to `src/core/` behind an Fs port. Drop git, the file watcher, and the manual-edit commits. Port the tests that cover config, ledger, pages, sources, and text. | The ported tests pass under jest with the node Fs adapter, and they read the presets and the dotoriwiki wikis in `src/core/__tests__/fixtures/` unchanged. |
| P2 | The SAF Fs adapter. Onboarding asks for the folder, writes a preset if it is empty, and opens a wiki that is already there. The folder URI is saved. | On the emulator: pick an empty folder and get the preset. Pick a copy of a wiki dotoriwiki made and see its domains. A file manager shows the files. |
| P3 | The agent loop and the job queue: classify, hold, ingest with the ledger line, retries, and the unavailable states for rate limits and expired logins. | Unit tests with a fake model, including the confinement case. On the emulator, a typed memo lands in its domain's `wiki/` with one `log.md` line. |
| P4 | Rewire the screens: compose, activity, memo detail, held, and settings read the local queue and the wiki. Delete pairing, the outbox, and the gateway client. Settings show the login and the folder. | App tests pass. On the emulator the whole flow works with the network on, and a memo sent offline waits and is filed when the network returns. |
| P5 | Chat with read-only tools and streamed answers, and filing an answer through the ingest path. | A chat answer cites wiki pages and changes no file. A filed answer shows up as a page and a ledger line. |
| P6 | Photos: shrink to 2048 px with `expo-image-manipulator`, store them in `raw/`, and send them to the model as images. Links: fetch an article, extract its text, and attach it to the memo. | A memo with a photo and a link is filed with both. |
| P7 | Rewrite the README in English and Korean around the app and its Codex login. Move the author's live wiki to the phone folder. | CI builds a release APK. The README walkthrough works on a clean phone. |

P0 decides whether the plan stands, so nothing else starts before it passes. P1 keeps the on-disk format, `dotoriwiki.yaml` included, so a wiki dotoriwiki made and a wiki darami made stay the same thing.

## Risks

- **The endpoint is not public.** OpenAI can change the Codex endpoint, its required headers, or who may call it. The `codex/` module keeps all of that in one place, so a change lands in one file.
- **SAF is slow.** Listing and searching a large wiki through `content://` URIs can take seconds. The search tool may need an index of page titles and headings kept in SQLite.
- **Android stops the app.** A job cut off mid-edit can leave a page half updated. Writes go through a temp file and a rename where SAF allows it, and an interrupted job is retried from the memo.
- **Two writers.** Syncthing or Obsidian can change a page while a job runs. The loop rereads a page before each edit and fails the edit when the page changed under it.

## Source

Started from dotoriwiki `91f0aac`: its `app/` at the repository root, its `presets/`, and its app CI. The package id, launcher name, slug, and scheme are renamed to darami, so the app installs next to a dotoriwiki app. The engine in `src/core/` is ported in P1 from the same commit.

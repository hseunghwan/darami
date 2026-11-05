<p align="center">
  <img src="docs/assets/logo.svg" width="112" height="112" alt="darami">
</p>

<h1 align="center">darami</h1>

<p align="center"><b>Jot it down on your phone. darami files it into your wiki.</b></p>

<p align="center">
  <a href="https://github.com/hseunghwan/darami/releases/latest">Download</a> ·
  <a href="docs/guide.md">Guide</a> ·
  <a href="README.ko.md">한국어</a>
</p>

You write things down in a hurry and never sort them. darami sorts them for you.

Type a line, share a link, or take a photo on your Android phone. darami asks ChatGPT, signed in with your own account, where the memo belongs, and files it into a Markdown wiki in a folder on your phone. Open the same folder in Obsidian, or sync it with Syncthing. No server, no computer.

## How it works

1. **Capture.** Write a memo, or share text, links, and photos from any app.
2. **File.** darami picks the domain, such as journal, learning, someday, or one you add, and updates that domain's pages. It reads the articles your links point to, and records when and where each photo was taken.
3. **Ask.** Ask your wiki a question. The answer cites the pages it read, and you can save it back as a page.

## Why darami

- **Your files.** The wiki is plain Markdown in a folder you pick. darami has no server and no account of its own.
- **Your ChatGPT plan.** darami runs on the subscription you already have. Pick the model and effort for filing and for questions in Settings.
- **Nothing gets lost.** A memo is in the folder before the text box clears. A filing that breaks the wiki's rules is undone and tried again.
- **Your structure.** Add domains and change their page types in Settings. darami rewrites only the lines you changed in `dotoriwiki.yaml`.

## Get started

1. Download the APK from [Releases](https://github.com/hseunghwan/darami/releases/latest) and open it on your phone.
2. Log in to ChatGPT with a one-time code.
3. Pick an empty folder, such as one under Documents. darami writes a starter wiki in your phone's language.

Then write your first memo. The [guide](docs/guide.md) covers the rest.

## Good to know

- Android only. darami files memos while it is open on screen.
- Filing and questions count against your ChatGPT plan's usage limit.
- darami signs in the way the Codex app does and calls the Codex endpoint. OpenAI has published no policy for third-party apps that use a ChatGPT login, so darami may stop working if OpenAI changes that endpoint. It is meant for personal use.
- Memo text, the pages the model reads, and 1024 px copies of your photos go to OpenAI. [What leaves the phone](docs/guide.md#what-leaves-the-phone) has the full list.

## Built on dotoriwiki

darami grew out of [dotoriwiki](https://github.com/hseunghwan/dotoriwiki), which does the same job on a gateway on your computer. Both use the same wiki format, so each opens the other's wiki as it is. The name is 다람이, Korean for a little squirrel.

## Build from source

```sh
npm ci
npm run typecheck
npm test
```

The [guide](docs/guide.md#build-from-source) covers the APK build, signing, and the debug screens.

## License

MIT. See [LICENSE](LICENSE).

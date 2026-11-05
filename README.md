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

darami is an Android app that organizes notes, shared links, and photos into a Markdown wiki. It uses your ChatGPT account to classify each memo and update the relevant wiki pages.

The wiki lives in a folder on your phone. You can open it in Obsidian or sync it with Syncthing. No separate server or computer is needed.

## How it works

1. **Capture:** Write a memo or share text, links, and photos from another app.
2. **Organize:** darami files the memo under a domain, such as journal, learning, someday, or one you add, and updates its pages. It reads linked articles and records photo timestamps and locations.
3. **Ask:** Ask a question about your wiki. Answers cite the pages used, and you can save an answer as a wiki page.

## Files and settings

- The wiki is stored as Markdown files in a folder you choose. darami has no server or separate account.
- It uses your existing ChatGPT subscription. In Settings, you can choose the model and reasoning effort for organizing memos and answering questions separately.
- Each memo is saved to the folder before the text box clears. If an update violates the wiki's rules, darami rolls it back and retries.
- You can add domains and change page types in Settings. Only the lines you change are rewritten in `dotoriwiki.yaml`.

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

darami is based on [dotoriwiki](https://github.com/hseunghwan/dotoriwiki), which organizes memos through a gateway on your computer. Both apps use the same wiki format and can open each other's wikis. The name 다람이 refers to a little squirrel in Korean.

## Build from source

```sh
npm ci
npm run typecheck
npm test
```

The [guide](docs/guide.md#build-from-source) covers the APK build, signing, and the debug screens.

## License

MIT. See [LICENSE](LICENSE).

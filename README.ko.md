<p align="center">
  <img src="docs/assets/logo.svg" width="112" height="112" alt="다람이">
</p>

<h1 align="center">다람이 (darami)</h1>

<p align="center"><b>폰에 적어 두면, 다람이가 내 위키에 정리합니다.</b></p>

<p align="center">
  <a href="https://github.com/hseunghwan/darami/releases/latest">다운로드</a> ·
  <a href="docs/guide.ko.md">안내서</a> ·
  <a href="README.md">English</a>
</p>

급하게 적어 두고 정리는 못 하고 계신가요? 정리는 다람이가 합니다.

안드로이드 폰에서 한 줄을 적거나, 링크를 공유하거나, 사진을 찍으세요. 다람이는 내 계정으로 로그인한 ChatGPT에게 메모가 어디에 속하는지 묻고, 폰 안 폴더에 있는 Markdown 위키에 정리합니다. 같은 폴더를 Obsidian으로 열거나 Syncthing으로 동기화할 수 있습니다. 서버도 컴퓨터도 필요 없습니다.

## 이렇게 동작합니다

1. **적기.** 메모를 쓰거나, 다른 앱에서 글, 링크, 사진을 공유합니다.
2. **정리.** 다람이가 일상, 스터디, 미루기 아카이빙, 또는 내가 더한 도메인 중 하나를 고르고, 그 도메인의 페이지를 고칩니다. 링크가 가리키는 글을 읽고, 사진마다 찍은 때와 장소를 남깁니다.
3. **묻기.** 위키에 질문합니다. 답에는 읽은 페이지가 함께 나오고, 답을 페이지로 저장할 수도 있습니다.

## 왜 다람이인가

- **내 파일.** 위키는 내가 고른 폴더 안의 평범한 Markdown입니다. 다람이에는 따로 서버도 계정도 없습니다.
- **내 ChatGPT 요금제.** 이미 쓰고 있는 구독으로 돕니다. 정리와 질문에 쓸 모델과 추론 강도는 설정에서 고릅니다.
- **잃어버리지 않습니다.** 입력창이 비워지기 전에 메모가 폴더에 저장됩니다. 위키 규칙을 어긴 정리는 되돌리고 다시 시도합니다.
- **내 구조.** 설정에서 도메인을 더하고 페이지 종류를 바꿉니다. 다람이는 `dotoriwiki.yaml`에서 바꾼 줄만 고칩니다.

## 시작하기

1. [Releases](https://github.com/hseunghwan/darami/releases/latest)에서 APK를 받아 폰에서 엽니다.
2. 한 번 쓰는 코드로 ChatGPT에 로그인합니다.
3. Documents 아래처럼 빈 폴더를 고릅니다. 다람이가 폰 언어로 시작용 위키를 만듭니다.

이제 첫 메모를 쓰면 됩니다. 나머지는 [안내서](docs/guide.ko.md)에 있습니다.

## 알아 두세요

- 안드로이드 전용입니다. 다람이는 앱이 화면에 열려 있을 때 메모를 정리합니다.
- 정리와 질문은 ChatGPT 요금제의 사용 한도에 포함됩니다.
- 다람이는 Codex 앱과 같은 방식으로 로그인하고 Codex 엔드포인트를 부릅니다. OpenAI는 ChatGPT 로그인을 쓰는 서드파티 앱에 대한 정책을 내놓은 적이 없어서, OpenAI가 엔드포인트를 바꾸면 다람이는 멈출 수 있습니다. 개인용으로 만들었습니다.
- 메모 내용, 모델이 읽는 페이지, 1024 px로 줄인 사진은 OpenAI로 갑니다. 전체 목록은 [폰 밖으로 나가는 것](docs/guide.ko.md#폰-밖으로-나가는-것)에 있습니다.

## dotoriwiki에서 나왔습니다

다람이는 [dotoriwiki](https://github.com/hseunghwan/dotoriwiki)에서 나왔습니다. dotoriwiki는 같은 일을 내 컴퓨터의 게이트웨이에서 합니다. 둘은 위키 형식이 같아서 서로의 위키를 그대로 엽니다.

## 소스에서 빌드하기

```sh
npm ci
npm run typecheck
npm test
```

APK 빌드, 서명, 디버그 화면은 [안내서](docs/guide.ko.md#소스에서-빌드하기)에 있습니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 보세요.

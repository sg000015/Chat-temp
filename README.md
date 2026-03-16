# iframe chat widget

이 프로젝트는 **부모 페이지 없이**, 외부 사이트가 `iframe`으로 불러 쓰는 채팅 화면만 제공합니다.

핵심 조건은 아래와 같습니다.

- 부모 페이지가 사용자 닉네임을 알고 있음
- 부모 페이지가 `iframe`에 닉네임을 전달함
- 이 프로젝트는 그 닉네임을 받아 채팅 입장 처리만 담당함
- 부모 페이지에 닉네임이 없으면 iframe 내부에서 직접 입력 가능
- 정적 배포가 가능해야 함

## 왜 Socket.IO 서버를 빼는가

`Socket.IO` 자체는 무료 오픈소스입니다. 유료 구독이 필요한 것은 아닙니다.

다만, `Socket.IO`를 쓰려면 **계속 실행 중인 서버(Node 서버 등)** 가 필요합니다.

- GitHub Pages: 정적 파일만 배포 가능, 서버 실행 불가
- S3 정적 웹 호스팅: 정적 파일만 배포 가능, 서버 실행 불가

즉, **GitHub Pages 또는 S3만으로는 Socket.IO 채팅 서버를 운영할 수 없습니다.**

그래서 이 프로젝트는 정적 배포와 궁합이 맞는 **Firebase Realtime Database** 방식으로 바꿨습니다.

## 비용

### 1. Socket.IO

- 라이브러리 자체는 무료
- 하지만 서버 호스팅 비용은 별도
- 무료만 원하면 GitHub Pages/S3 단독으로는 불가능

### 2. Firebase Realtime Database

- 무료 티어(Spark 플랜) 존재
- 소규모 테스트/개발용으로 충분한 경우가 많음
- 사용량이 많아지면 비용 발생 가능

초기 테스트 기준으로는 가장 현실적인 무료 선택지입니다.

## 파일 설명

- `chat.html`: 부모가 iframe으로 불러올 실제 채팅 페이지
- `app.js`: 부모와의 연동, Realtime Database 실시간 채팅 로직
- `styles.css`: 채팅 UI 스타일
- `firebase-config.js`: Firebase 프로젝트 연결 정보

## 1. Firebase 프로젝트 만들기

1. Firebase 콘솔에 접속합니다.
2. 새 프로젝트를 만듭니다.
3. Web 앱을 추가합니다.
4. Realtime Database를 생성합니다.
5. `firebase-config.js`에 발급된 값을 넣습니다.
6. 이미지 첨부를 쓰려면 Firebase Storage도 활성화합니다.

예시:

```js
export const firebaseConfig = {
  apiKey: "발급값",
  authDomain: "발급값",
  databaseURL: "발급값",
  projectId: "발급값",
  storageBucket: "발급값",
  messagingSenderId: "발급값",
  appId: "발급값",
};
```

## 2. Realtime Database 규칙 예시

테스트용으로는 아래처럼 시작할 수 있습니다.

```txt
{
  "rules": {
    "chatRooms": {
      ".read": true,
      ".write": true
    }
  }
}
```

주의: 운영 전환 시에는 반드시 인증 또는 도메인 제한 규칙으로 강화해야 합니다.

이미지 첨부는 메시지 메타데이터만 Realtime Database에 저장하고, 실제 파일은 Firebase Storage에 저장합니다.

## 3. Firebase Storage 규칙 예시

테스트용 예시는 아래처럼 시작할 수 있습니다.

```txt
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /chatRooms/{roomId}/attachments/{allPaths=**} {
      allow read, write: if true;
    }
  }
}
```

주의: 이것도 테스트용입니다. 운영에서는 인증 또는 업로드 경로 제한이 필요합니다.

## 4. 부모 페이지에서 iframe으로 호출하는 방법

부모 페이지는 이 프로젝트를 배포한 URL을 iframe `src`로 사용합니다.

```html
<iframe
  id="chat-frame"
  src="https://your-id.github.io/chat/chat.html"
  width="100%"
  height="720"
  style="border:0"
></iframe>
```

### 권장 방식: postMessage

크로스 오리진에서도 안전하게 동작시키려면 `postMessage`를 쓰는 것이 맞습니다.

```html
<script>
  const frame = document.getElementById("chat-frame");

  window.addEventListener("message", (event) => {
    if (event.origin !== "https://your-id.github.io") {
      return;
    }

    if (event.data?.type === "CHAT_WIDGET_READY") {
      frame.contentWindow.postMessage(
        {
          type: "CHAT_INIT",
          nickname: "홍길동",
          roomId: "main-room",
        },
        "https://your-id.github.io",
      );
    }
  });
</script>
```

### 같은 출처일 때만 가능한 방식: 함수 호출

부모 페이지와 iframe이 같은 출처라면 아래도 가능합니다.

```html
<script>
  const frame = document.getElementById("chat-frame");

  function openChatWithNickname(nickname) {
    frame.contentWindow.setChatUser({
      nickname,
      roomId: "main-room",
    });
  }
</script>
```

이 프로젝트 내부에서는 아래 전역 함수를 제공합니다.

```js
window.setChatUser({
  nickname: "홍길동",
  roomId: "main-room",
});
```

## 5. 부모 허용 도메인 제한

`firebase-config.js`의 `allowedParentOrigins`를 수정하면 `postMessage`를 받을 부모 도메인을 제한할 수 있습니다.

예시:

```js
export const chatSettings = {
  collectionName: "chatRooms",
  defaultRoomId: "default-room",
  allowedParentOrigins: [
    "https://service.example.com",
    "https://admin.example.com",
  ],
};
```

테스트 중에는 `"*"`로 두고, 운영에서는 실제 도메인만 넣는 것이 맞습니다.

## 6. GitHub Pages 배포

1. GitHub 저장소를 만듭니다.
2. 현재 파일들을 푸시합니다.
3. GitHub 저장소의 Pages 기능을 켭니다.
4. 브랜치 루트를 배포 대상으로 선택합니다.
5. 발급된 URL의 `chat.html`을 iframe `src`로 사용합니다.

예시:

```txt
https://your-id.github.io/chat/chat.html
```

## 7. S3 배포

정적 웹 호스팅으로도 배포 가능합니다.

- `chat.html`, `app.js`, `styles.css`, `firebase-config.js` 업로드
- 버킷 정적 웹 호스팅 활성화
- 공개 읽기 또는 CloudFront 설정

이 경우에도 채팅 실시간 기능은 Firebase가 담당합니다.

## 로컬 확인

```bash
npm run preview
```

그 뒤 브라우저에서 로컬 주소의 `chat.html`을 열어 확인하면 됩니다.

## 다음에 꼭 해야 하는 것

1. `firebase-config.js` 값 입력
2. Realtime Database와 Firebase Storage 보안 규칙 설정
3. `allowedParentOrigins`를 실제 부모 도메인으로 제한
4. 운영용으로는 스팸 방지 정책 추가

## 이미지 첨부 동작

- 이미지 파일만 업로드 가능
- 1MB 이하 파일만 허용
- 앱이 열릴 때와 주기적으로 만료 파일을 삭제 시도

정확히 72시간 시점에 무조건 삭제되어야 한다면, 클라이언트 정리만으로는 부족할 수 있습니다. 그 경우에는 Cloud Storage Lifecycle 또는 스케줄된 Cloud Function을 함께 쓰는 것이 맞습니다.

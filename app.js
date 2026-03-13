import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  get,
  getDatabase,
  limitToLast,
  off,
  onDisconnect,
  onValue,
  orderByChild,
  push,
  query,
  serverTimestamp,
  ref,
  remove,
  set,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { firebaseConfig, chatSettings } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

const statusBanner = document.getElementById("status-banner");
const roomLabel = document.getElementById("room-label");
const presenceLabel = document.getElementById("presence-label");
const nicknameLabel = document.getElementById("nickname-label");
const nicknameForm = document.getElementById("nickname-form");
const nicknameInput = document.getElementById("nickname-input");
const nicknameButton = document.getElementById("nickname-button");
const nicknameHelp = document.getElementById("nickname-help");
const messageList = document.getElementById("message-list");
const userList = document.getElementById("user-list");
const emptyUsers = document.getElementById("empty-users");
const chatForm = document.getElementById("chat-form");
const messageInput = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");

const state = {
  sessionId:
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  nickname: "",
  roomId: chatSettings.defaultRoomId,
  messageQueryRef: null,
  presenceQueryRef: null,
  ownPresenceRef: null,
  joined: false,
};

function hasPlaceholderConfig() {
  return Object.values(firebaseConfig).some((value) =>
    String(value).includes("REPLACE_ME"),
  );
}

function allowedOrigin(origin) {
  if (!origin) {
    return false;
  }

  if (chatSettings.allowedParentOrigins.includes("*")) {
    return true;
  }

  return chatSettings.allowedParentOrigins.includes(origin);
}

function formatTime(dateValue) {
  if (!dateValue) {
    return "--:--";
  }

  const date =
    typeof dateValue.toDate === "function"
      ? dateValue.toDate()
      : new Date(dateValue);

  return date.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function setComposerEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendButton.disabled = !enabled;
}

function setNicknameEntryEnabled(enabled) {
  nicknameInput.disabled = !enabled;
  nicknameButton.disabled = !enabled;
  nicknameHelp.textContent = enabled
    ? "부모 페이지에서 닉네임이 없으면 여기서 직접 입력할 수 있습니다."
    : "닉네임이 설정되어 채팅방에 입장했습니다.";
}

function clearSubscriptions() {
  if (state.messageQueryRef) {
    off(state.messageQueryRef);
    state.messageQueryRef = null;
  }

  if (state.presenceQueryRef) {
    off(state.presenceQueryRef);
    state.presenceQueryRef = null;
  }
}

function renderMessages(entries) {
  messageList.innerHTML = "";

  entries.forEach((entry) => {
    const item = document.createElement("article");
    const classes = ["message"];

    if (entry.type === "system") {
      classes.push("system");
    }

    if (entry.nickname && entry.nickname === state.nickname) {
      classes.push("mine");
    }

    item.className = classes.join(" ");

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.innerHTML = `<span>${entry.type === "system" ? "시스템" : entry.nickname}</span><span>${formatTime(entry.createdAt)}</span>`;

    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = entry.text;

    item.append(meta, body);
    messageList.appendChild(item);
  });

  messageList.scrollTop = messageList.scrollHeight;
}

function renderUsers(entries) {
  userList.innerHTML = "";
  emptyUsers.hidden = entries.length > 0;
  presenceLabel.textContent = `참여자 ${entries.length}명`;

  entries.forEach((entry) => {
    const element = document.createElement("div");
    element.className = "user-item";
    element.textContent =
      entry.nickname === state.nickname
        ? `${entry.nickname} (나)`
        : entry.nickname;
    userList.appendChild(element);
  });
}

function roomPath(path) {
  return `${chatSettings.collectionName}/${state.roomId}/${path}`;
}

async function writeSystemMessage(text) {
  await push(ref(database, roomPath("messages")), {
    type: "system",
    text,
    createdAt: serverTimestamp(),
  });
}

function subscribeRoom() {
  clearSubscriptions();

  state.messageQueryRef = query(
    ref(database, roomPath("messages")),
    orderByChild("createdAt"),
    limitToLast(100),
  );
  onValue(state.messageQueryRef, (snapshot) => {
    const entries = [];

    snapshot.forEach((messageSnapshot) => {
      entries.push({ id: messageSnapshot.key, ...messageSnapshot.val() });
    });

    renderMessages(entries);
  });

  state.presenceQueryRef = query(
    ref(database, roomPath("presence")),
    orderByChild("nickname"),
  );
  onValue(state.presenceQueryRef, (snapshot) => {
    const entries = [];

    snapshot.forEach((presenceSnapshot) => {
      entries.push({ id: presenceSnapshot.key, ...presenceSnapshot.val() });
    });

    renderUsers(entries);
  });
}

async function registerPresence() {
  if (state.ownPresenceRef) {
    await remove(state.ownPresenceRef);
  }

  state.ownPresenceRef = ref(
    database,
    `${roomPath("presence")}/${state.sessionId}`,
  );

  await set(state.ownPresenceRef, {
    sessionId: state.sessionId,
    nickname: state.nickname,
    updatedAt: serverTimestamp(),
  });

  await onDisconnect(state.ownPresenceRef).remove();
}

async function activateUser(payload) {
  const nickname = String(payload.nickname || "")
    .trim()
    .slice(0, 20);
  const roomId = String(payload.roomId || chatSettings.defaultRoomId)
    .trim()
    .slice(0, 50);

  if (!nickname) {
    statusBanner.textContent =
      "닉네임이 없습니다. 부모 페이지에서 전달하거나 아래에서 직접 입력하세요.";
    nicknameInput.focus();
    return;
  }

  if (hasPlaceholderConfig()) {
    statusBanner.textContent =
      "firebase-config.js 값을 먼저 입력해야 채팅이 동작합니다.";
    return;
  }

  const changedIdentity =
    state.nickname !== nickname || state.roomId !== roomId;

  state.nickname = nickname;
  state.roomId = roomId || chatSettings.defaultRoomId;
  state.joined = true;

  nicknameLabel.textContent = `${state.nickname} 님으로 연결됨`;
  roomLabel.textContent = `room: ${state.roomId}`;
  statusBanner.textContent = `${state.nickname} 님이 채팅방에 연결되었습니다.`;
  setComposerEnabled(true);
  setNicknameEntryEnabled(false);
  nicknameInput.value = state.nickname;
  subscribeRoom();
  await registerPresence();

  if (changedIdentity) {
    const alreadyWelcomedRef = ref(
      database,
      `${chatSettings.collectionName}/${state.roomId}/welcomeFlags/${state.sessionId}`,
    );
    const alreadyWelcomedSnapshot = await get(alreadyWelcomedRef);

    if (!alreadyWelcomedSnapshot.exists()) {
      await writeSystemMessage(`${state.nickname} 님이 입장했습니다.`);
      await set(alreadyWelcomedRef, { seenAt: serverTimestamp() });
    }
  }
}

window.setChatUser = (payload) => {
  activateUser(payload).catch((error) => {
    console.error(error);
    statusBanner.textContent = "사용자 정보 처리 중 오류가 발생했습니다.";
  });
};

window.addEventListener("message", (event) => {
  if (!allowedOrigin(event.origin)) {
    return;
  }

  if (!event.data || event.data.type !== "CHAT_INIT") {
    return;
  }

  window.setChatUser(event.data);
});

nicknameForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const nickname = nicknameInput.value.trim();

  window.setChatUser({
    nickname,
    roomId: state.roomId || chatSettings.defaultRoomId,
  });
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!state.joined) {
    return;
  }

  const text = messageInput.value.trim().slice(0, 300);

  if (!text) {
    return;
  }

  await push(ref(database, roomPath("messages")), {
    type: "chat",
    nickname: state.nickname,
    text,
    createdAt: serverTimestamp(),
  });

  messageInput.value = "";
  messageInput.focus();
  if (state.ownPresenceRef) {
    await set(state.ownPresenceRef, {
      sessionId: state.sessionId,
      nickname: state.nickname,
      updatedAt: serverTimestamp(),
    });
  }
});

window.addEventListener("beforeunload", () => {
  if (state.ownPresenceRef) {
    remove(state.ownPresenceRef);
  }
  clearSubscriptions();
});

setComposerEnabled(false);
setNicknameEntryEnabled(true);

if (hasPlaceholderConfig()) {
  statusBanner.textContent = "firebase-config.js 를 먼저 설정해야 합니다.";
  nicknameInput.disabled = true;
  nicknameButton.disabled = true;
}

if (window.parent && window.parent !== window) {
  window.parent.postMessage({ type: "CHAT_WIDGET_READY" }, "*");
}

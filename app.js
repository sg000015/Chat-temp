import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase,
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
const participantsMiniCount = document.getElementById(
  "participants-mini-count",
);
const nicknameModal = document.getElementById("nickname-modal");
const nicknameForm = document.getElementById("nickname-form");
const nicknameInput = document.getElementById("nickname-input");
const nicknameButton = document.getElementById("nickname-button");
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
  joinedAt: 0,
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

function showStatus(message) {
  if (!message) {
    statusBanner.textContent = "";
    statusBanner.classList.add("hidden");
    return;
  }

  statusBanner.textContent = message;
  statusBanner.classList.remove("hidden");
}

function setComposerEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendButton.disabled = !enabled;
}

function setNicknameModalVisible(visible) {
  nicknameModal.classList.toggle("hidden", !visible);
  nicknameInput.disabled = !visible;
  nicknameButton.disabled = !visible;

  if (visible) {
    setTimeout(() => {
      nicknameInput.focus();
    }, 0);
  }
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

    const author = document.createElement("span");
    author.className = "message-author";
    author.textContent =
      entry.type === "system" ? "시스템:" : `${entry.nickname}:`;

    const text = document.createElement("span");
    text.className = "message-text";
    text.textContent = entry.text;

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(entry.createdAt);

    item.append(author, text, time);
    messageList.appendChild(item);
  });

  messageList.scrollTop = messageList.scrollHeight;
}

function renderUsers(entries) {
  userList.innerHTML = "";
  emptyUsers.hidden = entries.length > 0;
  participantsMiniCount.textContent = String(entries.length);

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

function subscribeRoom() {
  clearSubscriptions();

  state.messageQueryRef = query(
    ref(database, roomPath("messages")),
    orderByChild("createdAt"),
  );
  onValue(state.messageQueryRef, (snapshot) => {
    const entries = [];

    snapshot.forEach((messageSnapshot) => {
      const entry = { id: messageSnapshot.key, ...messageSnapshot.val() };

      if (entry.type === "system") {
        return;
      }

      if (!entry.createdAt || entry.createdAt < state.joinedAt) {
        return;
      }

      entries.push(entry);
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
    setNicknameModalVisible(true);
    return;
  }

  if (hasPlaceholderConfig()) {
    showStatus("Firebase 설정이 필요합니다.");
    return;
  }

  const changedIdentity =
    state.nickname !== nickname || state.roomId !== roomId;

  state.nickname = nickname;
  state.roomId = roomId || chatSettings.defaultRoomId;
  state.joinedAt = Date.now();
  state.joined = true;

  showStatus("");
  setComposerEnabled(true);
  setNicknameModalVisible(false);
  nicknameInput.value = "";
  subscribeRoom();
  await registerPresence();
}

window.setChatUser = (payload) => {
  activateUser(payload).catch((error) => {
    console.error(error);
    showStatus("사용자 정보 처리 중 오류가 발생했습니다.");
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
setNicknameModalVisible(false);
showStatus("");

if (hasPlaceholderConfig()) {
  showStatus("Firebase 설정이 필요합니다.");
} else {
  setTimeout(() => {
    if (!state.joined && !state.nickname) {
      setNicknameModalVisible(true);
    }
  }, 300);
}

if (window.parent && window.parent !== window) {
  window.parent.postMessage({ type: "CHAT_WIDGET_READY" }, "*");
}

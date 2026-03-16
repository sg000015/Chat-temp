import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  endAt,
  get,
  getDatabase,
  limitToLast,
  off,
  onDisconnect,
  onValue,
  orderByChild,
  push,
  query,
  startAt,
  serverTimestamp,
  ref,
  remove,
  set,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  deleteObject,
  getDownloadURL,
  getStorage,
  ref as storageRef,
  uploadBytes,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { firebaseConfig, chatSettings } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const storage = getStorage(app);

const attachmentMaxBytes = Number.isFinite(chatSettings.attachmentMaxBytes)
  ? chatSettings.attachmentMaxBytes
  : 1024 * 1024;
const attachmentTtlMs = Number.isFinite(chatSettings.attachmentTtlMs)
  ? chatSettings.attachmentTtlMs
  : 3 * 24 * 60 * 60 * 1000;
const expiredAttachmentCleanupIntervalMs = Number.isFinite(
  chatSettings.expiredAttachmentCleanupIntervalMs,
)
  ? chatSettings.expiredAttachmentCleanupIntervalMs
  : 5 * 60 * 1000;

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
const attachmentInput = document.getElementById("attachment-input");
const attachmentButton = document.getElementById("attachment-button");
const sendButton = document.getElementById("send-button");
const callCommandPattern = /^\/call\s+(.+)$/i;
const whisperCommandPattern = /^\/w\s+(\S+)\s+([\s\S]+)$/i;
const blockedAttachmentMimeTypes = new Set(["image/svg+xml"]);
const allowedAttachmentExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
]);

const state = {
  sessionId:
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  nickname: "",
  roomId: chatSettings.defaultRoomId,
  joinedAt: 0,
  serverTimeOffset: 0,
  initialMessageQueryRef: null,
  liveMessageQueryRef: null,
  presenceQueryRef: null,
  ownPresenceRef: null,
  initialMessages: [],
  liveMessages: [],
  localMessages: [],
  heartbeatTimerId: null,
  expiredAttachmentCleanupTimerId: null,
  pendingPresenceCleanup: new Set(),
  pendingAttachmentCleanup: new Set(),
  notifiedCallMessageIds: new Set(),
  activeNicknames: new Set(),
  audioContext: null,
  composerEnabled: false,
  uploadingAttachment: false,
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
    return;
  }

  state.localMessages.push({
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "system",
    systemType: "local-notice",
    text: message,
    createdAt: Date.now(),
  });

  renderMergedMessages();
}

function setComposerEnabled(enabled) {
  state.composerEnabled = enabled;
  syncComposerState();
}

function syncComposerState() {
  const enabled = state.composerEnabled && !state.uploadingAttachment;
  messageInput.disabled = !enabled;
  sendButton.disabled = !enabled;
  attachmentButton.disabled = !enabled;
  attachmentInput.disabled = !state.composerEnabled;
}

function setAttachmentUploading(uploading) {
  state.uploadingAttachment = uploading;
  attachmentButton.textContent = uploading ? "업로드 중..." : "이미지";
  syncComposerState();
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
  if (state.initialMessageQueryRef) {
    off(state.initialMessageQueryRef);
    state.initialMessageQueryRef = null;
  }

  if (state.liveMessageQueryRef) {
    off(state.liveMessageQueryRef);
    state.liveMessageQueryRef = null;
  }

  if (state.presenceQueryRef) {
    off(state.presenceQueryRef);
    state.presenceQueryRef = null;
  }

  state.initialMessages = [];
  state.liveMessages = [];
  state.localMessages = [];
  state.notifiedCallMessageIds.clear();
  state.activeNicknames.clear();
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return "0KB";
  }

  if (size >= 1024 * 1024) {
    const sizeInMb = size / (1024 * 1024);
    const roundedSizeInMb = Number.isInteger(sizeInMb)
      ? sizeInMb
      : Number(sizeInMb.toFixed(2));
    return `${roundedSizeInMb}MB`;
  }

  return `${Math.max(1, Math.round(size / 1024))}KB`;
}

function sanitizeFileName(fileName) {
  return String(fileName || "image")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function resetAttachmentInput() {
  attachmentInput.value = "";
}

function getFileExtension(fileName) {
  const parts = String(fileName || "")
    .toLowerCase()
    .split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function isAllowedAttachment(file) {
  const extension = getFileExtension(file?.name);

  if (!extension || !allowedAttachmentExtensions.has(extension)) {
    return false;
  }

  if (blockedAttachmentMimeTypes.has(file?.type)) {
    return false;
  }

  return file?.type ? file.type.startsWith("image/") : true;
}

function getEstimatedServerNow() {
  return Date.now() + state.serverTimeOffset;
}

function normalizeMessages(snapshot, minimumCreatedAt = 0) {
  const entries = [];

  snapshot.forEach((messageSnapshot) => {
    const entry = { id: messageSnapshot.key, ...messageSnapshot.val() };

    if (!entry.createdAt || entry.createdAt < minimumCreatedAt) {
      return;
    }

    if (!isMessageVisible(entry)) {
      return;
    }

    if (isAttachmentExpired(entry)) {
      return;
    }

    entries.push(entry);
  });

  return entries;
}

function isMessageVisible(entry) {
  if (entry.type !== "whisper") {
    return true;
  }

  return (
    entry.nickname === state.nickname || entry.targetNickname === state.nickname
  );
}

function isAttachmentExpired(entry) {
  return (
    entry.type === "image" &&
    typeof entry.expiresAt === "number" &&
    entry.expiresAt <= getEstimatedServerNow()
  );
}

function renderMergedMessages() {
  const mergedEntries = new Map();

  [
    ...state.initialMessages,
    ...state.liveMessages,
    ...state.localMessages,
  ].forEach((entry) => {
    mergedEntries.set(entry.id, entry);
  });

  const entries = [...mergedEntries.values()].sort(
    (left, right) => left.createdAt - right.createdAt,
  );

  renderMessages(entries);
}

function ensureAudioContext() {
  if (state.audioContext) {
    return state.audioContext;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    return null;
  }

  state.audioContext = new AudioContextClass();
  return state.audioContext;
}

async function unlockAudioContext() {
  const audioContext = ensureAudioContext();

  if (!audioContext || audioContext.state === "running") {
    return;
  }

  try {
    await audioContext.resume();
  } catch (error) {
    console.error(error);
  }
}

function playCallAlert() {
  const audioContext = ensureAudioContext();

  if (!audioContext || audioContext.state !== "running") {
    return;
  }

  const now = audioContext.currentTime;
  const masterGain = audioContext.createGain();
  masterGain.gain.setValueAtTime(0.0001, now);
  masterGain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
  masterGain.connect(audioContext.destination);

  [
    { frequency: 880, start: now, duration: 0.23 },
    { frequency: 659.25, start: now + 0.32, duration: 0.42 },
  ].forEach((note) => {
    const oscillator = audioContext.createOscillator();
    const noteGain = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, note.start);

    noteGain.gain.setValueAtTime(0.0001, note.start);
    noteGain.gain.exponentialRampToValueAtTime(1, note.start + 0.02);
    noteGain.gain.exponentialRampToValueAtTime(
      0.0001,
      note.start + note.duration,
    );

    oscillator.connect(noteGain);
    noteGain.connect(masterGain);
    oscillator.start(note.start);
    oscillator.stop(note.start + note.duration);
  });
}

function notifyTargetedCalls(entries) {
  const targetedCalls = entries.filter(
    (entry) =>
      entry.type === "system" &&
      entry.systemType === "call" &&
      entry.targetNickname === state.nickname &&
      !state.notifiedCallMessageIds.has(entry.id),
  );

  if (targetedCalls.length === 0) {
    return;
  }

  targetedCalls.forEach((entry) => {
    state.notifiedCallMessageIds.add(entry.id);
  });

  unlockAudioContext().finally(() => {
    playCallAlert();
  });
}

function parseCallCommand(text) {
  const matched = text.match(callCommandPattern);

  if (!matched) {
    return null;
  }

  const targetNickname = matched[1].trim().slice(0, 20);
  return targetNickname || null;
}

function parseWhisperCommand(text) {
  const matched = text.match(whisperCommandPattern);

  if (!matched) {
    return null;
  }

  const targetNickname = matched[1].trim().slice(0, 20);
  const whisperText = matched[2].trim().slice(0, 300);

  if (!targetNickname || !whisperText) {
    return null;
  }

  return {
    targetNickname,
    whisperText,
  };
}

function hasActiveNickname(nickname) {
  return state.activeNicknames.has(nickname);
}

function isPresenceActive(entry) {
  if (entry.id === state.sessionId) {
    return true;
  }

  if (typeof entry.updatedAt !== "number") {
    return false;
  }

  return (
    getEstimatedServerNow() - entry.updatedAt <=
    chatSettings.stalePresenceThresholdMs
  );
}

function stopPresenceHeartbeat() {
  if (!state.heartbeatTimerId) {
    return;
  }

  window.clearInterval(state.heartbeatTimerId);
  state.heartbeatTimerId = null;
}

async function refreshOwnPresence() {
  if (!state.ownPresenceRef || !state.joined) {
    return;
  }

  await set(state.ownPresenceRef, {
    sessionId: state.sessionId,
    nickname: state.nickname,
    updatedAt: serverTimestamp(),
  });
}

function startPresenceHeartbeat() {
  stopPresenceHeartbeat();

  state.heartbeatTimerId = window.setInterval(() => {
    refreshOwnPresence().catch((error) => {
      console.error(error);
    });
  }, chatSettings.presenceHeartbeatIntervalMs);
}

function cleanupStalePresence(entries) {
  entries.forEach((entry) => {
    const shouldCleanup =
      entry.id !== state.sessionId &&
      !isPresenceActive(entry) &&
      !state.pendingPresenceCleanup.has(entry.id);

    if (!shouldCleanup) {
      return;
    }

    state.pendingPresenceCleanup.add(entry.id);

    remove(ref(database, `${roomPath("presence")}/${entry.id}`))
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        state.pendingPresenceCleanup.delete(entry.id);
      });
  });
}

function renderMessages(entries) {
  messageList.innerHTML = "";

  entries.forEach((entry) => {
    const item = document.createElement("article");
    const classes = ["message"];
    const isCenteredNotice = entry.type === "system";

    if (entry.type === "system") {
      classes.push("system");
    }

    if (entry.type === "whisper") {
      classes.push("whisper");
    }

    if (
      !isCenteredNotice &&
      entry.nickname &&
      entry.nickname === state.nickname
    ) {
      classes.push("mine");
    }

    if (isCenteredNotice) {
      classes.push("centered");
    }

    item.className = classes.join(" ");

    if (isCenteredNotice) {
      const text = document.createElement("span");
      text.className = "message-text";
      text.textContent = entry.text;
      item.appendChild(text);
    } else {
      const author = document.createElement("span");
      author.className = "message-author";

      if (entry.type === "whisper") {
        author.textContent = `${entry.nickname}님의 귓속말 :`;
      } else {
        author.textContent = `${entry.nickname}:`;
      }

      const time = document.createElement("span");
      time.className = "message-time";
      time.textContent = formatTime(entry.createdAt);

      const body = document.createElement("div");
      body.className = "message-body";

      if (entry.type === "image" && entry.imageUrl) {
        const imageLink = document.createElement("a");
        imageLink.className = "message-image-link";
        imageLink.href = entry.imageUrl;
        imageLink.target = "_blank";
        imageLink.rel = "noreferrer";

        const image = document.createElement("img");
        image.className = "message-image";
        image.src = entry.imageUrl;
        image.alt = entry.fileName || "첨부 이미지";
        image.loading = "lazy";

        const meta = document.createElement("span");
        meta.className = "message-attachment-meta";
        meta.textContent = `${entry.fileName || "이미지"} · ${formatFileSize(entry.size)}`;

        imageLink.appendChild(image);
        body.append(imageLink, meta);
      } else {
        const text = document.createElement("span");
        text.className = "message-text";
        text.textContent = entry.text;
        body.appendChild(text);
      }

      item.append(author, body, time);
    }

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

async function deleteExpiredAttachmentEntry(entry) {
  if (!entry.id || state.pendingAttachmentCleanup.has(entry.id)) {
    return;
  }

  state.pendingAttachmentCleanup.add(entry.id);

  try {
    if (entry.storagePath) {
      try {
        await deleteObject(storageRef(storage, entry.storagePath));
      } catch (error) {
        if (error?.code !== "storage/object-not-found") {
          throw error;
        }
      }
    }

    await remove(ref(database, `${roomPath("messages")}/${entry.id}`));
  } catch (error) {
    console.error(error);
  } finally {
    state.pendingAttachmentCleanup.delete(entry.id);
  }
}

async function cleanupExpiredAttachments() {
  if (!state.joined) {
    return;
  }

  try {
    const expiredSnapshot = await get(
      query(
        ref(database, roomPath("messages")),
        orderByChild("expiresAt"),
        startAt(1),
        endAt(getEstimatedServerNow()),
      ),
    );

    const expiredEntries = [];

    expiredSnapshot.forEach((messageSnapshot) => {
      const entry = { id: messageSnapshot.key, ...messageSnapshot.val() };

      if (isAttachmentExpired(entry)) {
        expiredEntries.push(entry);
      }
    });

    for (const entry of expiredEntries) {
      await deleteExpiredAttachmentEntry(entry);
    }
  } catch (error) {
    console.error(error);
  }
}

function stopExpiredAttachmentCleanup() {
  if (!state.expiredAttachmentCleanupTimerId) {
    return;
  }

  window.clearInterval(state.expiredAttachmentCleanupTimerId);
  state.expiredAttachmentCleanupTimerId = null;
}

function startExpiredAttachmentCleanup() {
  stopExpiredAttachmentCleanup();
  cleanupExpiredAttachments().catch((error) => {
    console.error(error);
  });
  state.expiredAttachmentCleanupTimerId = window.setInterval(() => {
    cleanupExpiredAttachments().catch((error) => {
      console.error(error);
    });
  }, expiredAttachmentCleanupIntervalMs);
}

function subscribeRoom() {
  clearSubscriptions();

  state.initialMessageQueryRef = query(
    ref(database, roomPath("messages")),
    orderByChild("createdAt"),
    limitToLast(chatSettings.initialMessageLimit),
  );
  onValue(state.initialMessageQueryRef, (snapshot) => {
    state.initialMessages = normalizeMessages(snapshot);
    renderMergedMessages();
  });

  state.liveMessageQueryRef = query(
    ref(database, roomPath("messages")),
    orderByChild("createdAt"),
    startAt(state.joinedAt),
  );
  onValue(state.liveMessageQueryRef, (snapshot) => {
    const nextLiveMessages = normalizeMessages(snapshot, state.joinedAt);

    notifyTargetedCalls(nextLiveMessages);
    state.liveMessages = nextLiveMessages;
    renderMergedMessages();
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

    cleanupStalePresence(entries);

    const activeEntries = entries.filter((entry) => isPresenceActive(entry));
    state.activeNicknames = new Set(
      activeEntries
        .map((entry) => entry.nickname)
        .filter((nickname) => typeof nickname === "string" && nickname),
    );

    renderUsers(activeEntries);
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

  await refreshOwnPresence();

  await onDisconnect(state.ownPresenceRef).remove();
  startPresenceHeartbeat();
  startExpiredAttachmentCleanup();
}

async function uploadAttachment(file) {
  if (!state.joined) {
    showStatus("입장 후 이미지를 업로드할 수 있습니다.");
    resetAttachmentInput();
    return;
  }

  if (!file) {
    return;
  }

  if (!isAllowedAttachment(file)) {
    showStatus(
      "PNG, JPG, GIF, WEBP, BMP 이미지만 업로드할 수 있습니다. SVG는 허용되지 않습니다.",
    );
    resetAttachmentInput();
    return;
  }

  if (file.size > attachmentMaxBytes) {
    showStatus(
      `이미지는 ${formatFileSize(attachmentMaxBytes)} 이하만 업로드할 수 있습니다.`,
    );
    resetAttachmentInput();
    return;
  }

  setAttachmentUploading(true);

  try {
    const now = getEstimatedServerNow();
    const storagePath = `${chatSettings.collectionName}/${state.roomId}/attachments/${now}-${state.sessionId}-${sanitizeFileName(file.name)}`;
    const fileRef = storageRef(storage, storagePath);

    await uploadBytes(fileRef, file, {
      contentType: file.type,
      customMetadata: {
        roomId: state.roomId,
        uploadedBy: state.nickname,
        expiresAt: String(now + attachmentTtlMs),
      },
    });

    const imageUrl = await getDownloadURL(fileRef);

    await push(ref(database, roomPath("messages")), {
      type: "image",
      nickname: state.nickname,
      fileName: file.name,
      size: file.size,
      contentType: file.type,
      imageUrl,
      storagePath,
      createdAt: serverTimestamp(),
      expiresAt: now + attachmentTtlMs,
    });

    await refreshOwnPresence();
  } catch (error) {
    console.error(error);
    showStatus("이미지 업로드에 실패했습니다.");
  } finally {
    setAttachmentUploading(false);
    resetAttachmentInput();
  }
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

  state.nickname = nickname;
  state.roomId = roomId || chatSettings.defaultRoomId;
  state.joinedAt = getEstimatedServerNow();
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

attachmentButton.addEventListener("click", () => {
  if (!state.composerEnabled || state.uploadingAttachment) {
    return;
  }

  attachmentInput.click();
});

attachmentInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  await uploadAttachment(file);
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

  messageInput.value = "";
  messageInput.focus();

  try {
    const whisperPayload = parseWhisperCommand(text);
    const targetNickname = parseCallCommand(text);

    if (text.startsWith("/w") && !whisperPayload) {
      showStatus("귓속말은 /w {닉네임} {할말} 형식으로 입력하세요.");
      return;
    }

    if (whisperPayload) {
      if (whisperPayload.targetNickname === state.nickname) {
        showStatus("본인에게 귓속말을 보낼 수 없습니다.");
        return;
      }

      if (!hasActiveNickname(whisperPayload.targetNickname)) {
        showStatus("접속 중인 사용자가 아닙니다.");
        return;
      }

      await push(ref(database, roomPath("messages")), {
        type: "whisper",
        nickname: state.nickname,
        targetNickname: whisperPayload.targetNickname,
        text: whisperPayload.whisperText,
        createdAt: serverTimestamp(),
      });
    } else if (targetNickname) {
      if (targetNickname === state.nickname) {
        showStatus("본인은 호출할 수 없습니다.");
        return;
      }

      if (!hasActiveNickname(targetNickname)) {
        showStatus("접속 중인 사용자가 아닙니다.");
        return;
      }

      await push(ref(database, roomPath("messages")), {
        type: "system",
        systemType: "call",
        nickname: state.nickname,
        callerNickname: state.nickname,
        targetNickname,
        text: `${state.nickname} 님께서 ${targetNickname} 님을 호출하였습니다.`,
        createdAt: serverTimestamp(),
      });
    } else {
      await push(ref(database, roomPath("messages")), {
        type: "chat",
        nickname: state.nickname,
        text,
        createdAt: serverTimestamp(),
      });
    }

    await refreshOwnPresence();
  } catch (error) {
    console.error(error);
    messageInput.value = text;
    messageInput.focus();
    showStatus("메시지 전송에 실패했습니다.");
  }
});

function teardownPresence() {
  stopPresenceHeartbeat();
  stopExpiredAttachmentCleanup();

  if (state.ownPresenceRef) {
    remove(state.ownPresenceRef);
  }

  clearSubscriptions();
}

window.addEventListener("beforeunload", teardownPresence);
window.addEventListener("pagehide", teardownPresence);
window.addEventListener("pointerdown", () => {
  unlockAudioContext();
});
window.addEventListener("keydown", () => {
  unlockAudioContext();
});

onValue(ref(database, ".info/serverTimeOffset"), (snapshot) => {
  const offset = snapshot.val();
  state.serverTimeOffset = typeof offset === "number" ? offset : 0;
});

setComposerEnabled(false);
setNicknameModalVisible(false);
statusBanner.classList.add("hidden");

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

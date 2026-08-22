// ================================================================
// Emoji Reaction feature — Lottie reaction popup + avatar overlay.
// Fully additive: its own IDs/classes only (emoji-sheet-*,
// emoji-reaction-*, btn-open-emoji). Never touches any existing
// Activity/view, room logic, gift system, chat, or voice code.
//
// Loaded as a plain classic script (not a module) AFTER app.js, so it
// can read app.js's existing top-level `socket` / `me` / `currentRoomId`
// bindings and reuse its `$()` and `seatCircleRect()` helpers exactly the
// way bannerSlider.js and the rest of app.js do — no duplicated seat
// lookup logic, no new global state that could drift out of sync.
//
// Renders the supplied .lottie files exactly as provided via the
// dotlottie-wc web component (loaded in index.html) — no re-export, no
// JSON conversion, no re-encoding.
// ================================================================
(function () {
  const EMOJIS = [
    { id: "angry", label: "Angry", file: "/emoji/angry.lottie" },
    { id: "crying", label: "Crying", file: "/emoji/crying.lottie" },
    { id: "pizza", label: "Pizza", file: "/emoji/pizza.lottie" },
    { id: "pleading", label: "Pleading", file: "/emoji/pleading.lottie" },
    { id: "shock", label: "Shock", file: "/emoji/shock.lottie" },
    { id: "yawn", label: "Yawn", file: "/emoji/yawn.lottie" },
  ];
  const EMOJI_BY_ID = {};
  EMOJIS.forEach((e) => { EMOJI_BY_ID[e.id] = e; });

  let gridBuilt = false;
  function buildGrid() {
    if (gridBuilt) return;
    const grid = $("emoji-sheet-grid");
    if (!grid) return;
    EMOJIS.forEach((e) => {
      const item = document.createElement("div");
      item.className = "emoji-sheet-item";
      item.title = e.label;
      const player = document.createElement("dotlottie-wc");
      player.setAttribute("src", e.file);
      player.setAttribute("autoplay", "");
      player.setAttribute("loop", "");
      item.appendChild(player);
      item.addEventListener("click", () => selectEmoji(e.id));
      grid.appendChild(item);
    });
    gridBuilt = true;
  }

  function openSheet() {
    buildGrid();
    const sheet = $("emoji-reaction-sheet");
    if (sheet) sheet.classList.remove("hidden");
  }
  function closeSheet() {
    const sheet = $("emoji-reaction-sheet");
    if (sheet) sheet.classList.add("hidden");
  }

  // Tap an emoji -> close immediately, no confirmation, send the reaction.
  // The overlay itself is only spawned once the server broadcasts it back
  // (see the "emoji-reaction" listener below) so sender and everyone else
  // in the room see the exact same thing at the exact same time — the
  // same pattern app.js already uses for gifts.
  function selectEmoji(emojiId) {
    closeSheet();
    if (!currentRoomId || !socket) return;
    socket.emit("send-emoji-reaction", { roomId: currentRoomId, emojiId });
  }

  // Anchors a reaction directly above the sender's seat avatar, reusing
  // app.js's own seatCircleRect(userId) helper (the same one spawnGiftFly
  // uses) instead of duplicating seat-lookup logic. Falls back to a
  // centered position if that user isn't currently seated, so a reaction
  // never throws or disappears silently.
  function spawnReactionOverlay(emojiId, userId) {
    const info = EMOJI_BY_ID[emojiId];
    const layer = $("emoji-reaction-layer");
    if (!info || !layer) return;
    const layerRect = layer.getBoundingClientRect();
    const seatRect = (typeof seatCircleRect === "function") ? seatCircleRect(userId) : null;

    let xPct = 50, yPct = 12, sizePx = 56;
    if (seatRect && layerRect.width && layerRect.height) {
      const cx = seatRect.left + seatRect.width / 2 - layerRect.left;
      const cy = seatRect.top + seatRect.height / 2 - layerRect.top - seatRect.height * 0.2; // upward offset, roughly above the avatar
      xPct = (cx / layerRect.width) * 100;
      yPct = (cy / layerRect.height) * 100;
      sizePx = seatRect.width * 1.2; // 1.2x avatar size
    }

    const el = document.createElement("div");
    el.className = "emoji-reaction-item";
    el.style.setProperty("--rx", xPct + "%");
    el.style.setProperty("--ry", yPct + "%");
    el.style.width = sizePx + "px";
    el.style.height = sizePx + "px";

    const player = document.createElement("dotlottie-wc");
    player.setAttribute("src", info.file);
    player.setAttribute("autoplay", "");
    player.setAttribute("loop", "false");
    player.style.width = "100%";
    player.style.height = "100%";
    el.appendChild(player);
    layer.appendChild(el);

    // Each reaction is its own dotlottie-wc instance with its own canvas,
    // so many users reacting at once never share animation state. Removed
    // on the player's own completion event where available, plus a hard
    // timeout fallback so a stalled or missing file can never leave a
    // lingering view or leak memory.
    let removed = false;
    const remove = () => { if (!removed) { removed = true; el.remove(); } };
    player.addEventListener("complete", remove);
    setTimeout(remove, 3200);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const openBtn = $("btn-open-emoji");
    if (openBtn) openBtn.addEventListener("click", openSheet);
    const backdrop = $("emoji-sheet-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeSheet);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSheet();
    });

    // app.js creates `socket` inside connectSocket() at login time, not at
    // page load, so wait for it rather than assuming a fixed init order.
    const wireSocket = () => {
      if (typeof socket !== "undefined" && socket) {
        socket.on("emoji-reaction", (data) => {
          spawnReactionOverlay(data.emojiId, data.userId);
        });
        return true;
      }
      return false;
    };
    if (!wireSocket()) {
      const iv = setInterval(() => { if (wireSocket()) clearInterval(iv); }, 500);
    }
  });
})();

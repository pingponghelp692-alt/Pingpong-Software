# Level System Upgrade — 2026-08-04

Per the customer's "ID Level System Upgrade" spec. Upgrades the EXISTING
`idLevel.js` module — no new/second level system was created.

## What was actually broken

Two independent "level" fields existed:
- `user.idLevel` (idLevel.js) — real gift-send-only progression, but only
  ever shown in the separate "Level Information" popup.
- `user.level` — a wealth-tier badge recomputed from raw coin BALANCE at
  ~19 call sites across `server.js`, `coinCenter.js`, `diamondSeller.js`,
  and `rechargeWithdrawApproval.js`, on **every** coin-changing event
  (admin grants, recharge approval, chest rewards, game payouts, coin
  center credits, etc.) — **this** is the field the Profile chip, Gift
  Panel card, User Popup, Visitor Card, and Room seat badges actually
  displayed. That's the "level increases automatically" behavior.

## What changed

- **idLevel.js**: rewritten. Formula is now config-driven
  (`startingValue`, `growthMultiplier`, `maxLevel`; default 10,000 / ×5 /
  100, matching the spec's example exactly: L1=10,000, L2=50,000,
  L3=250,000, L4=1,250,000). Config persists to `data/level_config.json`.
  Levels are grouped in tens (1–9, 10–19, ... "100+") and each group has a
  themeable badge/icon/border/background/gradient/text-color/glow,
  persisted to `data/level_themes.json`. Both are cached in memory and
  only re-read from disk when an admin actually changes them.
- **`recordGiftSent()`** — the ONLY place level ever changes, called
  exclusively from a successful room Gift/Video Gift send — now also
  mirrors its result onto the legacy `user.level` field. This is why
  nothing had to change in ~20 existing display call sites: they already
  read `user.level`/`me.level`, and that field is now driven entirely by
  the real gift-only progression.
- **All ~19 auto-recompute-on-coin-change call sites deleted** in
  `server.js`, `coinCenter.js`, `diamondSeller.js`,
  `rechargeWithdrawApproval.js` (search "LEVEL SYSTEM UPGRADE 2026-08-04").
  `levelFromCoins()` itself is kept (unused) only so nothing throws if
  some other code still references it.
- **Admin Panel**: new "Level Management" sidebar section (permission
  `level:manage`, Owner/Global/Country Super Admin by default) —
  formula editor + one card per level group (color pickers, glow toggle,
  4 image uploads: badge/icon/border/background). Saving a group broadcasts
  `level-theme-update` over the existing socket connection so every online
  user in that group updates live, no reload, no per-user edit.
- **Profile / "My Level" popup**: now shows the current group's badge PNG
  (or theme gradient/glow if no PNG uploaded yet), group name, and a "next
  badge" preview when the next level lands in a new group. Existing
  fields (level number, lifetime gift sent, progress bar, remaining
  amount) unchanged.
- **Existing users**: unaffected by a formula change — Level Lock in
  idLevel.js means a stored level only ever goes up, never down; a new
  formula only affects future gift sends.

## Not touched (already correct / out of scope for this pass)

Gift catalog, room/voice features, coin/diamond wallet logic itself (only
the `.level` side-effect of a wallet change was removed), VIP system,
SVIP tags, all RBAC/country-isolation logic for every other module.

# Final UPI + Room Message Fix — 2026-08-17

Applied to this release:
- Server-generated recharge UPI links now support PhonePe, Paytm (`paytmmp://pay`), Google Pay (`tez://upi/pay`) and generic UPI fallback.
- Wallet payment launcher recognizes Paytm as a preferred app instead of downgrading it to generic UPI.
- Room chat entrance animation starts farther below the visible feed and rises into place; no chat markup/logic changed.
- Existing server-side payment verification remains authoritative. Opening an app or returning from it does NOT itself credit coins. A verified PAID/APPROVED transaction is required.
- Receiver UPI remains `labib3@axl` from paymentSettings.json.

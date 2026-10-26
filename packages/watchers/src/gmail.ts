/**
 * Gmail watcher (poll every 60s via users.history.list).
 * Stub until OAuth refresh token is in Vault and record_event is reachable.
 *
 * Emits email_received / email_sent with from, thread_id, occurred_at from
 * internalDate, summary = subject + snippet. Never stores full bodies.
 */
console.log(
  "@plumb/watchers gmail: not running yet. Connect Gmail at /api/gmail/auth, then wire historyId + record_event.",
);

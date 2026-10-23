// Read-only dump of the worker-account capacity store state for one account.
// Pinned to the MiMo namespace: the ChatGPT namespace resolves account identity
// from auth.json, and operator tools must never read credentials.
const MIMO_MODEL_BACKEND = "xiaomi-mimo-token-plan";
const modelBackend = process.env.MODEL_BACKEND ?? MIMO_MODEL_BACKEND;
if (modelBackend !== MIMO_MODEL_BACKEND) {
  console.error(
    `MODEL_BACKEND must be ${MIMO_MODEL_BACKEND}, got ${JSON.stringify(modelBackend)}`,
  );
  process.exit(2);
}

const base =
  process.env.BRIDGE_DIST ??
  "/opt/subscription-runtime/mimo-project-bridge-current/dist";
const { codexAccountCapacityStore } = await import(
  base + "/worker-codex/application/codex-account-capacity-store.js"
);

const poolDir =
  process.env.POOL_DIR ?? "/srv/worker-state/account-pools/live-codex-auth";
const accountId = process.env.ACCOUNT_ID ?? "account-q";
const model = process.env.MODEL ?? "mimo-v2.6-pro";

// strictReads: an unreadable record throws instead of being discarded, so this
// dump never deletes the evidence it is meant to show.
const store = codexAccountCapacityStore(poolDir, {
  modelBackend,
  strictReads: true,
});
const demand = {
  provider: "codex",
  model,
  reasoningEffort: "high",
  serviceTier: "default",
};
const fmt = (s) =>
  s ? JSON.stringify({ phase: s.phase, capacity: s.capacity }) : "null";

const now = new Date();
console.log("read:", JSON.stringify(store.read({ accountId, demand, now })));
console.log("state:", fmt(store.readState({ accountId, demand, now })));
// Account-wide view also covers records for other demands (model, effort).
console.log("accountWide:", fmt(store.readState({ accountId, now })));

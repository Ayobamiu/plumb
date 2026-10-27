// Tests never call Meta: without the key, callTool runs record_event without
// the Part C model check unless a test passes a fake model.
delete process.env.META_MODEL_API_KEY;

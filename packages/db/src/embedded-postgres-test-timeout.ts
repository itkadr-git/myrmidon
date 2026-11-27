// Budget for tests that start an embedded cluster and run migrations, including
// on contended CI runners. Keep it available without loading the test harness.
export const EMBEDDED_POSTGRES_TEST_TIMEOUT_MS = 90_000;
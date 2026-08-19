// Simple wrapper to expose migration functions to GAS web UI / scripts.

function runMigrationOnce() {
  // Call the migration that creates initial FIFO batches.
  return migrateCreateInitialBatches();
}

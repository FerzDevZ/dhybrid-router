// Migration 3: Add autoDelete and geolocation columns to proxyPools
// Run after schema version 2

export default {
  version: 3,
  name: "proxy-pools-auto-delete-geolocation",
  up(db) {
    // Add autoDelete column (boolean, default 0)
    try {
      db.exec(`ALTER TABLE proxyPools ADD COLUMN autoDelete INTEGER DEFAULT 0`);
    } catch (e) {
      // Column might already exist
      if (!String(e).includes("duplicate column")) throw e;
    }

    // Add geolocation column (TEXT, JSON)
    try {
      db.exec(`ALTER TABLE proxyPools ADD COLUMN geolocation TEXT`);
    } catch (e) {
      if (!String(e).includes("duplicate column")) throw e;
    }

    // Index for autoDelete queries
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pp_auto_delete ON proxyPools(autoDelete)`);
    } catch (e) {
      if (!String(e).includes("already exists")) throw e;
    }
  },
};
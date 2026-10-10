import { createApp } from "./gateway.js";
import { config } from "./config.js";
import { sweepExpiredCooldowns, listAccounts } from "./session-store.js";
import { logger } from "./logger.js";
import { isCdpEnabled } from "./cdp-samantha.js";
import { wakeEnterpriseVideoWatcher } from "./enterprise-video-jobs.js";

const app = createApp();

// When run under start-all, exit if the supervisor dies so an orphaned
// gateway never keeps :8787 and crash-loops the restarted service.
const supervisor = process.ppid;
if (supervisor !== 1) {
  setInterval(() => { if (process.ppid !== supervisor) process.exit(0); }, 2000).unref();
}

app.listen(config.port, "127.0.0.1", () => {
  logger.info("gateway listening", {
    url: `http://127.0.0.1:${config.port}`,
    admin: `http://127.0.0.1:${config.port}/`,
    upstream: config.upstreamUrl,
    cdp: isCdpEnabled(),
    logFile: logger.filePath(),
  });

  // Resume watching enterprise video jobs that were running before a restart.
  wakeEnterpriseVideoWatcher();

  setInterval(async () => {
    try {
      const sweep = await sweepExpiredCooldowns();
      if (sweep.cleared > 0) {
        const accounts = await listAccounts();
        logger.info("cooldown sweep", {
          cleared: sweep.cleared,
          available: accounts.filter((a) => !a.cooling).length,
          total: accounts.length,
        });
      }
    } catch (err) {
      logger.error("cooldown sweep failed", { message: String(err.message || err) });
    }
  }, 15_000);
});

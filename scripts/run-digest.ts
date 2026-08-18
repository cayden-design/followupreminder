/**
 * Manual digest trigger: `npm run digest:now [-- --force]`
 * Without --force it respects the once-per-week lock.
 */
import { pool } from "../src/db.js";
import { runWeeklyDigest } from "../src/reminders.js";

const force = process.argv.includes("--force");

runWeeklyDigest({ force })
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

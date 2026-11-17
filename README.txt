SATURN PERPS — QUEUE OVERFLOW FIX

Target repository: alcapon264-cell/Saturn-perps-data
Target branch: main

Files in this ZIP:
- src/recorder.js.patch — two-line-behavior patch for the existing recorder
- tests/recorder-queue-overflow.test.js — regression test

Why:
The current overflow logic uses queue.shift(), which silently discards the OLDEST
pending observation. The fix preserves the older queue and rejects the newest
sample when the 240-item queue is full. It increments queue_overflow_dropped.

Apply:
1. Open src/recorder.js in GitHub.
2. In BOTH queue-overflow branches, remove queue.shift().
3. Use the replacement shown in src/recorder.js.patch.
4. Add the test at tests/recorder-queue-overflow.test.js.
5. Commit both files, then let GitHub Actions run.

Important:
This is a targeted patch, not a full replacement of src/recorder.js. Apply it to
the current main branch version; do not replace the whole file with the patch.
No Render settings, database settings, API keys, or other Saturn code are changed.

# Saturn Perps recorder observability patch

## Scope
This patch adds best-effort diagnostics to the existing recorder only.

## Changes
- Captures per-market request start/finish timestamps and measured request duration.
- Records scheduler lag for scheduled sampling attempts.
- Captures database insert duration and outcome (inserted, duplicate, error).
- Counts queue flush failures, late queue drops, overflow drops, skipped slots and database write errors.
- Exposes queue capacity, oldest queued age, next scheduled time, last database outcome, and skipped-slot count in the existing protected recorder summary.
- Converts a thrown Jupiter request into the existing `network` failure classification so the recorder can back off and continue.
- Wraps diagnostic logging/metrics calls so observability failures do not interrupt sampling.

## Preserved
- 15-second default sampling cadence and existing request budget.
- Existing candle construction, candle validity thresholds and 60-valid-hour readiness rule.
- Existing queue FIFO behavior and bounded queue size.
- Trading, wallet, signing, execution, authentication, API routes, migrations and deployment configuration.

## Validation
- `node --check src/recorder.js`: passed.
- Full `npm test` was attempted, but this environment did not have the `ws` dependency installed and did not have a local PostgreSQL server/user. The test runner reported dependency-load failures and skipped PostgreSQL-backed tests. Therefore the full suite is NOT verified.
- No live Jupiter requests, database writes, Render deployment or production changes were made.

## Important
This is a diagnostics patch, not proof of the original outage root cause. The added protected status fields should be used during a staging observation window to identify whether gaps correlate with upstream request failures, scheduler lag, or database/queue failures.

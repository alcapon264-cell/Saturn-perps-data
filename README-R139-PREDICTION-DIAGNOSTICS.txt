# Saturn R139 Prediction diagnostics fix

This ZIP contains two complete replacement files from the supplied Saturn backend archive.

## Replace these exact paths in the backend repository

- `src/app.js`
- `src/pm-data.js`

Keep both files inside the existing `src/` directory. Do not replace the whole repository.

## What changed

- `src/app.js`: passes the existing server `log` function into `createPmData`.
- `src/pm-data.js`: logs safe upstream failure metadata (`host`, URL pathname, HTTP status, error code, error name) and request failure metadata. It does not log query strings, tokens, credentials, response bodies, or secrets.
- Public API error responses remain generic; no Prediction trading or order execution is enabled.

## Important

This is diagnostic instrumentation, not a confirmed upstream connectivity repair. After replacing the files and deploying the backend, refresh Prediction and inspect Render logs for `prediction_upstream_failure` or `prediction_request_failed`. Those entries will identify the failing upstream host/path and status without exposing secrets.

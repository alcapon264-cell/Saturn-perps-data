# S2 — Run the Jupiter live check on your own computer

**What this does:** sends a few read-only GET requests to Jupiter's public `market-stats` endpoint (SOL, ETH, BTC) and saves what came back, including every response header, to a JSON file. It tells us the facts the build could not know: whether `price` is a number or a string, whether a timestamp field exists, and whether Jupiter sends rate-limit headers.

**What it cannot do:** it sends no API key, no cookies and no wallet data, it only reads, and it never sends faster than one request every 5 seconds (at most 60 requests in total). It does not touch Saturn, Render or any account. The report contains only public market data and Jupiter's headers.

## Steps (about 3 minutes)

**1. Install Node.js 22 (one time).** Go to https://nodejs.org, install the "LTS" version (22 or newer), then open a new terminal window:
- Windows: press Start, type `PowerShell`, press Enter.
- Mac: open `Terminal`.

Check it worked:
```
node -v
```
It should print `v22…` or higher. (Version 18+ also works, but use 22 if you can.)

**2. Get the file.** Unzip `Saturn-perps-data-S1.zip`. You only need one file from it: `scripts/live-check.mjs`. Or use the copy sent separately called `live-check.mjs`.

**3. Open a terminal in the folder that contains `live-check.mjs`.**
- Windows: open the folder in File Explorer, click the address bar, type `powershell`, press Enter.
- Mac: right-click the folder and choose "New Terminal at Folder".

**4. Run it:**
```
node live-check.mjs --samples 4 --interval 15 --out live-check.json
```
This takes about **1 minute** and prints one line per request, for example `#1 SOL: HTTP 200 in 312 ms, price=148.31 (string)`, then a short "verdict" block. Leave it alone until it finishes.

**5. Send me the result.** A file called **`live-check.json`** appears in the same folder. Send me that file (attach it here). If it is easier, you can also paste the "verdict" block that was printed. Nothing in it is secret.

## Run it from the same network you normally use
Run it from the computer and internet connection you normally use, not through a VPN, so the result is representative.

## If something goes wrong
| What you see | What it means | What to do |
|---|---|---|
| `node: command not found` / "not recognized" | Node is not installed or the terminal was opened before installing | Install Node, close the terminal, open a new one |
| `HTTP 429` lines, or the script says `rateLimited429` | Jupiter is rate limiting you | **Stop. Do not rerun repeatedly.** Wait 5 minutes, run once more with `--samples 1`, and send me both results |
| `ERROR fetch failed` / DNS error | Your network cannot reach `perps-api.jup.ag` right now | Send me the output anyway; try once more later, or on another network |
| The script exits with code 2 | At least one request was not HTTP 200 | Still send me `live-check.json`; the failure is useful information |

## Optional: browser version
`scripts/live-check.html` does the same GETs from a web page, but a browser can only show the few response headers Jupiter explicitly exposes, so it can miss rate-limit headers. Prefer the Node script. If you use the page, open it from your GitHub Pages site, press "Run check", then "Download JSON" and send me that file.

## What happens next
Once I have the JSON I will: (1) confirm the service's price parsing matches Jupiter's real format, (2) read the rate-limit headers and confirm or adjust the 15-second interval and 0.25 requests/second budget, (3) report any surprises. **S3 (deployment) does not start** until you have sent the results and separately approved deployment.

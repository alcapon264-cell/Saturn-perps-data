# Official market logos (served by /v1/perps/logos/<KEY>)

A file here is used ONLY if it is listed in SOURCES.json with the official page it came from and its sha256.
Anything else is ignored. Files must be PNG (or JPEG/WEBP/GIF), at most 256 KB, named <KEY>.png
(SOL, ETH, BTC, HYPE, ZEC, JUP, SNDK, SPCX, NEAR, SKHYNIX, BNB).

Without a declared file the service uses the verified remote image (CoinGecko image of the verified coin id;
Jupiter token icon for SOL/ETH/BTC). Stocks (SNDK, SPCX, SKHYNIX) have no remote source, so they need a file here,
otherwise the app shows a plain disc (an honest missing-logo state).

Example SOURCES.json entry:
[
  { "market": "SNDK", "source": "https://<official Sandisk brand/press page>", "sha256": "<sha256 of SNDK.png>" }
]
Get the hash with:  sha256sum SNDK.png   (macOS: shasum -a 256 SNDK.png)

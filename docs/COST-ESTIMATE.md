# Render cost estimate (required before any paid resource is created)

**Source and confidence.** Taken today from Render's own pricing pages (`render.com/pricing.md`, `render.com/docs/compute-plans.md`) fetched through a summarising tool, so the figures are quoted from that summary, not from the live dashboard. The page shows no "last updated" date. **Check the dashboard before creating anything.** A third-party article title in my search results mentions a Render plan change on 1 August 2026; I could not verify that or what it changed, so treat all prices as needing confirmation.

## Line items

| Item | Plan (Render plan ID) | Monthly price | Notes |
|---|---|---|---|
| Web service (always on) | `0.5c-512mb` (legacy name *starter*): 0.5 CPU, 512 MB | **$7** | Enough for this single Node process (3 markets, tens of clients). Not measured; S4 soak will show real memory. |
| Postgres, minimal | `0.1c-256mb` (legacy *basic-256mb*) | **$6** | 256 MB RAM. Probably adequate for ≈ 600k observation rows + candles, but unmeasured. |
| Postgres, recommended | `0.5c-1g` (legacy *basic-1gb*) | **$19** | Headroom for queries and indexes. |
| Postgres storage | expandable storage | **$0.30 per GB** | Whether a base amount is included is **not stated** on the pages I could read. Estimated need < 1 GB in year one (≈ 150–250 MB observations at 35-day retention, ≈ 300 MB/yr candles) → ≈ $0.30. |
| Workspace plan | Hobby **$0** / Pro **$25** | $0 or $25 | **Not stated** whether paid services can run on Hobby. The pricing page says only that Pro/Scale carry a flat fee. This single fact decides between the two totals below. |
| Bandwidth | Hobby 5 GB, Pro 25 GB included, then $0.15/GB | ≈ $0 | WebSocket + JSON for a few clients is far below 5 GB/month. |
| Point-in-time recovery | included on paid Postgres | $0 | Window stated as 3 days (Hobby) / 7 days (Pro). |

## Totals
| Scenario | Monthly |
|---|---|
| Minimum (Hobby workspace if allowed, 256 MB Postgres, 1 GB storage) | **$7 + $6 + $0.30 = $13.30** |
| Recommended on Hobby (1 GB Postgres) | **$7 + $19 + $0.30 = $26.30** |
| Minimum on Pro workspace | **$25 + $13.30 = $38.30** |
| Recommended on Pro workspace | **$25 + $26.30 = $51.30** |

Taxes and overage are excluded. **I cannot give one exact number until you confirm whether your existing Render workspace is Hobby or Pro and whether Hobby may host paid services.** If you already pay the Pro workspace fee for the existing relays, the incremental cost of this service is the compute and storage only: **$13.30 (minimum) or $26.30 (recommended)**.

Free tiers remain unsuitable: free web services sleep after 15 minutes without inbound traffic and free Postgres expires after 30 days with no backups (Render docs).

**Recommendation:** web service `0.5c-512mb` + Postgres `0.5c-1g`, i.e. **$26.30/month incremental** on an existing paid workspace, to be confirmed in the dashboard at S3. I will not create any resource without your separate approval.

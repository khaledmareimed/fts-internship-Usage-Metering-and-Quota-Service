# Demo Script — Example Client (Next.js)

The client acts as the company's own app. The API key lives only on the
Next.js server; the browser never sees it.

## Seeded on startup
- Company **"Acme Docs"** on a custom account plan
  **"Demo Team"**: 100 units/month, 60 per request (small, so the shared limit
  is easy to hit)
- **Ali** on **Basic**: 1,000/month, 20 per request
- **Sara** on **Premium**: 10,000/month, 200 per request

## Page layout
1. **The app:** pick a user, enter units, click "Process document".
   Shows accepted/rejected, the failed rule(s) and whose rule it was.
2. **Usage bars:** company and each user, used vs remaining, updated after
   every click.
3. **Admin panel:** switch a user's plan, edit the "Demo Team" limits.
4. **History:** last 10 decisions.
5. **Reset demo** button (re-seeds the demo company).

## The story (also in the README)
| Step | Action | Result |
|---|---|---|
| 1 | Ali processes 10 | Accepted. Company 10/100, Ali 10/1000 |
| 2 | Ali processes 25 | Rejected: **user** per-request limit (20) |
| 3 | Sara processes 60 | Accepted. Company 70/100 |
| 4 | Sara processes 40 | Rejected: **account** monthly limit (30 left) |
| 5 | Edit "Demo Team" to 500/month | Saved, no code change |
| 6 | Sara processes 40 again | Accepted. Company 110/500 |
| 7 | Switch Ali to Premium | Saved |
| 8 | Ali processes 25 again | Accepted. Ali keeps his 10 used (no fresh allowance) |

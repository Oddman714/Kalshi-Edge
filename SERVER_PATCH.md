# Dashboard Fix — What Changed & How to Deploy

## Root Cause
The old `kalshi-edge-dashboard.html` was calling endpoints that don't exist:
- `/api/status` ❌ (doesn't exist)
- `/api/trades` ❌ (doesn't exist)
- `/api/positions` ❌ (doesn't exist)
- `/api/signals` ❌ (doesn't exist)
- `/api/logs` ❌ (doesn't exist)

**The server has ONE data endpoint: `/api/state`** — which returns ALL of this in one call.

The old HTML also divided balance values by 100, but server already returns dollars (not cents).

---

## Option A — Standalone HTML (easiest, no server change needed)

1. Upload `kalshi-edge-dashboard.html` to your Railway deployment root
2. In `server.js`, find the route block at line ~2178:
   ```js
   if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/dashboard') {
   ```
3. Replace the entire block with this:
   ```js
   if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/dashboard') {
     const dashPath = path.join(__dirname, 'kalshi-edge-dashboard.html');
     if (fs.existsSync(dashPath)) {
       const html = fs.readFileSync(dashPath, 'utf8');
       res.writeHead(200, {
         'Content-Type': 'text/html; charset=utf-8',
         'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
       });
       return res.end(html);
     }
     // fallback to embedded DASHBOARD if file not found
     res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
     return res.end(DASHBOARD);
   }
   ```

4. Deploy both files to Railway (push both `server.js` and `kalshi-edge-dashboard.html`)

---

## Option B — Replace embedded HTML in server.js (everything in one file)

Find the `const DASHBOARD = \`` line (around line ~1000-1100 in server.js) and replace everything between the backticks with the contents of `kalshi-edge-dashboard.html`.

---

## What the new dashboard fixes

| Issue | Old | New |
|-------|-----|-----|
| API endpoints | `/api/status`, `/api/trades` etc (404) | `/api/state` (correct) |
| Balance display | Divided by 100 (shows cents as dollars) | Correct — server already sends dollars |
| Tab navigation | Stuck on Dashboard | All 5 tabs work |
| Positions tab | Broken | Live from `/api/state` |
| Signals tab | Broken | Live from `/api/state` |
| Markets tab | Missing | New — shows top opportunities |
| Logs tab | Called wrong endpoint | Reads from state.logs |
| Doubling progress | Missing | Full bar with phase targets |
| Phase engine | Not shown | Shows phase, Kelly %, edge threshold |
| SSE live feed | Not connected | Connects to `/api/events` |
| Force sync button | Cycle button (wrong endpoint) | Calls `/api/sync` POST |
| Test modal | Called `/api/test-connection` (wrong) | Calls `/api/validate` (correct) |

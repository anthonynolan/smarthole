In the browse screen there are cards with yesterday's date on them as the due date, but they did not come up for review today. There may be an off by one error?
Status: Investigated — no off-by-one found, no queue change made.
Notes: Verified with a throwaway probe (not kept): a card with yesterday's due date IS returned by /api/next and is reviewable, so the queue logic (due <= now, UTC) is correct. The usual reasons a yesterday-dated card does not come up: (a) it is suspended (review excludes suspended cards — now visible via the new Susp. column and the Show-suspended filter), (b) it is a new card (reps 0) waiting behind the review backlog or the daily new-card budget (NEW_CARDS_PER_DAY), which surfaces in /api/next only after due reviews. If you see a specific card that is neither suspended nor new and still does not surface, report its card number.

(put this on on hold for now) I would like a way to test my mcp connectors locally before I deploy to prod. Add a page to the app which lets me paste some content. I should be able to create the anki cards from that content using the mcp endpoint by clicking a button on that page. The cards should display on that page with front and back labels. All of the cards created should be visible at once. There should be a button to delete all of these test cards from the database in one go.
Status: On hold (untouched, as requested).

(put this one on hold for now) Put in place resource usage logging on the server so that if the server gets wedged I can determine the cause.
Status: On hold (untouched, as requested).

Serve smarthole and grimoire from the same uvicorn.
Status: Blocked — not implemented.
Notes: Grimoire's code is not in this repo (only same-cluster DB, auth-flow, and embedding-method references), and no grimoire package is installed, so there is nothing to mount yet. Once its ASGI app import path is known, the usual shape is one combined app that mounts smarthole at / and grimoire under a sub-path (or merges routers) with a single uvicorn ExecStart; the nginx conf already proxies everything to one port (8003), so no proxy change is needed. Say the word with the grimoire repo path and I will wire it.

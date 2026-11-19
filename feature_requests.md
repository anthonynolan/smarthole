In the browse screen add a column indicating that the card has been suspended. In the card detail view accessed from here it should be possible to suspend or unsuspend a card.
Status: Done.
Notes: Browse table has a "Susp." column ("Yes"/"—"). The card detail dialog has a Scheduling section showing in-queue vs suspended state with a Suspend/Unsuspend button. Backend: POST /api/cards/{id}/suspend and /unsuspend; suspend keeps the card in Browse but out of the review queue. Tests: test_suspend_unsuspend_round_trip; frontend test for the new columns.

In the browse screen there are cards with yesterday's date on them as the due date, but they did not come up for review today. There may be an off by one error?
Status: Investigated — no off-by-one found, no queue change made.
Notes: Verified with a throwaway probe (not kept): a card with yesterday's due date IS returned by /api/next and is reviewable, so the queue logic (due <= now, UTC) is correct. The usual reasons a yesterday-dated card does not come up: (a) it is suspended (review excludes suspended cards — now visible via the new Susp. column and the Show-suspended filter), (b) it is a new card (reps 0) waiting behind the review backlog or the daily new-card budget (NEW_CARDS_PER_DAY), which surfaces in /api/next only after due reviews. If you see a specific card that is neither suspended nor new and still does not surface, report its card number.

When studying the card front is displayed first. When I click show answer the answer is displayed with a large gap below the front. This gap seems to remain after the removal of the repeated front text, so remove the gap.
Status: Done.
Notes: The answer block's top margin/padding was cut (mt 2 -> 0, pt 2 -> 1); the dashed separator is kept. Review screen only; the browse detail dialog keeps its existing spacing.

When AI assistance is requested on the card review screen do not show the raw json response, just the cards.
Status: Done.
Notes: The live raw-stream preview panel was removed. While streaming, only a progress spinner shows; afterwards just the suggested cards (or "No changes suggested"). Frontend streaming test updated to assert the raw dump is gone.

Add a show suspended checkbox to the browse screen.
Status: Done.
Notes: "Show suspended" checkbox filters Browse to suspended cards only (parallel to "Show MCP-created"), wired as ?suspended_only=true. Frontend test coverage via the new columns test; backend covered in test_suspend_unsuspend_round_trip.

When review the number due today does not update when cards are split (this should change the total). Also instead of just a count going down there should be a count of the number already done today which goes up.
Status: Done.
Notes: Review header now reads e.g. "5 due today · 4 studied today". The studied-today count comes from /api/stats (reviews graded today) and refreshes on load, after each grade, after split-accept, and after delete. Split-created cards are new cards (reps 0), so they raise the deck totals/new counts rather than the due-today count — the header now refreshes after the background split writes land, so you see the totals move.

On the stats page change the Due forecast to be a vertical bar chart with tomorrow leftmost.
Also add a chart showing the number of cards added per day.
Status: Done.
Notes: Due forecast is now vertical bars, starting tomorrow (today is already the "Due now" card). New "Cards added per day" vertical-bar chart covers the last 30 days (oldest left, today right), from a new added_per_day field on /api/stats. Test: test_stats_reports_added_per_day.

In the browse screen the numbers shown in the first column are incorrect. I want each card to have a number assigned when it is written to the database. This number should persist for the life of the card.
Status: Done.
Notes: New persistent Card.card_number (global sequence, never reused). Assigned on create, import, and MCP creation; older cards are backfilled on first browse read. The first column now shows this number instead of the page-row index, so it is stable across pages, sorts, and searches. Test: test_browse_assigns_persistent_card_numbers.

Search cards in browse should first do an exact match by substring (as it does now), but should then run an embedding similarity search to pull back results that are close within some threshold.
Status: Done.
Notes: With a search query, exact substring matches come first (due-sorted, as before), then up to 20 vector-similar cards from the same deck scoring at/above the RELATED_MIN_SCORE threshold are appended on the first page; later pages stay exact-only so paging is stable. Degrades to exact-only when embeddings are unavailable (no key / no vector index). Skipped when the deleted/suspended/MCP filters narrow the view (the similarity index only covers active cards). The total includes the appended similar rows.

Change the Import menu to say Import/Export and allow the user to export in anki format a single, or multiple decks.
Status: Done.
Notes: Drawer item renamed to "Import/Export"; the page has an Export section with per-deck checkboxes and an "Export .apkg" button downloading a single .apkg containing all selected decks (Basic notes, Front/Back HTML). Backend: GET /api/export?deck_ids=a,b (404 for foreign/missing decks, 400 for empty). Built with Anki's own backend so it re-imports cleanly. Not carried over: scheduling state and media file references. Test: test_export_round_trips_through_import (export then re-parse).

When I have asked for a card to be split and the results return and I accept them, the app should move on to the next task: review or show finish screen. The writing to the db should happen in the background so that there is not a delay in the UI.
Status: Done.
Notes: Accepting a split now immediately closes the dialog, clears the card, and loads the next due card (excluding the one just split, so you never re-see it) or the finish screen. The creates + original-delete then land in the background; deck counts and the studied-today counter refresh when they complete, and any background failure surfaces as a status line instead of blocking.

I want to be able to edit the due date on a specific card.
Status: Done.
Notes: Browse card detail has a Scheduling section with a Due-date picker + Save (PUT /api/cards/{id}/due, ISO datetime; 400 on bad input, 404 for foreign/deleted cards). Saving reloads the detail and the browse row. Test: test_set_card_due_reschedules (past due -> reviewable; future due -> leaves the queue).

(put this on on hold for now) I would like a way to test my mcp connectors locally before I deploy to prod. Add a page to the app which lets me paste some content. I should be able to create the anki cards from that content using the mcp endpoint by clicking a button on that page. The cards should display on that page with front and back labels. All of the cards created should be visible at once. There should be a button to delete all of these test cards from the database in one go.
Status: On hold (untouched, as requested).

(put this one on hold for now) Put in place resource usage logging on the server so that if the server gets wedged I can determine the cause.
Status: On hold (untouched, as requested).

Serve smarthole and grimoire from the same uvicorn.
Status: Blocked — not implemented.
Notes: Grimoire's code is not in this repo (only same-cluster DB, auth-flow, and embedding-method references), and no grimoire package is installed, so there is nothing to mount yet. Once its ASGI app import path is known, the usual shape is one combined app that mounts smarthole at / and grimoire under a sub-path (or merges routers) with a single uvicorn ExecStart; the nginx conf already proxies everything to one port (8003), so no proxy change is needed. Say the word with the grimoire repo path and I will wire it.

Verification (this round): backend suite 82 passed + 1 skipped; ruff clean; frontend 29 passed (3 files); tsc clean. New tests: 5 backend (suspend round-trip, set-due, persistent numbers, export round-trip, added-per-day) + 1 frontend (created/suspended columns); updated 3 frontend tests (Import/Export label, studied-today count, no raw AI stream).

On export the text from the front of the card is repeated on the back of the card along with the question. Don't duplicate the front text here.


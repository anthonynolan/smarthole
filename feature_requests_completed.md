# Completed feature requests
(Moved out of feature_requests.md — everything below is done.)

In the browse screen add a column indicating that the card has been suspended. In the card detail view accessed from here it should be possible to suspend or unsuspend a card.
Status: Done.
Notes: Browse table has a "Susp." column ("Yes"/"—"). The card detail dialog has a Scheduling section showing in-queue vs suspended state with a Suspend/Unsuspend button. Backend: POST /api/cards/{id}/suspend and /unsuspend; suspend keeps the card in Browse but out of the review queue. Tests: test_suspend_unsuspend_round_trip; frontend test for the new columns.

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

Verification (this round): backend suite 82 passed + 1 skipped; ruff clean; frontend 29 passed (3 files); tsc clean. New tests: 5 backend (suspend round-trip, set-due, persistent numbers, export round-trip, added-per-day) + 1 frontend (created/suspended columns); updated 3 frontend tests (Import/Export label, studied-today count, no raw AI stream).


On export the text from the front of the card is repeated on the back of the card along with the question. Don't duplicate the front text here.
Status: Done.
Notes: The Anki {{FrontSide}} echo is now stripped when writing the Back field in _export_apkg (same strip_front_echo already used at review time). Verified by re-importing the .apkg with Anki's backend and asserting the Back field holds just the answer. Test: test_export_strips_front_echo.

On mobile the browse screen layout does not work. The question is squeezed into too narrow a space. Create a new multiline layout for browse on mobile so that the question can be read easily.
Status: Done.
Notes: Under 600px Browse renders a stacked multiline card list (number + suspended flag, full-width question, due/reviewed/created line, restore/delete actions) instead of the table, plus a compact sort-by dropdown. Desktop table unchanged.

add feedback button to the app bar so that it is visible from anywhere within the app. A user should be able to give feedback on the app by typing in a text box, or by voice transcription. For details on how to do voice transcription see the grimoire app. Once added a users feedback should appear under a new feedback section from the main menu. It should have a status of submitted. When I access this feedback (anthonynolan@gmail.com) I should see everyone's feedback with their username. I can filter this list by user and status and can export the full list of a filtered set.
Status: Done.
Notes: AppBar "Feedback" button (visible everywhere) + "Feedback" drawer item. New Feedback collection with POST /api/feedback (status starts at "submitted"), GET /api/feedback (own), GET /api/feedback/all + PATCH status + GET /api/feedback/export CSV (admin-only, default admin anthonynolan@gmail.com via ADMIN_EMAILS). Admin sees usernames, filters by user/status, exports the filtered set. Voice: grimoire uses a server WebSocket /speech/transcribe endpoint which smarthole does not have, so dictation uses the browser-native SpeechRecognition (no new infra); typing always works and the mic button hides where unsupported. Tests: feedback submit/list/admin/export backend tests + 2 frontend view tests.

allow sorting browse section by column heading.
Status: Done.
Notes: # / Due / Last reviewed / Created headers are clickable sort labels (click again reverses); backend accepts sort=created_at|card_number with nulls-last paging. The due-today-first reorder/divider now applies only to the default due-ascending view. Mobile gets a sort-by control. Test: test_browse_sorts_by_created_at_and_card_number + frontend sort-click test.

Change the MCP to allow viewing of existing cards and similarity search.
Status: Done.
Notes: New cards:read tools list_cards (newest-first, substring query) and find_similar_cards (by text or card_id, RELATED_MIN_SCORE threshold, honest "unavailable" error when embeddings are not configured). Documented in docs/mcp.md. Tests: list roundtrip/query, input validation, degraded-without-embeddings.

Fix MCP to always provide draft cards and check boxes.
Status: Done.
Notes: Instructions and propose_cards contract now require propose_cards on every card presentation — final, draft, or partial — so the checkbox widget (select-all + create_cards) always renders; list_cards/find_similar_cards are the named context step. Test: test_mcp_instructions_require_propose_for_drafts.

From the UI I should be able to see the date and time of the last deploy of the server and the last build of the UI.
Status: Done.
Notes: GET /api/build-info reports process start (the honest proxy for last deploy/restart) plus git sha; the UI build time is baked in at build via vite define. Both shown at the bottom of the Stats view (e.g. "Server deployed 12-Nov'26 14:05 UTC (abc123) · UI built …"). Tests: test_build_info_reports_server_start + frontend build-info test.

On the stats screen restrict the graphs to screen width, no horizontal scroll. Make the bars tighter and turn the labels sideways to achieve this if necessary.
Status: Done.
Notes: Both bar charts are now flex fit-to-width (overflow hidden, 2px gaps, narrower bars) with sideways (vertical) date labels. Test: stats view renders due-forecast chart testid.

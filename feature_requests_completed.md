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

I want to be able to overwrite the dev data with the production data. This should only be possible for the admin user.
Completed: 21-Nov-26 10:26 UTC.
Status: Done.
Notes: New POST /api/admin/overwrite-dev-from-prod with {"confirm": "overwrite-dev"} copies every collection from smarthole_prod into the current database via the same cluster client. Triple-guarded: (1) admin only via _require_admin (403 otherwise), (2) refuses when the server itself runs on the production database, (3) explicit confirm string plus a refusal when prod has no collections (so a typo cannot wipe dev first). Sessions are copied too, so the admin must log in again with a production account. UI: /api/me now reports is_admin; admins get an "Admin" drawer section with a double-confirmed overwrite button and relogin notice. Tests: 5 backend (forbidden/confirm/copy/refusals) + 2 frontend (admin flow, non-admin hidden).


Give me a list of features in Anki that I might add here. In addition suggest some new features which I might add. 


Deck chat: let me ask questions across my cards and get answers grounded in what I am studying, using the existing card embeddings.
Completed: 21-Nov-26 10:49 UTC.
Status: Done.
Notes: New "Chat" drawer page + POST /api/chat. Searches all decks by default with a per-deck filter; embeds the question, retrieves the top 8 similar cards (RELATED_MIN_SCORE threshold), and answers tutor-style via Muse Spark with the cards named under each answer. Follow-up questions work via the last 10 messages of history. Honors the clarified choices: all decks + filter, tutor-style with cards as context, new drawer page. Degrades honestly: 503 when embeddings are unavailable, 400 on empty questions, 404 on foreign decks. Tests: 5 backend (answer + citations, deck scoping, validation, 503 path, prompt history cap) + 1 frontend (send/receive/cited cards).

Review heatmap: a year-view grid showing review activity per day so I can see my study consistency at a glance.
Completed: 21-Nov-26 15:27 UTC.
Status: Done.
Notes: GET /api/stats now includes sparse review_history (per-day review counts over the last 365 days). Stats view shows a GitHub-style year grid (Sunday-start weeks, intensity by quartile, tooltips, Less/More legend) that fits screen width. Tests: backend per-day counts + window clip; frontend heatmap render.

Duplicate warning on add: when adding a card, warn me if a near-duplicate already exists, using the existing similarity search.
Completed: 21-Nov-26 15:29 UTC.
Status: Done.
Notes: New GET /api/decks/{id}/duplicates returns exact substring matches first then embedding-similar cards above the related threshold; the similarity half degrades to exact-only when embeddings are unavailable. The Add view checks live (debounced) and shows a non-blocking warning naming the matches. Tests: 4 backend (exact, empty/degraded, stubbed similar, validation) + 1 frontend (warning appears while typing).

AI generated cards from pasted text: a page where I paste content and the app proposes Anki cards from it, which I verify with checkboxes before they are created.
Completed: 21-Nov-26 15:32 UTC.
Status: Done.
Notes: New "Generate cards" drawer page + POST /api/cards/generate (proposes via Muse Spark, capped at 8000 chars, no writes). Proposals render with checkboxes (all ticked by default); "Add N selected" creates the ticked ones via POST /api/cards. 400 on empty/oversized content, 404 on foreign deck, 503 without MODEL_API_KEY. Tests: 3 backend (propose-without-write, validation/auth, missing key) + 1 frontend (propose, untick one, add only the ticked one).

Streaks + daily goal + reminders by email: track my study streak and daily goal, and email me a reminder when I have not studied.
Completed: 21-Nov-26 15:37 UTC.
Status: Done.
Notes: Streak = consecutive UTC days with a graded review (alive if today unstudied but yesterday studied). New User.daily_goal (default 20) and reminder_enabled; GET/PUT /api/preferences; /api/stats gains streak + goal{target,studied,met}. Stats view shows a Day streak card, a Daily goal card with progress bar, and a Goals & reminders editor (goal number + save, reminder checkbox). Reminders: scripts/send_study_reminders.py (evening cron, --dry-run) emails opted-in users with nothing studied today via SMTP (SMTP_* env, documented in .env.example); subject flags a streak at stake. Tests: 6 backend (streak cases, prefs validation, stats fields, reminder selection, SMTP send, missing host) + 1 frontend (streak/goal display, save goal).

FSRS tuning: optimize the FSRS parameters on my review history instead of using the library defaults, with an option to reschedule existing cards.
Completed: 21-Nov-26 15:42 UTC.
Status: Done.
Notes: New per-user SchedulerConfig + /api/fsrs (status), POST /api/fsrs/optimize (coordinate descent on log-loss of the user's own reviews, needs 50+ predictable reviews, no torch needed), POST /api/fsrs/reset, POST /api/fsrs/reschedule (replays each reviewed card's history through the current scheduler via the library's reschedule_card; keeps reps/lapses). Reviews, previews, and queue all use the user's tuned scheduler. Stats view has a Scheduler section (status, optimize/reschedule/reset with confirms and log-loss reporting). Tests: 4 backend (defaults, history gate, full tune/reschedule/reset roundtrip, per-user isolation) + 1 frontend (optimize flow).

Richer stats: true-retention tables, forecast workload, and a calendar view, so scheduling problems show up early.
Completed: 21-Nov-26 15:46 UTC.
Status: Done.
Notes: /api/stats gains retention (learning <1d / young 1-20d / mature 21d+ buckets with review counts and recall rates from graded history), workload (30-day due + daily new-card budget), feeding three new Stats sections: a True retention table, a 14-day Forecast workload table (due/new/total), and a month Calendar with prev/next navigation (studied days green, due days blue, today outlined). Tests: backend bucket math + workload shape; frontend tables + calendar navigation.

Allow limits etc to be configured as opposed to hard coded: per-deck daily limits, learning steps, and new-card order in settings instead of fixed constants like NEW_CARDS_PER_DAY.
Completed: 21-Nov-26 15:51 UTC.
Status: Done.
Notes: Deck.new_cards_per_day (None = global default, 0 resets) + new_order (position/newest) via PUT /api/decks/{id}; budgets enforced per deck and the new queue serves newest-first when set. Learning/relearning steps (minutes) are per-user scheduler settings via PUT /api/fsrs/settings and flow into grading, previews, tuning, and rescheduling. Forecast workload uses summed per-deck limits. UI: deck settings row in Browse, steps editor in the Stats Scheduler section. Tests: 6 backend (settings roundtrip/validation, per-deck budget independence, newest-first, steps affect scheduling, workload) + 2 frontend (deck save, steps save).

Tags: tag cards, edit tags in bulk, and filter browse by tag.
Completed: 21-Nov-26 15:58 UTC.
Status: Done.
Notes: Card.tags (lowercased/deduped, max 20 x 50 chars) with a (deck, tags) index. PATCH /api/cards/{id}/tags replaces one card's tags; POST /api/cards/bulk-tags adds/removes across selected cards (skips foreign/deleted). Browse ?tag= filters (exact match, skips the similarity supplement), tags ride along on rows and the card payload. UI: Filter-by-tag box, per-card Tags editor in the detail dialog, and Add/Remove tag controls in the bulk bar. Imports come in untagged. Tests: 4 backend (normalize/validation, bulk, filter) + 2 frontend (filter, detail save + bulk apply).

On the review page the Related items should only be shown once the answer to the card has been displayed, not when the question only is there. 
Completed: 21-Nov-26 16:02 UTC.
Status: Done.
Notes: The Related hint now renders only after Show answer (gated on the same showBack state as the grade buttons); the fetch still runs early so it appears instantly. Updated the related-card test to pin both halves: hidden with data loaded pre-answer, visible post-answer, queuing still works.

The review schedules are not working. I reviewed all due cards this morning and there are more due now. The counts are also incorrect. They go to 0 and then more are shown. Even though I had not finished this process yesterday when I refreshed there were no cards to review. 
Completed: 21-Nov-26 16:08 UTC.
Status: Done (root causes fixed, not a scheduler math error).
Notes: Two real defects found. (1) The header counted only due reviews while the queue also serves new cards, so it read "0 due" while new cards kept coming: /api/decks now reports new_due (unseen + within today's per-deck budget) and the header reads "N due today · M new today · K studied". (2) Refreshing during intraday learning waits (or after the budget is spent) showed a dead-end "Nothing due": /api/next now returns next_due_at (earliest future due, tz-aware) and the empty state says when the next card matures, e.g. "Nothing due right now — next card in 9m". Verified FSRS scheduling itself is correct (due <= now UTC, intraday steps by design). Tests: 3 backend (budget-scoped new_due, intraday next_due_at, deck scoping) + 1 frontend (header + next-due message).

The initial load of the first card when I am reviewing is too slow. What can be done to speed it up.
Completed: 21-Nov-26 16:11 UTC.
Status: Done.
Notes: Two measured costs removed. (1) The review queue loaded full Card documents (HTML + 1536-float embedding vectors) for the whole deck just to collect ids: _active_cards is now an ids-only values_list query. (2) Every review-page load ran a full /api/stats computation just for the studied-today count: new GET /api/today answers it with one indexed query, and the header uses that. Also folded the per-deck new-count tallies into the single existing raw states query (no extra round-trips per deck). Tests: backend today-count + ids-based queue behavior (covered by review/count suites), frontend header still shows the studied count via /api/today.

I want to be able to add cards using voice dictation. There should be a button to let me add text to the Question and another button to add to the Answer.
Completed: 21-Nov-26 16:13 UTC.
Status: Done.
Notes: New shared DictationButton (browser-native SpeechRecognition, same approach as the Feedback view) with "Dictate question" and "Dictate answer" buttons in the Add view; transcripts append into each field. The Feedback view was refactored onto the same component. Hides itself where recognition is unavailable. Test: fake-recognition dictation into both fields.

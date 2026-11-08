// Copy FSRS schedule information from smarthole_dev to smarthole_prod.
//
// What it copies, for one user (matched by email):
//   - card_states scheduling fields (fsrs_card_id, state, step, stability,
//     difficulty, due, last_review, reps, lapses, introduced_at, new_position)
//   - reviews history (rating, reviewed_at, next_due, stability, difficulty)
// It never touches card content, decks, users, or media.
//
// Why the join is needed: cards imported separately into each database get
// different ObjectIds, so states are matched on the stable Anki identity
// (deck name + anki_nid + anki_ord, falling back to anki_guid, then _id).
//
// Usage (same cluster, so one connection sees both databases):
//   mongosh "mongodb+srv://myAtlasDBUser:<pwd>@grimoire-mongo-cluster.5gmhjuk.mongodb.net/smarthole_dev" \
//     --eval "USER_EMAIL='you@example.com'" \
//     --file scripts/copy_schedule_dev_to_prod.js
// Dry run first (default): re-run with DRY_RUN=false in the --eval to write:
//     --eval "USER_EMAIL='you@example.com'; DRY_RUN=false"
//
// Safety: defaults to DRY_RUN=true (reads only, prints what it would do).

if (typeof USER_EMAIL === "undefined" || !USER_EMAIL) {
  print("Set USER_EMAIL first, e.g. --eval \"USER_EMAIL='you@example.com'\"");
  quit(1);
}
if (typeof DRY_RUN === "undefined") {
  DRY_RUN = true;
}

const DEV_DB_NAME = "smarthole_dev";
const PROD_DB_NAME = "smarthole_prod";
const STATE_FIELDS = [
  "fsrs_card_id",
  "state",
  "step",
  "stability",
  "difficulty",
  "due",
  "last_review",
  "reps",
  "lapses",
  "introduced_at",
  "new_position",
];
const REVIEW_FIELDS = ["rating", "reviewed_at", "next_due", "stability", "difficulty"];

function cardKey(deckName, nid, ord) {
  return deckName + "::" + nid + "::" + ord;
}

function findProdCard(devCard, deckName) {
  // Same _id (e.g. prod was cloned from dev incl. ObjectIds).
  const byId = prod.cards.findOne({ _id: devCard._id });
  if (byId && prodDecks[String(byId.deck)] !== undefined) return byId;
  // Stable Anki identity within the same deck name.
  const byAnki = prodByAnki[cardKey(deckName, devCard.anki_nid, devCard.anki_ord)];
  if (byAnki) return byAnki;
  if (devCard.anki_guid) {
    const byGuid = prodByGuid[deckName + "::" + devCard.anki_guid];
    if (byGuid) return byGuid;
  }
  return null;
}

const dev = db.getSiblingDB(DEV_DB_NAME);
const prod = db.getSiblingDB(PROD_DB_NAME);

const devUser = dev.users.findOne({ email: USER_EMAIL });
const prodUser = prod.users.findOne({ email: USER_EMAIL });
if (!devUser) {
  print("No user " + USER_EMAIL + " in " + DEV_DB_NAME + "; nothing to copy.");
  quit(1);
}
if (!prodUser) {
  print("No user " + USER_EMAIL + " in " + PROD_DB_NAME + "; cannot remap scheduling state.");
  quit(1);
}

// Index prod cards by stable Anki identity within this user's decks.
const prodDecks = {};
prod.decks.find({ owner: prodUser._id }).forEach((d) => {
  prodDecks[String(d._id)] = d.name;
});
const prodByAnki = {};
const prodByGuid = {};
prod.cards.find().forEach((c) => {
  const deckName = prodDecks[String(c.deck)];
  if (deckName === undefined) return; // another user's card
  prodByAnki[cardKey(deckName, c.anki_nid, c.anki_ord)] = c;
  if (c.anki_guid) prodByGuid[deckName + "::" + c.anki_guid] = c;
});

const devDecks = {};
dev.decks.find({ owner: devUser._id }).forEach((d) => {
  devDecks[String(d._id)] = d.name;
});

let matched = 0;
const missing = [];
const stateOps = [];
const prodCardIds = [];
const devCardIds = [];
const pairByDevCardId = {};

dev.card_states.find({ user: devUser._id }).forEach((s) => {
  const devCard = dev.cards.findOne({ _id: s.card });
  if (!devCard) {
    missing.push("state " + s._id + " -> dangling card ref " + s.card);
    return;
  }
  const deckName = devDecks[String(devCard.deck)];
  const target = findProdCard(devCard, deckName);
  if (!target) {
    missing.push((deckName || "?") + " / nid=" + devCard.anki_nid + " ord=" + devCard.anki_ord);
    return;
  }
  const set = {};
  STATE_FIELDS.forEach((f) => {
    set[f] = s[f] !== undefined ? s[f] : null;
  });
  stateOps.push({
    updateOne: {
      filter: { user: prodUser._id, card: target._id },
      update: { $set: set, $setOnInsert: { user: prodUser._id, card: target._id } },
      upsert: true,
    },
  });
  prodCardIds.push(target._id);
  devCardIds.push(devCard._id);
  pairByDevCardId[String(devCard._id)] = target._id;
  matched += 1;
});

// Warn about prod states that already show local reviews (expected: untouched).
const prodTouched = prod.card_states.countDocuments({
  user: prodUser._id,
  card: { $in: prodCardIds },
  reps: { $gt: 0 },
});
const devReviews = dev.reviews.countDocuments({ user: devUser._id, card: { $in: devCardIds } });
const prodReviews = prod.reviews.countDocuments({ user: prodUser._id, card: { $in: prodCardIds } });

print("dev states for " + USER_EMAIL + ": " + dev.card_states.countDocuments({ user: devUser._id }));
print("matched cards: " + matched + ", missing in prod: " + missing.length);
print("prod states with reps>0 among matched (expected 0 if prod untouched): " + prodTouched);
print("dev reviews to copy: " + devReviews + ", prod reviews that would be replaced: " + prodReviews);
if (missing.length) {
  print("Missing in prod (first 20, skipped):");
  missing.slice(0, 20).forEach((m) => print("  - " + m));
}

if (DRY_RUN) {
  print("DRY_RUN=true: no writes performed. Re-run with DRY_RUN=false to apply.");
  quit(0);
}

if (stateOps.length) {
  const res = prod.card_states.bulkWrite(stateOps, { ordered: false });
  print("card_states: matched=" + res.matchedCount + " modified=" + res.modifiedCount + " upserted=" + res.upsertedCount);
}

// Replace prod review history for the matched cards with dev's (idempotent).
prod.reviews.deleteMany({ user: prodUser._id, card: { $in: prodCardIds } });
const copies = [];
dev.reviews
  .find({ user: devUser._id, card: { $in: devCardIds } })
  .forEach((r) => {
    const targetId = pairByDevCardId[String(r.card)];
    if (!targetId) return;
    const doc = { user: prodUser._id, card: targetId };
    REVIEW_FIELDS.forEach((f) => {
      doc[f] = r[f] !== undefined ? r[f] : null;
    });
    copies.push(doc);
  });
for (let i = 0; i < copies.length; i += 1000) {
  prod.reviews.insertMany(copies.slice(i, i + 1000), { ordered: false });
}
print("reviews: copied " + copies.length + " from dev (prod had " + prodReviews + ").");
print("Done. Spot-check one card in prod, e.g. db.getSiblingDB('smarthole_prod').card_states.find({user: prodUser._id}).sort({due:1}).limit(3)");

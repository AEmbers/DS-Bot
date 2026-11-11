// The two hard gates a group round must pass. Pure functions on purpose: every judgement
// here is (room state, opener, resolved speakers) → boolean, with no I/O and no session.
// groups.js owns the effects (parking calls, posting the notice); this file owns the rules,
// which is what lets them be tested without a live round.
//
// Why these exist at all. The idle guard (ROOM_IDLE_RELAY_LIMIT) measures whether a line
// reads like filler, not whether the work is done. Six rounds of "re-run agrees, one more
// difference found" are six *different* 46-character sentences, so the streak resets every
// time and the budget never fills. A group that is stuck never looks stuck to it.
//
// Both gates answer the same question a different way: does this round add anything?
//   Gate 1 — nothing to work toward (no goal): do not wake everyone.
//   Gate 2 — the members have relayed too many times with nobody defining the subject:
//            stop relaying.

import { ROOM_REQUIRE_GOAL_FOR_BROADCAST, ROOM_TOPIC_TURN_LIMIT } from './constants.js'

// A goal only drives a room while it is `active`. `drafting` is a goal the admin is still
// writing (it has no objective yet); complete, stopped and paused have nothing more to
// drive. Anything else means the room has no objective to work toward.
export const goalRunning = room => room.goal?.status === 'active'

// Whether this opener would fan out to more than the people it names while the room has no
// running goal. Returns false for openers that are not round openings at all (see below),
// so a true answer always means "this is the broadcast gate 1 exists to stop".
//
// `speakers` is what the caller already resolved through openingCall, so the same test
// covers every entry path — a plain message in "everyone" mode, the admin's "@all", and a
// member's post that lands mid-round. One test, so those three cannot drift apart.
//
// `named` is the ids the opener addressed by @, as the caller resolved them. Naming
// someone is a request to that person, which needs no goal to be legitimate, so any named
// member at all makes this a targeted call rather than a broadcast.
export function broadcasts(room, opener, speakers, named = []) {
  if (ROOM_REQUIRE_GOAL_FOR_BROADCAST !== true) return false
  if (goalRunning(room)) return false
  // These openers are answers or bookkeeping, not round openings: the greeting a new group
  // starts with, a goal post, a finished-work or late reply, an idle goal check, and a
  // quiet post that deliberately calls nobody.
  if (opener.greet === true || opener.kickoff || opener.quiet === true) return false
  if (opener.goal !== undefined || opener.done || opener.late || opener.progress) return false
  if ((speakers ?? []).length < 2) return false
  return named.filter(id => id !== opener.botId).length === 0
}

// What to do about a broadcast the room may not have. Two different answers, because the
// two cases are not the same thing:
//
//   'refuse'  — a member's own post. A group with no objective talking to itself is exactly
//               the failure this gate is for, so the round does not start.
//   'downgrade' — the user's message. It must be answered: refusing it would make the group
//               unusable to the one person who owns it, and "you can still @Name people" is
//               no comfort to someone whose plain message got silence. So it goes to the
//               admin alone, the way a plain message already goes in admin mode. One voice,
//               not ten.
export const noGoalResponse = opener => (opener.botId === undefined ? 'downgrade' : 'refuse')

// The speakers a downgraded round runs with: the admin, once. Room admins come first so the
// voice that answers without a goal is the one that can set one. Without an admin the first
// speaker answers — a downgrade must never become silence.
export const noGoalSpeakers = (speakers, adminIds) => {
  const first = (speakers ?? []).find(bot => adminIds.includes(bot.id)) ?? (speakers ?? [])[0]
  return first === undefined ? [] : [first]
}

// How many relays members may pass between them before the room parks further ones.
//
// The budget is a *count of relays*, not a property of what they say.
//
// This is the whole lesson of the first version. Keying the budget on the message text —
// its first 40 characters, in that attempt — measures the sentence, and the failure mode
// this gate exists for is precisely "every member writes a fresh, different, plausible
// sentence each round". Five different sentences make five different keys, one round each,
// so nothing ever fills. That is the same mistake as the idle guard's 46-character reset,
// with a different quantity substituted.
//
// A relay counter cannot be evaded by rephrasing, because it never looks at the text. And
// its zero point is the right one: **the user is the one who defines a subject.** While they
// are absent, what the members do is pass work between themselves, and that chain is what
// must be bounded (收敛协议 §R1, three rounds). When the user writes, the subject is
// re-opened and the count starts again — the same moment the idle pause lifts.
//
// `relaysSinceUser` lives on the room so it survives across rounds and across the
// per-status-post rounds a stuck group spins into.
export const relaysSpent = room => room.relaysSinceUser ?? 0

// Spends one relay. Called for each bot-to-bot relay that actually calls somebody: a post
// that calls nobody moves no work, and is metered by the idle guard instead.
export function spendRelay(room) {
  room.relaysSinceUser = (room.relaysSinceUser ?? 0) + 1
  return room.relaysSinceUser
}

// Whether the chain is closed: the room has already spent its budget, so this further relay
// waits for the user. Strictly greater-than: a budget of 3 lets relays 1, 2 and 3 through and
// holds the 4th, which is "three rounds, then stop" (收敛协议 §R1) rather than "three rounds
// including the one that stops it". Measured, not assumed: with `>=` the third relay was
// already held, so the group got two rounds out of a budget of three.
export const relayBudgetExhausted = room => relaysSpent(room) > ROOM_TOPIC_TURN_LIMIT

// The subject of the chain, for the notice only. Never used for counting — the whole point
// of the counter is that it does not depend on the wording. A readable line helps the group
// know what was closed; if there is no label it falls back to a generic phrase.
export function labelRelay(room, text, headOf) {
  if (room.relayLabel !== undefined) return
  const head = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (head !== '') room.relayLabel = headOf(head, 120)
}

// The user writing here re-opens the chain and re-arms the no-goal notice: they decide the
// debate may go on.
export function clearGateState(room) {
  if (room.relaysSinceUser !== undefined) delete room.relaysSinceUser
  if (room.relayLabel !== undefined) delete room.relayLabel
  if (room.relayNoticed !== undefined) delete room.relayNoticed
  if (room.noGoalNoticed !== undefined) delete room.noGoalNoticed
}

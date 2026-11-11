// How a user's message is placed on a Session that may be busy: `'steer'` cuts the
// model call it is running and reads the message at its next step; leaving `mode` off
// queues the message for the next turn. The host owns that decision
// (`channel.js`: `body.mode === 'steer' ? 'steer' : 'queue'`), so this side produces
// either the strict string or nothing at all — a second normalization here would
// drift from the host's the first time one of them gains a value the other lacks.
//
// `steerWhileBusy` off (the default) means a message queues, exactly as before the
// preference existed.
export const sendMode = prefs => (prefs?.steerWhileBusy === true ? 'steer' : undefined)

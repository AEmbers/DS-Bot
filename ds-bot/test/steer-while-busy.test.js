import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { sendMode } from '../src/client/send-mode.js'
import { teamActions } from '../src/client/team-actions.js'
import { fakeContext } from './fake-ctx.js'

// The preference decides how a message the user sends while a Bot is busy lands on
// its Session: `steer` cuts the model call the Bot is running and the message is read
// at its next step, `queue` waits for the next turn. The host has always accepted the
// mode (`channel.js`: `body.mode === 'steer' ? 'steer' : 'queue'`); what was missing
// was the client handing it over. These tests start at the client's own `send` and
// follow the request to the `prompt` the Session actually receives, because a test of
// either half alone stays green while the wiring between them says nothing.

const TEAM = {
  version: 1,
  mainBotIds: [],
  revision: 1,
  bots: {
    b1: { id: 'b1', sessionId: 's-b1', name: 'Writer', role: 'Write', model: 'deepseek/v4', instructions: '', createdAt: 1, capabilities: [] },
  },
  rooms: {},
  agents: {},
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  works: {},
  questions: {},
  prefs: {},
}

let rt
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-steer-busy-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const prompts = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({}),
    },
    sessionController: {
      create: async () => ({ sessionId: 'fresh' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 }, followup() {} } }),
      selectModel: async () => {},
      prompt: async (request) => { prompts.push(request); return { accepted: true } },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  rt = createRuntime(ctx, { home })
  // Exactly what the client's api.js does: one POST to the plugin's own endpoint.
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  // The client the window builds: team-actions with the host call in place of a stub.
  const actions = teamActions({
    call: (endpoint, payload) => call(endpoint, payload).then((result) => {
      if (result.ok !== true) throw Object.assign(new Error(result.error?.message ?? 'request failed'), { code: result.error?.code })
      return result.value
    }),
    after: promise => promise,
    partFor: id => id,
    roster: { getSnapshot: () => ({ prefs: {} }) },
    ui: { set() {} }, live: {}, cards: {}, heldCards: {}, turnClock: {}, panelFolded: () => false,
  })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, actions, prompts, stop }
}

// The client side of the decision: the strict string, or nothing for the host default.
test('the preference decides steer, and everything else leaves the mode off', () => {
  assert.equal(sendMode({ steerWhileBusy: true }), 'steer')
  // Off, unset, and a snapshot that never arrived all mean the queued default.
  assert.equal(sendMode({ steerWhileBusy: false }), undefined)
  assert.equal(sendMode({}), undefined)
  assert.equal(sendMode(undefined), undefined)
  // Only a strict boolean counts; a truthy lookalike is not a preference.
  for (const lookalike of ['true', 1, 'steer', {}, []]) {
    assert.equal(sendMode({ steerWhileBusy: lookalike }), undefined, JSON.stringify(lookalike))
  }
})

test("a send with 'steer' reaches the Session's prompt as steer", async (t) => {
  const { actions, prompts, stop } = start()
  t.after(stop)
  await actions.send('b1', 'read this now', 'steer')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 's-b1')
  assert.equal(prompts[0].mode, 'steer')
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'read this now' }])
})

test('a send without a mode, or with anything but steer, queues', async (t) => {
  const { actions, prompts, stop } = start()
  t.after(stop)
  for (const mode of [undefined, 'queue', 'STEER', 'steering', '', null, 1]) {
    await actions.send('b1', 'later', mode)
  }
  assert.equal(prompts.length, 7)
  assert.deepEqual(prompts.map(prompt => prompt.mode), ['queue', 'queue', 'queue', 'queue', 'queue', 'queue', 'queue'])
})

test('the preference carried from the client sets the mode end to end', async (t) => {
  const { actions, prompts, stop } = start()
  t.after(stop)
  // What new-chat.js does at every send site: the third argument comes from prefs.
  await actions.send('b1', 'on', sendMode({ steerWhileBusy: true }))
  await actions.send('b1', 'off', sendMode({ steerWhileBusy: false }))
  await actions.send('b1', 'never set', sendMode(undefined))
  assert.deepEqual(prompts.map(prompt => prompt.mode), ['steer', 'queue', 'queue'])
})

test('the host keeps steerWhileBusy only as a strict boolean', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  assert.equal((await call('set-prefs', { steerWhileBusy: true })).value.steerWhileBusy, true)
  // Off is stored as absent, the way every other default-false preference is.
  assert.equal('steerWhileBusy' in (await call('set-prefs', { steerWhileBusy: false })).value, false)
  assert.equal('steerWhileBusy' in (await call('set-prefs', { steerWhileBusy: null })).value, false)
  // A type mistake is not a value: the saved preference must survive it.
  await call('set-prefs', { steerWhileBusy: true })
  for (const mistake of ['false', 'true', 0, 1, {}, []]) {
    assert.equal((await call('set-prefs', { steerWhileBusy: mistake })).value.steerWhileBusy, true, JSON.stringify(mistake))
  }
  // `set-prefs` answers with the whole prefs object, which is what the window reads.
  assert.equal((await call('set-prefs', {})).value.steerWhileBusy, true)
})

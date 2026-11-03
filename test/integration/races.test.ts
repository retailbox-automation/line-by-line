// Races between the desk, the customer and PayPal's redirects: a stale snapshot, an approval during pickup, a refresh
// during an approval, a cancel link during an authorize. Each test holds one PayPal call open at the exact moment
// the other side acts, so the interleaving is deterministic.
import { describe, expect, it } from "vitest";
import { addLine, createEstimateOrder, decide, getRepairOrder, onApproved, onCancelled, pickup, refreshApproval, type CoreDeps, type PickupResult } from "../../src/core/index.js";
import type { Db } from "../../src/db/db.js";
import { createPayPalClient, type FetchLike } from "../../src/paypal/client.js";
import { dbCallSink } from "../../src/paypal/journal.js";
import { approvedEstimate, CONSENT, estimateRo, makeEnv, type Env } from "../helpers.js";

const HOUR = 60 * 60 * 1000;

/** env.deps with a PayPal client whose every call goes through `around` (call `forward()` to reach the fake). */
function aroundDeps(env: Env, around: (url: string, init: Parameters<FetchLike>[1], forward: () => Promise<Response>) => Promise<Response>): CoreDeps {
  const paypal = createPayPalClient({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    brandName: "Bayside Auto Care",
    fetch: (url, init) => around(url, init, () => env.fake.fetch(url, init)),
    now: () => env.clock.now().getTime(),
    onCall: dbCallSink(env.db),
    retryDelayMs: 0,
    timeoutMs: 5000,
  });
  return { ...env.deps, paypal };
}

/** env.deps whose first transaction (pickup's snapshot) commits and then waits for `gate`. */
function pausedAfterFirstTx(env: Env, gate: Promise<void>, onPaused: () => void): CoreDeps {
  let txs = 0;
  const db: Db = {
    ...env.db,
    tx: async (fn) => {
      const r = await env.db.tx(fn);
      if (txs++ === 0) {
        onPaused();
        await gate;
      }
      return r;
    },
  };
  return { ...env.deps, db };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("two pickups at the same time", () => {
  it("the pickup working from an old snapshot never captures again (multi-hold repair order)", async () => {
    const env = await makeEnv();
    const est = await approvedEstimate(env);
    const rotor = await addLine(env.deps, est.ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic", urgency: "safety" });
    const { order: rotorOrder } = await decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT });
    env.fake.approve(rotorOrder!.id);
    const { authorization: rotorAuth } = await onApproved(env.deps, rotorOrder!.id);
    const performed = [
      { lineId: est.lines[0]!.id, performedCents: 26800 },
      { lineId: est.lines[1]!.id, performedCents: 0 },
      { lineId: rotor.id, performedCents: 5000 },
    ];

    // B takes its snapshot (nothing captured yet) and waits. A then settles both holds; at its last void A lets B go
    // on and waits for B to finish. Before the fix B claimed a new PayPal-Request-Id and captured again.
    const releaseB = deferred();
    const pausedB = deferred();
    const depsB = pausedAfterFirstTx(env, releaseB.promise, pausedB.resolve);
    let bDone: Promise<PickupResult> | null = null;
    const depsA = aroundDeps(env, async (url, init, forward) => {
      if (init.method === "POST" && url.endsWith(`/authorizations/${rotorAuth.id}/void`) && bDone) {
        const b = bDone;
        bDone = null;
        releaseB.resolve();
        await b.catch(() => undefined);
      }
      return forward();
    });
    const bRun = pickup(depsB, est.ro.id, performed);
    bDone = bRun;
    await pausedB.promise;
    const a = await pickup(depsA, est.ro.id, performed);
    const b = await bRun;

    expect(env.fake.posts(`/authorizations/${est.authorization.id}/capture`)).toHaveLength(1);
    expect(env.fake.posts(`/authorizations/${rotorAuth.id}/capture`)).toHaveLength(1);
    expect(env.fake.auths.get(est.authorization.id)).toMatchObject({ capturedCents: 26800, status: "VOIDED" });
    expect(env.fake.auths.get(rotorAuth.id)).toMatchObject({ capturedCents: 5000, status: "VOIDED" });
    expect(a.authorizations.map((x) => x.outcome)).toEqual(["done", "done"]);
    for (const r of b.authorizations) {
      expect(r).toMatchObject({ outcome: "in_progress", executed: [] });
      expect(r.reason).toContain("changed while this pickup was running");
    }
    const state = await getRepairOrder(env.deps, est.ro.id);
    expect(state.captures.map((c) => c.amountCents).sort()).toEqual([26800, 5000].sort());
    expect(state.authorizations.find((x) => x.id === rotorAuth.id)).toMatchObject({ capturedCents: 5000, needsAttention: null });
  });
});

describe("customer approves new work while the desk picks up", () => {
  const performedEstimate = (lines: { id: string }[]) => [
    { lineId: lines[0]!.id, performedCents: 26800 },
    { lineId: lines[1]!.id, performedCents: 14400 },
  ];

  it("an authorize in flight: pickup waits (IN_PROGRESS), then settles the new hold too", async () => {
    const env = await makeEnv();
    const est = await approvedEstimate(env);
    const rotor = await addLine(env.deps, est.ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT });
    env.fake.approve(order!.id);
    let pickupDuringAuthorize: unknown = undefined;
    const deps = aroundDeps(env, async (url, init, forward) => {
      if (init.method === "POST" && url.endsWith(`/orders/${order!.id}/authorize`) && pickupDuringAuthorize === undefined) {
        pickupDuringAuthorize = await pickup(env.deps, est.ro.id, performedEstimate(est.lines)).then(
          () => "pickup went through",
          (e: unknown) => e,
        );
      }
      return forward();
    });
    await onApproved(deps, order!.id);
    expect(pickupDuringAuthorize).toMatchObject({ code: "IN_PROGRESS" });
    expect(env.fake.posts("/capture")).toHaveLength(0);
    expect((await getRepairOrder(env.deps, est.ro.id)).repairOrder.status).toBe("open");

    const r = await pickup(env.deps, est.ro.id, [...performedEstimate(est.lines), { lineId: rotor.id, performedCents: 18600 }]);
    expect(r.authorizations.map((x) => x.outcome)).toEqual(["done", "done"]);
    for (const a of env.fake.auths.values()) expect(a.status).toBe("CAPTURED");
  });

  it("an authorize that never finished: pickup refuses until the return link finishes it", async () => {
    const env = await makeEnv();
    const est = await approvedEstimate(env);
    const rotor = await addLine(env.deps, est.ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT });
    env.fake.approve(order!.id);
    env.fake.script((c) => c.path.endsWith(`/orders/${order!.id}/authorize`), { kind: "dropResponse" }, 4);
    await expect(onApproved(env.deps, order!.id)).rejects.toMatchObject({ code: "PAYPAL" });
    await expect(pickup(env.deps, est.ro.id, performedEstimate(est.lines))).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("did not finish") });
    await onApproved(env.deps, order!.id); // the same PayPal-Request-Id: PayPal replays, the hold is recorded
    const r = await pickup(env.deps, est.ro.id, [...performedEstimate(est.lines), { lineId: rotor.id, performedCents: 18600 }]);
    expect(r.authorizations).toHaveLength(2);
    expect(env.fake.auths.size).toBe(2);
    for (const a of env.fake.auths.values()) expect(a.status).toBe("CAPTURED");
  });

  it("pickup first: the late approval is refused before any PayPal authorize", async () => {
    const env = await makeEnv();
    const est = await approvedEstimate(env);
    const rotor = await addLine(env.deps, est.ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT });
    env.fake.approve(order!.id);
    await pickup(env.deps, est.ro.id, performedEstimate(est.lines));
    await expect(onApproved(env.deps, order!.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(env.fake.posts(`/orders/${order!.id}/authorize`)).toHaveLength(0);
  });
});

describe("refresh while the customer approves the old link", () => {
  it("the old link wins: it stays, the new order is never used, pickup settles the old hold", async () => {
    const env = await makeEnv();
    const { ro, lines } = await estimateRo(env);
    const { order: old } = await createEstimateOrder(env.deps, ro.id, CONSENT);
    env.clock.advance(3 * HOUR + 1000);
    let approvedOld = false;
    const deps = aroundDeps(env, async (url, init, forward) => {
      // While PayPal creates the replacement order, the customer finishes approving the old link.
      if (!approvedOld && init.method === "POST" && url.endsWith("/v2/checkout/orders")) {
        approvedOld = true;
        env.fake.approve(old.id);
        await onApproved(env.deps, old.id);
      }
      return forward();
    });
    const r = await refreshApproval(deps, old.id);
    expect(r).toMatchObject({ refreshed: false, order: { id: old.id, status: "COMPLETED", supersededBy: null } });

    const state = await getRepairOrder(env.deps, ro.id);
    const unused = state.orders.find((o) => o.id !== old.id)!;
    expect(unused.supersededBy).toBe(old.id);
    expect(state.consents.map((c) => c.paypalOrderId)).toEqual([old.id, old.id]);
    env.fake.approve(unused.id);
    await expect(onApproved(env.deps, unused.id)).rejects.toMatchObject({ code: "CONFLICT" });

    const p = await pickup(env.deps, ro.id, [
      { lineId: lines[0]!.id, performedCents: 26800 },
      { lineId: lines[1]!.id, performedCents: 14400 },
    ]);
    expect(p.authorizations.map((a) => [a.paypalOrderId, a.outcome])).toEqual([[old.id, "done"]]);
    expect([...env.fake.auths.values()].map((a) => [a.orderId, a.status])).toEqual([[old.id, "CAPTURED"]]);
  });

  it("the refresh wins: the old link is refused without a PayPal authorize", async () => {
    const env = await makeEnv();
    const { ro } = await estimateRo(env);
    const { order: old } = await createEstimateOrder(env.deps, ro.id, CONSENT);
    env.clock.advance(3 * HOUR + 1000);
    const r = await refreshApproval(env.deps, old.id);
    expect(r.refreshed).toBe(true);
    env.fake.approve(old.id);
    await expect(onApproved(env.deps, old.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(env.fake.posts(`/orders/${old.id}/authorize`)).toHaveLength(0);
  });
});

describe("the cancel link", () => {
  it("opened while the authorize is in flight: refused, so the line never gets a second hold", async () => {
    const env = await makeEnv();
    const est = await approvedEstimate(env);
    const rotor = await addLine(env.deps, est.ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic", urgency: "safety" });
    const { order } = await decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT });
    const A = order!.id;
    env.fake.approve(A);
    let cancelDuringAuthorize: unknown = undefined;
    const deps = aroundDeps(env, async (url, init, forward) => {
      if (init.method === "POST" && url.endsWith(`/orders/${A}/authorize`) && cancelDuringAuthorize === undefined) {
        const res = await forward(); // PayPal authorizes; the answer is slow to come back
        cancelDuringAuthorize = await onCancelled(env.deps, A).then(
          () => "cancelled",
          (e: unknown) => e,
        );
        return res;
      }
      return forward();
    });
    await onApproved(deps, A);
    expect(cancelDuringAuthorize).toMatchObject({ code: "CONFLICT" });
    // A new decision on the same line is refused: it is approved and held.
    await expect(decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT })).rejects.toMatchObject({ code: "CONFLICT" });

    const r = await pickup(env.deps, est.ro.id, [
      { lineId: est.lines[0]!.id, performedCents: 26800 },
      { lineId: est.lines[1]!.id, performedCents: 14400 },
      { lineId: rotor.id, performedCents: 18600 },
    ]);
    const captured = r.authorizations.flatMap((a) => a.executed.flatMap((s) => (s.kind === "capture" ? [s.cents] : [])));
    expect(captured.reduce((x, y) => x + y, 0)).toBe(26800 + 14400 + 18600);
    expect(env.fake.auths.size).toBe(2);
  });

  it("refused while an authorize of ours is started, even if PayPal still shows the order waiting", async () => {
    const env = await makeEnv();
    const est = await approvedEstimate(env);
    const rotor = await addLine(env.deps, est.ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT });
    const at = env.clock.now().toISOString();
    await env.db.query(`INSERT INTO ops (request_id, op, entity_id, state, result, created_at, updated_at) VALUES ($1, 'authorize', $2, 'started', $3::jsonb, $4, $4)`, [
      `lbl:authorize:${order!.id}:1`,
      order!.id,
      JSON.stringify({ intent: { orderId: order!.id } }),
      at,
    ]);
    await expect(onCancelled(env.deps, order!.id)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("being authorized") });
    const state = await getRepairOrder(env.deps, est.ro.id);
    expect(state.orders.find((o) => o.id === order!.id)!.status).not.toBe("CANCELLED");
  });

  it("an order the payer already approved at PayPal is not cancelled; the return then authorizes it", async () => {
    const env = await makeEnv();
    const est = await approvedEstimate(env);
    const rotor = await addLine(env.deps, est.ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT });
    env.fake.approve(order!.id);
    await expect(onCancelled(env.deps, order!.id)).rejects.toMatchObject({ code: "CONFLICT", details: { paypalStatus: "APPROVED" } });
    let state = await getRepairOrder(env.deps, est.ro.id);
    expect(state.orders.find((o) => o.id === order!.id)!.status).toBe("PAYER_ACTION_REQUIRED");
    expect(state.lines.find((l) => l.id === rotor.id)!.status).toBe("sent");
    await expect(onApproved(env.deps, order!.id)).resolves.toMatchObject({ replayed: false, authorization: { amountCents: 18600 } });
    state = await getRepairOrder(env.deps, est.ro.id);
    expect(state.lines.find((l) => l.id === rotor.id)!.status).toBe("approved");
  });

  it("a waiting order is cancelled after PayPal confirms it is not approved; a PayPal that does not answer cancels nothing", async () => {
    const env = await makeEnv();
    const est = await approvedEstimate(env);
    const rotor = await addLine(env.deps, est.ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT });
    env.fake.script((c) => c.method === "GET" && c.path === `/v2/checkout/orders/${order!.id}`, { kind: "network" }, 4);
    await expect(onCancelled(env.deps, order!.id)).rejects.toMatchObject({ code: "PAYPAL" });
    expect((await getRepairOrder(env.deps, est.ro.id)).orders.find((o) => o.id === order!.id)!.status).toBe("PAYER_ACTION_REQUIRED");
    await expect(onCancelled(env.deps, order!.id)).resolves.toMatchObject({ status: "CANCELLED" });
    expect(env.fake.calls.filter((c) => c.method === "GET" && c.path === `/v2/checkout/orders/${order!.id}`)).toHaveLength(5);
  });
});

describe("a line held twice is billed once", () => {
  it("the later hold bills nothing for the line and is released, even when its order row says superseded", async () => {
    const env = await makeEnv();
    const est = await approvedEstimate(env);
    const rotor = await addLine(env.deps, est.ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(env.deps, est.ro.id, { approve: [rotor.id], ...CONSENT });
    env.fake.approve(order!.id);
    await onApproved(env.deps, order!.id);

    // The leftover the old races produced: a second authorized order for the same line (written directly).
    env.clock.advance(1000);
    const dup = await env.paypal.createAuthorizeOrder({
      requestId: "test:dup-order:1",
      referenceId: est.ro.id,
      customId: "test-dup",
      description: "Added work: Front brake rotors",
      items: [{ name: "Front brake rotors", unitCents: 18600, quantity: 1, category: "PHYSICAL_GOODS" }],
      returnUrl: env.deps.config.returnUrl,
      cancelUrl: env.deps.config.cancelUrl,
    });
    env.fake.approve(dup.id);
    const dupAuth = (await env.paypal.authorizeOrder({ orderId: dup.id, requestId: "test:dup-authorize:1" })).authorizations[0]!;
    const at = env.clock.now().toISOString();
    await env.db.query(
      `INSERT INTO paypal_orders (id, ro_id, purpose, line_ids, amount_cents, status, approve_url, request_id, attempt, superseded_by, created_at)
       VALUES ($1, $2, 'added', $3::jsonb, 18600, 'COMPLETED', NULL, 'test:dup-order:1', 1, $4, $5::timestamptz)`,
      [dup.id, est.ro.id, JSON.stringify([rotor.id]), order!.id, at],
    );
    await env.db.query(
      `INSERT INTO authorizations (id, paypal_order_id, ro_id, amount_cents, status, payment_source, expiration_time, created_at)
       VALUES ($1, $2, $3, 18600, 'CREATED', 'paypal', $4::timestamptz, $5::timestamptz)`,
      [dupAuth.id, dup.id, est.ro.id, dupAuth.expirationTime!.toISOString(), at],
    );

    const r = await pickup(env.deps, est.ro.id, [
      { lineId: est.lines[0]!.id, performedCents: 26800 },
      { lineId: est.lines[1]!.id, performedCents: 14400 },
      { lineId: rotor.id, performedCents: 18600 },
    ]);
    const captured = r.authorizations.flatMap((a) => a.executed.flatMap((s) => (s.kind === "capture" ? [s.cents] : [])));
    expect(captured.reduce((x, y) => x + y, 0)).toBe(26800 + 14400 + 18600);
    const second = r.authorizations.find((a) => a.paypalOrderId === dup.id)!;
    expect(second).toMatchObject({ outcome: "done", billableCents: 0, plan: [{ kind: "void" }] });
    expect(second.warnings).toEqual([`line ${rotor.id} is also held by order ${order!.id} and is billed there, not on this hold`]);
    expect(env.fake.auths.get(dupAuth.id)!.status).toBe("VOIDED");
  });
});

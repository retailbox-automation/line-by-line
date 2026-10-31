// The live sandbox scenarios of scripts/e2e-sandbox.ts, kept apart from the CLI so the tests can run them against
// the fake PayPal. Nothing here approves an order: `waitForApproval` is given by the caller (the CLI prints the link
// and polls PayPal; a test approves in the fake).

import { addLine, createEstimateOrder, createRepairOrder, decide, getRepairOrder, onApproved, pickup, reconcile, type CoreDeps } from "../src/core/index.js";
import { classify, describeError, PayPalError } from "../src/paypal/errors.js";

export const PROBE_MAX = 30;
const CONSENT = { approverName: "Sandbox Demo Customer", channel: "desk", esignConsent: true } as const;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ScenarioContext {
  deps: CoreDeps;
  waitForApproval(orderId: string, approveUrl: string | null): Promise<void>;
  check(name: string, ok: boolean, detail: string): void;
}

export function errorInfo(e: unknown) {
  return {
    outcome: classify(e),
    text: describeError(e),
    httpStatus: e instanceof PayPalError ? e.httpStatus : null,
    issue: e instanceof PayPalError ? (e.issue ?? null) : null,
    debugId: e instanceof PayPalError ? (e.debugId ?? null) : null,
  };
}

/** Estimate $412 (2 lines) -> approve -> 2 new lines (approve rotors, decline filter) -> approve -> pickup. */
export async function demoStory({ deps, waitForApproval, check }: ScenarioContext): Promise<Record<string, unknown>> {
  const { repairOrder: ro, lines } = await createRepairOrder(deps, {
    customerLabel: "Sandbox Demo Customer (made-up)",
    estimateLines: [
      { title: "Front brake pads", priceCents: 26800, source: "desk", urgency: "safety" },
      { title: "Brake fluid flush", priceCents: 14400, source: "desk", urgency: "soon" },
    ],
  });
  console.log(`repair order ${ro.id}`);
  const { order: est } = await createEstimateOrder(deps, ro.id, CONSENT);
  check("estimate order is $412.00", est.amountCents === 41200, `${est.id} ${est.amountCents} cents, ${est.status}`);
  await waitForApproval(est.id, est.approveUrl);
  const { authorization: estAuth } = await onApproved(deps, est.id);
  check(
    "estimate authorized for $412.00",
    estAuth.amountCents === 41200 && estAuth.status === "CREATED",
    `${estAuth.id} ${estAuth.status}, source ${estAuth.paymentSource}, expires ${estAuth.expirationTime?.toISOString() ?? "?"}`,
  );

  const rotor = await addLine(deps, ro.id, { title: "Front brake rotors", priceCents: 18600, urgency: "safety", source: "mechanic" });
  const filter = await addLine(deps, ro.id, { title: "Cabin air filter", priceCents: 3900, urgency: "can_wait", source: "mechanic" });
  const d = await decide(deps, ro.id, { approve: [rotor.id], decline: [filter.id], ...CONSENT });
  check("declined line got no order", d.declined.length === 1 && d.declined[0] === filter.id, `declined ${d.declined.join(", ")}`);
  if (!d.order) throw new Error("no order for the approved line");
  check("one order for the approved line", d.order.amountCents === 18600 && d.order.lineIds.length === 1, `${d.order.id} ${d.order.amountCents} cents`);
  await waitForApproval(d.order.id, d.order.approveUrl);
  const { authorization: rotorAuth } = await onApproved(deps, d.order.id);
  check("rotors authorized for $186.00", rotorAuth.amountCents === 18600, `${rotorAuth.id} ${rotorAuth.status}`);

  const result = await pickup(deps, ro.id, [
    { lineId: lines[0]!.id, performedCents: 26800 },
    { lineId: lines[1]!.id, performedCents: 13000 },
    { lineId: rotor.id, performedCents: 18600 },
  ]);
  const estR = result.authorizations.find((a) => a.authorizationId === estAuth.id);
  const rotR = result.authorizations.find((a) => a.authorizationId === rotorAuth.id);
  check(
    "estimate: capture $398.00 final_capture:false, then void",
    estR?.outcome === "done" && estR.executed.map((s) => s.kind).join(",") === "capture,void" && estR.live[estAuth.id] === "VOIDED",
    JSON.stringify({ outcome: estR?.outcome, reason: estR?.reason, executed: estR?.executed, live: estR?.live }),
  );
  check(
    "rotors: full capture, no void",
    rotR?.outcome === "done" && rotR.executed.map((s) => s.kind).join(",") === "capture" && rotR.live[rotorAuth.id] === "CAPTURED",
    JSON.stringify({ outcome: rotR?.outcome, reason: rotR?.reason, executed: rotR?.executed, live: rotR?.live }),
  );
  const recon = { [estAuth.id]: await reconcile(deps, estAuth.id), [rotorAuth.id]: await reconcile(deps, rotorAuth.id) };
  for (const [id, r] of Object.entries(recon)) check(`reconcile ${id}`, r.ok, JSON.stringify(r.diffs));
  return { roId: ro.id, pickup: result, reconcile: recon, state: await getRepairOrder(deps, ro.id) };
}

/** A $5.00 hold and $0.01 captures with final_capture:false until PayPal refuses one (or PROBE_MAX succeed). */
export async function probeCaptureLimit({ deps, waitForApproval, check }: ScenarioContext): Promise<Record<string, unknown>> {
  const { repairOrder: ro } = await createRepairOrder(deps, {
    customerLabel: "Capture limit probe (made-up)",
    estimateLines: [{ title: "Capture limit probe", priceCents: 500, source: "desk" }],
  });
  const { order } = await createEstimateOrder(deps, ro.id, CONSENT);
  await waitForApproval(order.id, order.approveUrl);
  const { authorization: auth } = await onApproved(deps, order.id);
  console.log(`probing authorization ${auth.id}`);
  const captures: { n: number; id: string; status: string; feeCents: number | null }[] = [];
  let firstError: (ReturnType<typeof errorInfo> & { at: number }) | null = null;
  for (let n = 1; n <= PROBE_MAX; n++) {
    try {
      const c = await deps.paypal.captureAuthorization({ authorizationId: auth.id, requestId: `lbl:probe:${auth.id}:${n}`, cents: 1, finalCapture: false });
      captures.push({ n, id: c.id, status: c.status, feeCents: c.feeCents });
      console.log(`capture ${n}: ${c.id} ${c.status}`);
    } catch (e) {
      firstError = { at: n, ...errorInfo(e) };
      console.log(`capture ${n} refused: ${firstError.text}`);
      break;
    }
  }
  let voidResult: unknown;
  try {
    const v = await deps.paypal.voidAuthorization({ authorizationId: auth.id, requestId: `lbl:probe-void:${auth.id}:1` });
    voidResult = { status: v?.status ?? "VOIDED" };
  } catch (e) {
    voidResult = { error: errorInfo(e) };
  }
  // Brings our row in line with PayPal (status), so the reauthorize job never picks this hold.
  const recon = await reconcile(deps, auth.id);
  const limitSeen = firstError?.outcome === "MAX_CAPTURE_COUNT_EXCEEDED";
  check(
    "capture count limit",
    true,
    limitSeen ? `MAX_CAPTURE_COUNT_EXCEEDED on capture #${firstError!.at}` : firstError ? `first refusal on #${firstError.at}: ${firstError.text}` : `no refusal in ${PROBE_MAX} captures`,
  );
  return { roId: ro.id, authorizationId: auth.id, capturesSucceeded: captures.length, captures, firstError, limitSeen, void: voidResult, reconcile: recon };
}

/** Reauthorize holds that are not in our database (the hold pool), for the same amount; read the new ids back. */
export async function reauthorizeIds({ deps, check }: ScenarioContext, ids: string[], attempt: number): Promise<Record<string, unknown>> {
  const paypal = deps.paypal;
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    try {
      const parent = await paypal.getAuthorization(id);
      const child = await paypal.reauthorize({ authorizationId: id, requestId: `lbl:reauth:${id}:${attempt}`, cents: parent.amountCents });
      const childLive = await paypal.getAuthorization(child.id);
      const parentAfter = await paypal.getAuthorization(id);
      check(
        `reauthorize ${id}`,
        child.id !== id,
        `new id ${child.id} ${childLive.status}, expires ${childLive.expirationTime?.toISOString() ?? "?"} (parent expiry ${parent.expirationTime?.toISOString() ?? "?"}, parent now ${parentAfter.status})`,
      );
      out.push({
        parentId: id,
        amountCents: parent.amountCents,
        parentExpiration: parent.expirationTime,
        newId: child.id,
        newStatus: childLive.status,
        newExpiration: childLive.expirationTime,
        parentStatusAfter: parentAfter.status,
      });
    } catch (e) {
      const info = errorInfo(e);
      check(`reauthorize ${id}`, false, info.text);
      out.push({ parentId: id, error: info });
    }
  }
  return { reauthorize: out };
}

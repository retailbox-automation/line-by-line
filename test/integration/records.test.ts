import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { addLine, createEstimateOrder, createRepairOrder, decide, getRepairOrder } from "../../src/core/index.js";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, MIGRATIONS_DIR } from "../../src/db/migrate.js";
import { wrapPglite } from "../../src/db/pglite.js";
import { approvedEstimate, CONSENT, estimateRo, makeEnv } from "../helpers.js";

describe("migrations", () => {
  it("004 keeps consent records made before it with no Florida statement choice (null)", async () => {
    const db = wrapPglite(new PGlite());
    const upTo003 = await mkdtemp(join(tmpdir(), "lbl-mig-"));
    for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => /^00[1-3]_.*\.sql$/.test(f))) await copyFile(join(MIGRATIONS_DIR, f), join(upTo003, f));
    expect(await migrate(db, upTo003)).toEqual(["001", "002", "003"]);
    await db.exec(`INSERT INTO repair_orders (id, customer_label) VALUES ('ro_old', 'Old Demo');
      INSERT INTO lines (id, ro_id, kind, title, price_cents, source) VALUES ('ln_old', 'ro_old', 'estimate', 'Pads', 18900, 'desk');
      INSERT INTO consents (id, ro_id, line_id, decision, decided_at, channel, approver_name, esign_consent, disclosure_version, amount_cents, new_total_cents)
        VALUES ('cn_old', 'ro_old', 'ln_old', 'approved', now(), 'link', 'Old Demo', true, 'FL-559.905-2026-10-31', 18900, 18900);`);
    expect(await migrate(db)).toEqual(["004"]);
    const r = await db.query<{ fl_choice: string | null; fl_limit_cents: number | null }>(`SELECT fl_choice, fl_limit_cents FROM consents WHERE id = 'cn_old'`);
    expect(r.rows).toEqual([{ fl_choice: null, fl_limit_cents: null }]);
    await rm(upTo003, { recursive: true, force: true });
  });

  it("apply once and are idempotent", async () => {
    const db = wrapPglite(new PGlite());
    expect(await migrate(db)).toEqual(["001", "002", "003", "004"]);
    expect(await migrate(db)).toEqual([]);
    const t = await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
    expect(t.rows.map((r) => r.table_name)).toEqual([
      "authorizations",
      "captures",
      "consents",
      "judge_pool",
      "judge_sessions",
      "lines",
      "model_calls",
      "ops",
      "paypal_calls",
      "paypal_orders",
      "repair_orders",
      "schema_migrations",
      "webhook_events",
    ]);
    await db.close();
  });
});

describe("repair orders and lines", () => {
  it("validates input", async () => {
    const env = await makeEnv();
    await expect(createRepairOrder(env.deps, { customerLabel: "", estimateLines: [{ title: "x", priceCents: 1, source: "desk" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createRepairOrder(env.deps, { customerLabel: "A", estimateLines: [] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createRepairOrder(env.deps, { customerLabel: "A", estimateLines: [{ title: "x", priceCents: 0, source: "desk" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createRepairOrder(env.deps, { customerLabel: "A", estimateLines: [{ title: "x", priceCents: 10.5, source: "desk" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createRepairOrder(env.deps, { customerLabel: "A", estimateLines: [{ title: "x", priceCents: 100, source: "robot" as "desk" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    const { ro } = await estimateRo(env);
    await expect(addLine(env.deps, ro.id, { title: " ", priceCents: 100, source: "mechanic" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(addLine(env.deps, "ro_missing", { title: "x", priceCents: 100, source: "mechanic" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the line order and starts every line as proposed", async () => {
    const env = await makeEnv();
    const { ro, lines } = await estimateRo(env);
    const state = await getRepairOrder(env.deps, ro.id);
    expect(state.lines.map((l) => [l.id, l.kind, l.status])).toEqual(lines.map((l) => [l.id, "estimate", "proposed"]));
    expect(state.repairOrder).toMatchObject({ status: "open", state: "FL" });
  });
});

describe("decide validation", () => {
  it("refuses empty, duplicate, estimate, unknown lines and a phone approval without the e-records consent", async () => {
    const env = await makeEnv();
    const { ro, lines } = await approvedEstimate(env);
    const rotor = await addLine(env.deps, ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    await expect(decide(env.deps, ro.id, { ...CONSENT })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(decide(env.deps, ro.id, { approve: [rotor.id], decline: [rotor.id], ...CONSENT })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(decide(env.deps, ro.id, { approve: [lines[0]!.id], ...CONSENT })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(decide(env.deps, ro.id, { approve: ["ln_nope"], ...CONSENT })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT, esignConsent: false })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT, approverName: "  " })).rejects.toMatchObject({ code: "VALIDATION" });
    // at the desk, in person, the e-records consent is not required
    await expect(decide(env.deps, ro.id, { approve: [rotor.id], approverName: "Dana Demo", channel: "desk", esignConsent: false })).resolves.toMatchObject({ order: { amountCents: 18600 } });
    expect(env.fake.requestIds("/v2/checkout/orders").filter((r) => r.startsWith("lbl:order-add"))).toHaveLength(1);
  });

  it("an estimate line is refused by decide before any PayPal call", async () => {
    const env = await makeEnv();
    const { ro, lines } = await estimateRo(env);
    await expect(decide(env.deps, ro.id, { approve: [lines[0]!.id], ...CONSENT })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.fake.posts("/v2/checkout/orders")).toHaveLength(0);
  });

  it("nothing can be decided after pickup", async () => {
    const env = await makeEnv();
    const { ro } = await approvedEstimate(env);
    const { pickup } = await import("../../src/core/index.js");
    await pickup(env.deps, ro.id, []);
    await expect(addLine(env.deps, ro.id, { title: "Late find", priceCents: 1000, source: "mechanic" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createEstimateOrder(env.deps, ro.id, CONSENT)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("estimate consent records each line with the new total and the disclosure version", async () => {
    const env = await makeEnv();
    const { ro, authorization } = await approvedEstimate(env);
    const state = await getRepairOrder(env.deps, ro.id);
    expect(state.consents).toHaveLength(2);
    for (const c of state.consents) {
      expect(c).toMatchObject({ decision: "approved", channel: "qr_page", esignConsent: true, newTotalCents: 41200, paypalAuthorizationId: authorization.id, disclosureVersion: expect.stringMatching(/^FL-559\.905/) });
    }
  });
});

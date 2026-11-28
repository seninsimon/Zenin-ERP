import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { login, setupWorld } from "./helpers.js";

// "Describe it": the AI writes a formula or drafts an automation; Zenin
// checks it (one retry with the error) and saves nothing. Only the
// description and field names go to the AI (fetch gives scripted Gemini answers).
afterEach(() => vi.unstubAllGlobals());

describe("Formulas and automations with AI", async () => {
  const admin = await login();
  const { table, user } = await setupWorld(admin, {
    columns: [
      { name: "name", label: "Customer" },
      { name: "qty", label: "Qty", type: "number" },
      { name: "amount", label: "Amount", type: "number" },
      { name: "status", label: "Status", type: "choice", options: [{ label: "Open" }, { label: "Approved" }] },
      { name: "employee", label: "Employee", type: "user" },
      { name: "approved_on", label: "Approved on", type: "date" },
    ],
  });
  await admin.post(`/api/table/${table}`, { name: "Secret Traders Ltd", qty: 120, amount: 98765, status: "Open" }).expect(200);
  afterAll(async () => {
    await admin.put("/api/ai", { provider: "gemini", removeKey: true });
  });

  // the AI's answers, in turn; what was sent to it
  const sent: string[] = [];
  const script = (...answers: object[]) => {
    sent.length = 0;
    let i = 0;
    const fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      sent.push(String(init?.body ?? ""));
      const answer = answers[Math.min(i++, answers.length - 1)];
      return new Response(
        JSON.stringify({ usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 60 }, candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(answer) }] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  const formula = (body: object) => admin.post(`/api/schema/${table}/formula/ai`, body);
  const automation = (body: object) => admin.post(`/api/schema/${table}/automations/ai`, body);

  it("is off without an AI key", async () => {
    expect((await admin.get("/api/ai/builders").expect(200)).body).toEqual({ formula: false, automation: false });
    expect((await formula({ description: "10% discount over 100" })).status).toBe(403);
    await admin.put("/api/ai", { provider: "gemini", key: "AIzaTEST-gemini-key-0123456789abcdef" }).expect(200);
    expect((await admin.get("/api/ai/builders").expect(200)).body).toEqual({ formula: true, automation: true });
    expect((await user.get("/api/ai/builders")).status).toBe(403);
  });

  it("writes a formula that compiles; only names go to the AI", async () => {
    const fetch = script({ possible: true, formula: "IF({qty} > 100, {amount} * 0.1, 0)", says: "10% of Amount when Qty is over 100, otherwise 0", reason: "" });
    const res = await formula({ description: "10% discount when qty is over 100", column: "approved_on", resultType: "number" });
    // approved_on is a date: the number formula doesn't fit, it retries once, then says so
    expect(res.status).toBe(422);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent[1]).toContain("Zenin said");

    script({ possible: true, formula: "IF({qty} > 100, {amount} * 0.1, 0)", says: "10% of Amount when Qty is over 100, otherwise 0", reason: "" });
    const ok = await formula({ description: "10% discount when qty is over 100", label: "Discount", resultType: "number" }).expect(200);
    expect(ok.body).toEqual({ expression: "IF({qty} > 100, {amount} * 0.1, 0)", says: "10% of Amount when Qty is over 100, otherwise 0", type: "number" });
    expect(sent[0]).toContain("{qty}");
    expect(sent[0]).toContain("Discount");
    expect(sent.join()).not.toMatch(/Secret Traders|98765/);
  });

  it("fixes a wrong formula once, with Zenin's error", async () => {
    const fetch = script(
      { possible: true, formula: "{qty} *", says: "x", reason: "" },
      { possible: true, formula: "{qty} * 2", says: "Twice the Qty", reason: "" }
    );
    const res = await formula({ description: "double the qty", column: "amount", resultType: "number" }).expect(200);
    expect(res.body.expression).toBe("{qty} * 2");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent[1]).toMatch(/Your last formula was: \{qty\} \*/);
  });

  it("says plainly when it can't be done", async () => {
    script({ possible: false, formula: "", says: "", reason: "A formula can't add up other records: use a Total field." });
    const res = await formula({ description: "sum of all invoices of this customer", column: "amount" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/use a Total field/);
    expect((await formula({ description: "x" })).status).toBe(400); // too short
  });

  it("drafts an automation with the form's own checks; nothing is saved", async () => {
    const fetch = script(
      // "Approve" isn't an option: retried with the error
      { possible: true, reason: "", trigger: { when: "changed", column: "status", to: "Approve" }, actions: [{ do: "notify", who: "employee", message: "Approved", column: "", value: "" }] },
      {
        possible: true,
        reason: "",
        trigger: { when: "changed", column: "status", to: "Approved" },
        actions: [
          { do: "notify", who: "employee", message: "Your request was approved", column: "", value: "" },
          { do: "set", who: "", message: "", column: "approved_on", value: "today" },
        ],
      }
    );
    const res = await automation({ description: "when it's approved tell the employee and put today's date in approved on" }).expect(200);
    expect(res.body).toEqual({
      trigger: { when: "changed", column: "status", to: "Approved" },
      actions: [
        { do: "notify", who: "employee", message: "Your request was approved" },
        { do: "set", column: "approved_on", value: "today" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent[1]).toMatch(/isn't an option of Status/);
    expect(sent.join()).not.toMatch(/Secret Traders|98765/);
    expect((await admin.get(`/api/schema/${table}/automations`).expect(200)).body).toEqual([]);
  });

  it("each has its own switch; staff can't use them", async () => {
    await admin.put("/api/ai", { features: { automationAi: false } }).expect(200);
    expect((await automation({ description: "tell the creator when added" })).status).toBe(403);
    expect((await admin.get("/api/ai/builders").expect(200)).body).toEqual({ formula: true, automation: false });
    await admin.put("/api/ai", { features: { automationAi: true } }).expect(200);
    expect((await user.post(`/api/schema/${table}/formula/ai`, { description: "double the qty" })).status).toBe(403);
  });
});

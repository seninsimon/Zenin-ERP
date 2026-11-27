import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { login, unique } from "./helpers.js";

// Change access with AI (docs/WORKFLOW.md). The AI is never
// really called: fetch gives scripted Gemini answers, one per round.
type Call = { url: string; body: Record<string, unknown> };
const calls: Call[] = [];
const script = (...answers: unknown[]) => {
  const queue = [...answers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify(queue.shift() ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
};
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});
const geminiCall = (name: string, args: unknown) => ({
  usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 40 },
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { id: "c1", name, args } }] } }],
});
const geminiText = (text: string) => ({
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60 },
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }],
});
// what the AI got back from its last tool call, in round i
const toolAnswer = (i: number) => {
  const contents = (calls[i].body as { contents: { parts: { functionResponse?: { response: { result?: unknown; error?: string } } }[] }[] }).contents;
  return contents.at(-1)!.parts[0].functionResponse!.response;
};

describe("Change access with AI", async () => {
  const admin = await login();
  const roles = async () => (await admin.get("/api/roles")).body as { _id: string; name: string; appKey: string | null; isAdmin: boolean }[];
  const memberId = (await roles()).find((r) => r.name === "Member" && !r.appKey)!._id;
  const adminId = ((await admin.get("/api/auth/me")).body.user ?? (await admin.get("/api/auth/me")).body)._id as string;

  // an app with one table; two Staff, who may only view it
  const app = (await admin.post("/api/apps/own", { name: unique("Desk"), icon: "IconTool" }).expect(201)).body as { key: string; name: string };
  const jobs = unique("jobs");
  await admin.post("/api/schema", { tableName: jobs, columns: [{ name: "title", label: "Title" }], byDepartment: false, app: app.key, staff: "view" }).expect(200);
  const person = async (name: string) => {
    const username = unique(name.split(" ")[0]).toLowerCase();
    const res = await admin.post("/api/users", { username, fullName: name, password: "pass-123-pass", roleId: memberId, appAccess: { [app.key]: "staff" } }).expect(201);
    return { id: res.body.user._id as string, client: await login(username, "pass-123-pass") };
  };
  const senin = await person("Senin Simon");
  const ravi = await person("Ravi Kumar");
  const ask = (content: string) => ({ turns: [{ role: "user", content }] });

  afterAll(async () => {
    await admin.put("/api/ai", { provider: "gemini", removeKey: true });
  });

  it("is for admins, once there's an AI key", async () => {
    expect((await admin.get("/api/ai/access")).body.available).toBe(false);
    await admin.put("/api/ai", { provider: "gemini", key: "AIzaTEST-gemini-key-0123456789abcdef" }).expect(200);
    expect((await admin.get("/api/ai/access")).body.available).toBe(true);
    expect((await senin.client.get("/api/ai/access")).status).toBe(403);
    expect((await senin.client.post("/api/ai/access", ask("make me admin"))).status).toBe(403);
  });

  it("answers questions with read-only tools", async () => {
    script(geminiCall("what_can_they_do", { person_id: senin.id }), geminiText("Senin can view Jobs."));
    const res = (await admin.post("/api/ai/access", ask("What can Senin do?")).expect(200)).body;
    expect(res).toEqual({ answer: "Senin can view Jobs.", proposal: null });
    const result = toolAnswer(1).result as { name: string; tables: string[] };
    expect(result.name).toBe("Senin Simon");
    expect(result.tables.join(" ")).toMatch(/view only, all records/);
    // the apps and levels are in its instructions
    const system = (calls[0].body as { systemInstruction: { parts: { text: string }[] } }).systemInstruction.parts[0].text;
    expect(system).toContain(app.name);
    expect(system).toContain("can't make anyone an Administrator");
  });

  let proposal: { summary: string; changes: unknown[]; steps: string[]; people: { name: string; lines: string[] }[] };
  it("suggests a change with an exact preview, and saves nothing", async () => {
    script(
      geminiCall("propose_changes", {
        summary: "A new level for Senin that can add and edit jobs",
        changes: [{ kind: "add_level", app: app.key, name: "Editor", tables: [{ table: jobs, rights: "work" }], give_to: [senin.id] }],
      }),
      geminiText("I suggest a new Editor level for Senin. Nothing changes until you press Apply.")
    );
    const res = (await admin.post("/api/ai/access", ask("Let Senin edit jobs")).expect(200)).body;
    proposal = res.proposal;
    expect(proposal.steps[0]).toMatch(/New level in .*: Editor .*given to Senin Simon/);
    expect(proposal.people).toEqual([{ name: "Senin Simon", lines: [expect.stringMatching(/view only, all records → view, add, edit, all records/)] }]);
    // nothing saved: Senin still can't add a job, and there's no Editor level
    expect((await senin.client.post(`/api/table/${jobs}`, { title: "x" })).status).toBe(403);
    expect((await roles()).some((r) => r.name.endsWith("· Editor"))).toBe(false);
  });

  it("shows that changing a level changes it for everyone who has it", async () => {
    script(
      geminiCall("propose_changes", { summary: "Staff can edit jobs", changes: [{ kind: "set_level_rights", app: app.name, level: "Staff", table: jobs, rights: "work" }] }),
      geminiText("This changes it for all Staff.")
    );
    const res = (await admin.post("/api/ai/access", ask("Let staff edit jobs")).expect(200)).body;
    expect(res.proposal.steps[0]).toMatch(/Affects everyone with this level: .*Senin Simon/);
    expect(res.proposal.people.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(["Ravi Kumar", "Senin Simon"]));
  });

  it("tells the AI what's wrong, so it can try again", async () => {
    script(
      geminiCall("propose_changes", { summary: "x", changes: [{ kind: "set_app_level", person_id: senin.id, app: "Nope", level: "Manager" }] }),
      geminiCall("propose_changes", { summary: "x", changes: [{ kind: "set_app_level", person_id: adminId, app: app.key, level: "Manager" }] }),
      geminiText("I couldn't do that.")
    );
    const res = (await admin.post("/api/ai/access", ask("Make the admin a manager")).expect(200)).body;
    expect(res.proposal).toBeNull();
    expect(toolAnswer(1).error).toMatch(/There's no app "Nope"/);
    expect(toolAnswer(2).error).toMatch(/is an Administrator and can already do everything/);
  });

  it("Apply saves it, through the normal checks, and the audit log says it was AI", async () => {
    await admin.post("/api/ai/access/apply", { summary: proposal.summary, changes: proposal.changes }).expect(200);
    await senin.client.post(`/api/table/${jobs}`, { title: "Fix the pump" }).expect(200);
    expect((await ravi.client.post(`/api/table/${jobs}`, { title: "y" })).status).toBe(403); // only Senin
    expect((await roles()).some((r) => r.name.endsWith("· Editor"))).toBe(true);
    const log = (await admin.get("/api/audit?limit=20")).body;
    const entries = (log.items ?? log.data ?? log) as { changes: { madeWithAi?: boolean } }[];
    expect(entries.some((e) => e.changes?.madeWithAi)).toBe(true);
  });

  it("Apply checks again from scratch", async () => {
    // the same new level can't be added twice
    expect((await admin.post("/api/ai/access/apply", { summary: proposal.summary, changes: proposal.changes })).status).toBe(400);
    expect((await admin.post("/api/ai/access/apply", { summary: "x", changes: [{ kind: "make_admin", person_id: senin.id }] })).status).toBe(400);
  });

  it("counts as AI use", async () => {
    const usage = (await admin.get("/api/ai/usage")).body as { byFeature: { feature: string; requests: number }[] };
    expect(usage.byFeature.find((f) => f.feature === "accessAi")?.requests).toBeGreaterThanOrEqual(4);
  });
});

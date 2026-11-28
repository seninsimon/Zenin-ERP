import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, unique } from "./helpers.js";

type Col = { source: string; name: string; label: string; type: string; include: boolean; required?: boolean; options?: string[]; link?: { table: string } };
type Tbl = { key: string; source: string; tableName: string; columns: Col[] };
type Logic = { kind: string; name: string; table?: string; zenin: string; needsPerson: boolean; explained: boolean; summary?: string; suggestion?: string };
type Mig = { _id: string; status: string; plan: { tables: Tbl[]; logic?: Logic[] }; result: { tables: { rowsInFile: number; imported: number; totals: { match: boolean }[] }[]; allMatch: boolean } | null };

// Bring your data, parts 2 and 3: database dumps, and the AI's report on
// the old system's logic (fetch gives a scripted Gemini answer).
afterEach(() => vi.unstubAllGlobals());

describe("Bring your data: database dumps", async () => {
  const admin = await login();
  const tag = unique("d").toLowerCase().replace(/[^a-z0-9]/g, "");
  await admin.put("/api/migration/settings", { enabled: true }).expect(200);
  afterAll(async () => {
    await admin.put("/api/migration/settings", { enabled: false });
    await admin.put("/api/ai", { provider: "gemini", removeKey: true });
  });
  const upload = (text: string, name: string) => admin.upload("/api/migration/upload").attach("files", Buffer.from(text), name);
  const col = (t: Tbl, source: string) => t.columns.find((c) => c.source === source)!;

  const mysql = `-- MySQL dump 10.13
/*!40101 SET NAMES utf8mb4 */;
CREATE TABLE \`cust_${tag}\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`name\` varchar(100) NOT NULL,
  \`phone\` bigint DEFAULT NULL,
  \`status\` enum('active','blocked','closed') DEFAULT 'active',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_name\` (\`name\`)
) ENGINE=InnoDB;
INSERT INTO \`cust_${tag}\` VALUES (1,'O''Brien & Co',9847000001,'active'),(2,'Shop; Two',NULL,'blocked'),(3,'Third',9847000003,'active');
CREATE TABLE \`ord_${tag}\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`customer_id\` int NOT NULL,
  \`total\` decimal(10,2) NOT NULL,
  \`paid\` tinyint(1) DEFAULT '0',
  \`placed_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`fk_c\` (\`customer_id\`),
  CONSTRAINT \`fk_c\` FOREIGN KEY (\`customer_id\`) REFERENCES \`cust_${tag}\` (\`id\`)
);
INSERT INTO \`ord_${tag}\` (\`id\`,\`customer_id\`,\`total\`,\`paid\`,\`placed_at\`) VALUES (1,1,100.50,1,'2026-03-04 10:00:00'),(2,2,250.00,0,NULL),(3,1,49.50,1,'2026-03-05 09:30:00');
DELIMITER ;;
CREATE DEFINER=\`root\`@\`%\` TRIGGER trg_paid_${tag} BEFORE UPDATE ON \`ord_${tag}\` FOR EACH ROW BEGIN IF NEW.paid = 1 THEN SET NEW.placed_at = NOW(); END IF; END ;;
CREATE PROCEDURE month_end_${tag}() BEGIN UPDATE ord_${tag} SET paid = 1 WHERE total < 1; END ;;
DELIMITER ;
`;

  let mig: Mig;
  it("reads a MySQL dump: types, keys, links, an enum, and the logic", async () => {
    const res = await upload(mysql, "shop.sql");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    mig = res.body;
    const [cust, ord] = mig.plan.tables;
    expect(col(cust, "id").include).toBe(false); // the database's own numbering
    expect(col(cust, "name")).toMatchObject({ type: "text", required: true });
    expect(col(cust, "phone").type).toBe("text"); // a phone, never added up
    expect(col(cust, "status")).toMatchObject({ type: "choice", options: ["active", "blocked", "closed"] });
    expect(col(ord, "customer_id")).toMatchObject({ type: "relation", label: "Customer", link: { table: cust.key } });
    expect(col(ord, "total")).toMatchObject({ type: "number", required: true });
    expect(col(ord, "paid").type).toBe("boolean");
    expect(col(ord, "placed_at").type).toBe("date");
    expect(mig.plan.logic!.map((l) => [l.kind, l.name, l.table ?? null, l.zenin, l.needsPerson])).toEqual([
      ["trigger", `trg_paid_${tag}`, `ord_${tag}`, "automation", true],
      ["procedure", `month_end_${tag}`, null, "none", true],
    ]);
  });

  it("imports it with links, and the totals match", async () => {
    await admin.post(`/api/migration/${mig._id}/import`).expect(202);
    await drainJobs();
    mig = (await admin.get(`/api/migration/${mig._id}`).expect(200)).body;
    expect(mig.status, JSON.stringify(mig)).toBe("done");
    expect(mig.result!.allMatch).toBe(true);
    expect(mig.result!.tables.map((t) => [t.rowsInFile, t.imported])).toEqual([[3, 3], [3, 3]]);
    const cust = (await admin.get(`/api/table/cust_${tag}?limit=10&withRaw=1`)).body.data as { _id: string; _raw: { name: string } }[];
    const obrien = cust.find((c) => c._raw.name === "O'Brien & Co")!._id;
    const orders = (await admin.get(`/api/table/ord_${tag}?limit=10&withRaw=1`)).body.data as { _raw: Record<string, unknown> }[];
    expect(orders.filter((o) => o._raw.customer_id === obrien).length).toBe(2);
    expect(orders.map((o) => o._raw.placed_at).sort()).toEqual(["2026-03-04", "2026-03-05", null]);
    const schema = (await admin.get(`/api/schema/ord_${tag}`)).body;
    expect(schema.columns.find((c: { name: string }) => c.name === "total").required).toBe(true);
    await admin.del(`/api/migration/${mig._id}`).expect(200);
  });

  it("reads a Postgres dump: an enum type, COPY rows and yes/no as t / f", async () => {
    const pg = `CREATE TYPE public.mood_${tag} AS ENUM ('happy', 'sad');
CREATE TABLE public.people_${tag} (id integer NOT NULL, name text NOT NULL, mood public.mood_${tag}, active boolean, joined timestamp with time zone);
ALTER TABLE ONLY public.people_${tag} ADD CONSTRAINT people_pkey PRIMARY KEY (id);
CREATE FUNCTION public.greet_${tag}(n text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RETURN 'Hello ' || n; END; $$;
CREATE VIEW public.happy_${tag} AS SELECT * FROM public.people_${tag} WHERE mood = 'happy';
COPY public.people_${tag} (id, name, mood, active, joined) FROM stdin;
1	Asha	happy	t	2026-01-05 10:00:00+05:30
2	Biju\\tK	sad	f	\\N
\\.
`;
    const res = await upload(pg, "people.sql");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const m: Mig = res.body;
    const [people] = m.plan.tables;
    expect(col(people, "mood")).toMatchObject({ type: "choice", options: ["happy", "sad"] });
    expect(col(people, "active").type).toBe("boolean");
    expect(col(people, "joined").type).toBe("date");
    expect(col(people, "name").type).toBe("textarea"); // a text column in Postgres
    expect(m.plan.logic!.map((l) => [l.kind, l.zenin])).toEqual([["function", "none"], ["view", "report"]]);
    await admin.del(`/api/migration/${m._id}`).expect(200);
  });

  it("reads triggers and views the way a real mysqldump writes them", async () => {
    const real = `CREATE TABLE \`t_${tag}\` (\`id\` int NOT NULL, \`gst_pct\` int, PRIMARY KEY (\`id\`));
INSERT INTO \`t_${tag}\` VALUES (1,5),(2,12),(3,18),(4,5),(5,12);
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=\`root\`@\`localhost\`*/ /*!50003 TRIGGER \`trg_real_${tag}\` BEFORE INSERT ON \`t_${tag}\` FOR EACH ROW BEGIN SET NEW.id = NEW.id; END */;;
DELIMITER ;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=\`root\`@\`localhost\` SQL SECURITY DEFINER */
/*!50001 VIEW \`v_real_${tag}\` AS select 1 AS \`one\` */;`;
    const m: Mig = (await upload(real, "real.sql").expect(201)).body;
    expect(m.plan.logic!.map((l) => [l.kind, l.name])).toEqual([["trigger", `trg_real_${tag}`], ["view", `v_real_${tag}`]]);
    expect(col(m.plan.tables[0], "gst_pct").type).toBe("number"); // a GST rate is a number; only a GSTIN is an ID
    await admin.del(`/api/migration/${m._id}`).expect(200);
  });

  it("the AI explains the old logic; nothing is created from it", async () => {
    const res = await upload(mysql.replace(/_\${tag}/g, `_${tag}x`).replaceAll(tag, `${tag}x`), "shop2.sql");
    const m: Mig = res.body;
    // no AI yet
    expect((await admin.post(`/api/migration/${m._id}/explain`)).status).toBe(400);
    await admin.put("/api/ai", { provider: "gemini", key: "AIzaTEST-gemini-key-0123456789abcdef" }).expect(200);
    const answer = {
      items: [
        { name: `trg_paid_${tag}x`, summary: "When an order is marked paid, it records the time.", zenin: "automation", suggestion: "Automation on Orders: when Paid becomes Yes, set Placed at to today.", needsPerson: false },
        { name: `month_end_${tag}x`, summary: "Marks tiny orders as paid at month end.", zenin: "none", suggestion: "A person should decide if this is still wanted.", needsPerson: false },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 80 }, candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(answer) }] } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const explained: Mig = (await admin.post(`/api/migration/${m._id}/explain`).expect(200)).body;
    expect(explained.plan.logic!.map((l) => [l.name, l.zenin, l.needsPerson, l.explained])).toEqual([
      [`trg_paid_${tag}x`, "automation", false, true],
      [`month_end_${tag}x`, "none", true, true], // "none" always needs a person
    ]);
    expect(explained.plan.logic![0].suggestion).toMatch(/when Paid becomes Yes/);
    // switched off in Settings → AI
    await admin.put("/api/ai", { features: { migrationAi: false } }).expect(200);
    expect((await admin.post(`/api/migration/${m._id}/explain`)).status).toBe(400);
    await admin.put("/api/ai", { features: { migrationAi: true } }).expect(200);
    await admin.del(`/api/migration/${m._id}`).expect(200);
  });
});

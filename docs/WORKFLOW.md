# How ERP - Zenin works, and how to work on it

This guide explains how the system behaves end to end, and the workflow for
changing it. For setup and commands, see [COMMANDS.md](COMMANDS.md). For the
architecture and data model, see [README.md](../README.md).

- [1. The big picture](#1-the-big-picture)
- [2. Admin workflow: setting up access](#2-admin-workflow-setting-up-access)
- [3. What happens on a request](#3-what-happens-on-a-request)
- [4. Records: validation, departments, files](#4-records-validation-departments-files)
- [5. Apps](#5-apps-administration--manage-apps)
- [6. Background jobs: CSV import and export](#6-background-jobs-csv-import-and-export)
- [7. Audit log](#7-audit-log)
- [8. Development workflow](#8-development-workflow)
- [9. Recipes](#9-recipes)
- [10. Conventions](#10-conventions)

---

## 1. The big picture

```
Browser ──▶ nginx (web) ──▶ API (Express) ──▶ PostgreSQL
                                  │                ▲
                                  ├──▶ RustFS (S3) │
                                  │                │
                         NOTIFY   ▼                │
                              Worker ──────────────┘
```

| Piece | Job |
|---|---|
| **web** | nginx serving the React app; forwards `/api` and `/uploads` to the API |
| **api** | all HTTP endpoints: auth, schemas, records, files, audit, job queueing |
| **worker** | runs queued jobs (CSV import/export) and housekeeping |
| **db** | PostgreSQL: system tables in `public`, one table per ERP table in `erp_data` |
| **storage** | RustFS: uploaded files, export files, import uploads |

The API and the worker are the **same codebase and Docker image**; they differ
only in the entry point (`server.ts` / `worker.ts`). In local development the API
also runs the worker loop itself (`RUN_WORKER=true`), so you only start one
process.

---

## 2. Admin workflow: setting up access

The whole model in three sentences:
1. **Everything is in apps.** For each app, a person has one **level**: No
   access, Staff, Manager, or a level you added. Or they're an
   **Administrator**, who can do everything.
2. **A level says what it can do in each of the app's tables,** and whether
   only in their own records.
3. **Departments are just teams.** They limit records only on a table split
   by department.

| Concept | Decides | Set in |
|---|---|---|
| **Administrator** | Everything, including Administration | Users → the person (a switch) |
| **App access** | Their level in each app: No access / Staff / Manager / an added level | Users → the person |
| **Access levels** | What each level can do in each table of its app | Administration → Access levels |
| **Department** | Which team they're in (and, on "each department" tables, whose records they see) | Users → the person |
| **Who sees the records** | Per table: everyone with access, or split by department | Tables → the table → Access |
| **Visible to** | Which departments see one record (only on "each department" tables) | The record form |

**With apps** (the usual way): add apps in **Manage apps** (a new system
offers "Add these 3": HR & leave, Expense claims and Projects). Each app
brings its tables and levels. Then **Add person**
(Users) for each person: name, login, department, and app access. With the
People directory installed, the same form adds their directory entry, linked
to the login, with their department filled in.

**Many people at once: Import people** (Users, `controllers/peopleImport.ts`):
1. **Download template** (`GET /users/import/template`): Full name, Username,
   Email, Phone, Departments, then one column per app (as in App access).
   An app's cell is a level's name (Staff, Manager, an added level) or empty.
   Departments are names separated by `;`.
2. **Check file** (`POST /users/import/check {csv}`): every row with its
   problems; nothing is saved. Problems: no Full name, a bad email, an email
   or username already here or twice in the file, an unknown department or
   level. An empty Username is made from the email or name (`meera.nair`,
   then `meera.nair2`). At most 500 rows.
3. **Add** (`POST /users/import {csv, addToDirectory}`): the good rows only.
   - Everyone is a **Member** with the app levels from the file. Never an
     Administrator by import.
   - With an email, and email set up (including "Links in emails go to"):
     the **welcome link**. Otherwise a **temporary password** (`abcd-efgh-jkmn`,
     no look-alike characters) with `must_change_password` set.
   - The answer carries two CSV files, made once: the temporary passwords
     (the dialog asks before closing without downloading them) and the rows
     not added, with a "Problem" column, to fix and import again.
   - Each person is in the audit log (`changes.imported = true`), plus their
     People directory entry when ticked.
   - Gmail sends about 500 emails a day: with more than 300 welcome emails
     the dialog suggests importing in parts.

**A temporary password** (`users.must_change_password`, migration 018): until
they choose their own, `requireAuth` answers every request with 403 "Choose a
new password first", except `GET /auth/me` and `PUT /auth/password`. The web
shows "Welcome, <name>: choose your own" instead of the app (it asks for the
temporary password again only after a reload). Changing the password, or
using a welcome/reset link, clears it.

**Disable several at once** (`POST /users/disable {ids}`): tick people in the
Users list → Disable. Never yourself, never the last active administrator
(those come back as `skipped` with the reason). They're signed out everywhere;
each is in the audit log.

**The person dialog** prevents mistakes instead of explaining them:
- **Administrator** is one switch; it hides App access (they can do
  everything). The API still takes `roleId` (Admin or Member).
- **Same access as…** copies another person's departments and app levels
  into the form (never Administrator). Nothing is saved until Save.
- **A suggestion** for a new person in a department: the app levels at least
  half of the people there have ("Most people in their department have: …
  [Use these]"). Worked out in the browser from the users list.
- **A warning at the moment it matters:** choosing Manager in an app with a
  `managerNote` in its blueprint shows it ("They'll see everyone's salary and
  payslips"). Payroll, HR & leave, Clinic and Expense claims have one.
- Apps with more than two levels show a list instead of buttons.

**Levels under the hood** (`src/auth/levels.ts`). A level is the app's role
of that level (`roles.app_key`, `app_level`; "HR & leave · Manager"). An app
shown as one in the launcher (Company = People + Customers + Products) has one
role per part, all with the same `app_level`. A person has a main role
(**Admin** or **Member**) plus their level roles; rights add up
(`mergePermissions`: where one role shows the whole table, "own only" extras
from others are dropped; nobody gets more than one of their roles gave).
- **Administration → Access levels** (`GET /access-levels`): **one app at a
  time, as a grid.** The apps are listed on the left (a list with search from
  nine apps on; a dropdown on phones); `?app=` opens one, and a table's Access
  card links to its app. Rows are the app's tables (the name column stays put
  while the levels scroll sideways); columns are its levels with how many
  people have each, and a menu for Reset / Remove. Each cell: one choice
  (No access / View / View + add / View, add, edit / Everything / Custom…)
  and a person toggle for **only their own records**. A cell that matches
  no simple choice shows a short summary ("View, edit") and its four ticks
  after **Change**. Changed cells are outlined; one **Save changes** for the
  app, with a count; changes are kept when switching apps (a dot marks the
  app). Saving sends `PUT /access-levels/:app/:level { permissions }` for
  each changed level, which replaces what it may do in the app's tables (a
  table of another app is refused).
- **Add a level** (`POST /access-levels/:app { name }`): starts with no
  access. **Remove level** (`DELETE …/:level`) only for added levels, and
  not while an approval option or Ask Zenin names it.
- **Reset to the app's defaults** (`POST …/:level/reset`): Staff and Manager
  of a ready-made app back to its blueprint (`defaultRolePerms()`); tables
  added to the app keep their rights.
- Approval options ("Only these levels can choose this") and Ask Zenin's
  "Only these levels" offer levels.
- The API still accepts roles of no app (`POST /roles`, used by the tests).
  The screens never make them.

**Fields only some levels see** (`src/auth/fields.ts`). A column's **Who sees
this field** (column dialog): everyone who can use the table, or only some
levels of the table's app (`column.onlyLevels`, level keys; Manager ticked
by default). Admins always see it. The columns list shows a badge.
- `hiddenColumns(user, schema)` decides it: limited fields the person has no
  level for, plus formulas that use a hidden field and totals (rollups) over
  a hidden field or `where` column of another table, repeated until nothing
  changes. `limitedColumns(schema)` is the same for "anyone but admins".
- **Reading:** `listForUser` (lists, Ask Zenin), `?raw=1`, the record, the
  save preview (`readBack`, lines too), exports (header and cells) and record
  history (non-admins: hidden keys taken out of `changes`) leave hidden
  fields out. `GET /schema` and `/schema/:table` don't describe them, so the
  screens never show them. Ask Zenin's instructions don't list them.
- **Search** takes hidden fields out before matching
  (`erp_search_text(t.data - hidden)`; that search doesn't use the trigram
  index). **Filtering or sorting** by a hidden field is refused (400), in
  lists, Ask Zenin and exports.
- **Writing:** create, update, bulk update and line items refuse a hidden
  field (403); a CSV with a column for one fails with "You can't import into
  …". A hidden required field doesn't block people who can't fill it in
  (`checkRequired(…, skip)`).
- **Sent to many people at once,** a limited field never appears: emails'
  record details, the morning summary's date, and an automation's "X is now
  …" title (it becomes "X changed").
- **The field that names records** (links, notifications, emails) can't be
  limited (400 "… names each record"), and `pickDisplayField` never picks a
  limited one, even when a request asks for it (`?displayField=`).
- Not covered (good to know): an uploaded file's address (`/uploads/<key>`)
  works for anyone logged in who has it. Hidden file fields never send their
  addresses, and the keys are random.

**Change access with AI** (AI · Beta, admins; `src/ai/accessAssistant.ts`).
Users → **Tell Zenin what to change**, shown when there's an AI key and the
"Change access with AI" switch is on (Administration → AI; on by default,
like Draft apps).
- `POST /ai/access { turns }` → `{ answer, proposal }`. The AI has read-only
  tools (find_people, what_can_they_do, who_can_use, app_levels) and one
  `propose_changes` tool. Its instructions say: pick the smallest change;
  for one person, don't change a level others have (add a small level
  instead); never Administrators.
- **A suggestion is worked out in memory** (`simulate()`): the company's
  roles, people and departments are copied, the changes applied, and each
  touched person's access is worked out with `personAccess()`, the same
  function as "What they can do", before and after. The preview lists each
  step ("Affects everyone with this level: …"), each person's changed tables
  ("Deals: view only, all records → everything, all records"), and Manager
  warnings. Mistakes (an unknown app, an Administrator) go back to the AI as
  errors so it can try again.
- Changes it can suggest: `set_app_level`, `set_level_rights`, `add_level`
  (with rights, given to people), `set_departments`. There is no change that
  makes or touches an Administrator.
- **Apply** (`POST /ai/access/apply { summary, changes }`) checks everything
  again from scratch, then saves through the normal functions
  (`rolesForAccess`/`updateUser`, `addLevel`, `saveLevel`). Each change is in
  the audit log with `madeWithAi: true`. Use is counted as `accessAi`.
- The conversation code shared with Ask Zenin is `src/ai/toolChat.ts`
  (`chatWithTools`: Claude, Gemini and ChatGPT with tools).

**Moving older roles** (roles of no app other than Admin and Member, from
before levels). Access levels shows them in a yellow box. **Preview the
move** (`POST /access-levels/move { apply: false }`) works the whole move out
in a transaction and rolls it back; **Move older roles** (`apply: true`)
keeps it. Nothing moves by itself.
- For each person with an older role, per app the role is about (rights
  there, or named by an option there), their roles about that app become
  one level with exactly the merged rights. Apps of any app role taken off
  are redone too, so nothing it gave elsewhere goes missing.
- **No clutter:** if the merged rights equal one of the app's levels the
  person had (Sales rep on top of Manager), they keep that level (so they
  still count as its Manager for reminders). Jobs that only view the same
  tables share **Viewer** ("Viewer (all tables)", "Viewer (Orders,
  Products, Companies)"); jobs that only reach their own records share **Own
  records**. Otherwise the level is named after the role ("Sales · Sales
  rep", "Staff + Ops").
- Approval options and Ask Zenin are rewritten to the new levels that came
  from a role they named. The older roles are deleted; a copy is kept in
  `app_state` `accessMoveBackup`.
- **The check:** before and after, for every person: rights per table,
  every limited choice option, Ask Zenin, the apps they manage, and the
  tables they can edit in full. It tries twice (first reusing levels freely,
  then strictly for roles that options or Ask Zenin name), each in a
  savepoint. If anyone would differ either way, nothing changes, and the 409
  says who and what ("…: the apps they manage. Nothing was changed.").
- The demo (`pnpm seed`) puts its 17 tables in 7 apps and runs the move:
  its 9 job roles become 26 levels.
- Mark columns **Required** where needed, and the ones people sort by as
  **Indexed** (text, textarea, number, date, boolean).

**What a user then sees** depends on the table's **Who sees the records**
(`table_schemas.by_department`):
- **Everyone with access** (apps and tables made in the app): their
  role decides; departments aren't needed and don't limit records.
- **Split by department** (tables made before this setting, and the
  API's default): the table appears when their role has **view** *and* they
  share a department with it, and they see only records **visible to** one of
  those departments. A record can be visible to several (a project for
  Engineering *and* Design).
  - **It needs at least one department.** `PUT /schema/:table` refuses "split"
    with none (400), and the screen won't save it. Older tables made through
    the API without departments stay admin-only until one is chosen; their
    other settings still save.

**Checking access** (admins), worked out by `src/auth/accessSummary.ts` with
the same functions that enforce it (`tablePermissions`, `allowedDepartments`),
so it can't disagree with what people see:
- **What they can do** (`GET /users/:id/access`): Users → a person's menu, or
  **What they can do** in their dialog. Every table, grouped by app, in plain
  words ("Leave requests: view, add and edit, only their own records"). A
  table their role allows but that's closed because they're in none of its
  departments is called out, with the department they'd need.
- **Who can use this table** (`GET /schema/:table/access`): at the top of
  Tables → the table → Access. Every role that opens it, what it may do, and
  how many people have it.
- The wording lives in `apps/web/src/lib/accessWords.ts`. A test checks that
  "What they can do" matches what the person really gets from `/schema`.

**"Own only"** (a tick per table in the role, next to View/Create/Edit/Delete)
shows the user just their **own records** instead: ones they created, or
where they're picked in any **User** column (e.g. Employee, Assigned to),
whichever of the table's departments keeps them. Use it for personal records:
each person's employee profile (kept "visible to HR"), their own leave
requests or expense claims. HR/managers get a role without the tick. It
applies everywhere records are read or changed (lists, the record page,
edit, delete, history, exports, and link dropdowns in other tables), via
`recordScope()` in `src/auth/access.ts`.

"Own" also follows **one link**: a record is yours when it links to a record
you're picked in through a User column. A leave request whose *Employee* is
the People record with *Login account* = you is yours. It goes one hop only,
and only through User columns ("Created by" doesn't carry over: an HR clerk
who created everyone's employee records doesn't thereby own everyone's
leave). In SQL that's `data -> 'employee' ?| ARRAY(SELECT _id FROM employees
WHERE data -> 'account' @> me)`, worked out once per query.

**"Own only" also decides what they can write** (`src/auth/ownership.ts`). A
table's **owner fields** are its User columns, or, when it has none, its
links to a table with a User column (a leave request's *Employee*). For
someone with "own only":
- a new record's empty owner fields are filled with them (their People
  directory entry);
- pointing one at someone else is refused;
- the form shows those fields locked ("That's you"), and explains when
  they're not in the directory yet;
- linking to their own entry needs no access to its table, and its name is
  shown to them.

**Nobody approves their own record:** an option only some roles may set
("Approved") can't be set on a record whose owner fields point at you,
unless you're an admin.

```
Table "projects" → departments: Dev, HR
  record A (Dev)   record B (HR)   record C (no department)   record D (Dev, HR)

user [Dev]        → sees A, D
user [Dev, HR]    → sees A, B, D
user [Sales]      → no "projects" menu at all
admin             → sees A, B, C, D
```

**"Visible to".** A record's departments are shown and picked as **Visible
to** (a multi-select) on tables shared with two or more departments, for
everyone who uses the table. A new record starts with the user's department
when they have exactly one. On a table with one department every record is
in it, so nobody is asked and no column is shown.

- **Any of the table's departments** can be picked, as long as one of them is
  the user's own (otherwise they'd share the record away from themselves).
  Admins may pick any, or none.
- **Records added from a related list** (a task added on a project's page)
  start with that record's departments, so both teams see the project's tasks.
- **Deleting a department** takes it off every record; a record shared with
  others stays visible to them, otherwise it becomes admins-only.

**"Admins only" records** (no department). These are records added before the
table was shared, or whose department was deleted. Only admins see them:
- when a table is shared with exactly **one** department, they move into it
  automatically on save;
- otherwise Settings → Tables shows a yellow box offering to move them all
  into one department, and admins see the "Visible to" column until they're
  gone;
- a table shared with no department shows admins a hint to share it.

**"Visible to" vs a Department column.** "Visible to" is access. To record
data such as which team a person works in, add a **Department** column
(Settings → Tables → Add column → Department). It picks from the same
departments, but doesn't change who can see the record. Filters on it offer
**My departments**.

**Account rules:**
- An admin can't disable, demote or delete themselves.
- The last active admin can't be removed.
- A role that is still assigned can't be deleted.
- Resetting a password or disabling a user signs them out everywhere.
- Users change their own details and password on **My profile**.

---

## 3. What happens on a request

Example: `PUT /api/table/projects/:id` (edit a record).

1. **nginx** forwards the request to the API, adding `X-Forwarded-For` and
   `X-Request-Id`.
2. **CSRF check.** Any request that changes data must carry
   `X-Requested-With: XMLHttpRequest`. The frontend's axios client sends it on
   every request.
3. **Session.** The `erp_session` cookie (httpOnly, SameSite=Lax, 7 days,
   extended while in use) is looked up in `sessions`. A single query also loads
   the user, role and departments.
4. **Schema** for `projects` comes from the in-memory cache
   (`src/schema/schemaRepo.ts`).
5. **Access check** (`src/auth/access.ts`). A user who can't see the table at
   all gets **404**, not 403, so hidden tables stay hidden. A user who can see
   it but lacks *edit* gets **403**.
6. **Validation** (`src/schema/validateRecord.ts`):
   - each value is converted to its column type;
   - required fields are checked on the record as it will be after the change;
   - newly linked records must exist and be visible to this user.

   Problems come back as **400** with `errors: { <column>: "<message>" }`.
7. **One transaction:** lock the row (limited to the user's departments),
   update it, and write the **audit entry** with a before/after diff.
8. **After commit:** uploaded files that were removed from file fields are
   deleted from storage.
9. **Logging and metrics:** a JSON log line with the request id, plus a
   Prometheus latency sample for the route.

**Schema cache.** Any change to tables, columns, table departments or
department names calls `invalidateSchemas()`. That clears the local cache and
sends `NOTIFY erp_schema_changed`, which every API and worker instance listens
for. A 60-second expiry is the safety net.

---

## 4. Records: validation, departments, files

### Column types and what's accepted

| Type | Stored as | Accepts |
|---|---|---|
| text / textarea / richtext | string (rich text = HTML) | strings; numbers become text. Limits: 5k / 50k / 500k characters |
| number | number | numbers or numeric strings (`"12.5"` → 12.5) |
| boolean | true/false | booleans, `"true"`/`"false"` |
| date | ISO string | `YYYY-MM-DD…` |
| relation | id, or list of ids if *multiple* | ids of records the user can see |
| user | user id, or list if *multiple* | ids of active users |
| department | department id, or list if *multiple* | ids of existing departments |
| autonumber | text, e.g. `INV-0042` | given by the server on create (see below) |
| formula | its result: number, text, date or yes/no | nothing: worked out by the server (see below) |
| rollup ("Total") | a number or date | nothing: added up from linked records (see below) |
| choice | the option's label, or list if *multiple* | one of the column's options (case and spaces ignored; stored with the option's exact spelling) |
| image / file | `/uploads/<key>` | a URL returned by `POST /api/upload` |
| images / files | list of `/uploads/<key>` | same |

- **Empty values:** `""` counts as empty, and a rich-text field containing only
  `<p></p>` counts as empty for *required*.
- **Unknown fields** in a payload are ignored.

### Related records

A record's page lists the records in other tables that **link to it**: a
project's tasks, a customer's orders and tickets.

- **Which tables:** every table the user can view that has a *Link to table*
  column pointing here. This is worked out in the browser from
  `GET /api/schema` (`RelatedRecords.tsx`), so there's no extra endpoint.
- **How:** each group is the normal list endpoint with the filter
  `<link column> is any of <this record>`, latest 5 first. Departments,
  "Own only", labels and names therefore work exactly as in lists, and the
  count only includes what the viewer may see.
- **Actions:** **Add** opens the new-record form with the link filled in
  (`/table/<child>/new?<column>=<id>`, only with Create permission). **View
  all** opens the list with that filter as a chip.
- **Empty groups** share one line ("Nothing linked yet in Time logs (add)").
  When the link's name isn't obvious (a table linking to itself, or two links
  from one table) the group says which link: "Tasks (Parent task)".
- **Indexes:** every *Link to table* and *User* column gets a GIN index on its
  JSON value (`data -> 'col'`), created by `syncColumnIndexes()`. Link filters
  use `data -> 'col' ?| ids`, which matches a single id or one inside a list
  and uses that index; "Own only" uses `@>`, which does too.

### Formula columns

A **Formula** column is worked out from the record's other fields:
`{basic} + {allowances} - {deductions}`, `DAYS({to}, {from}) + 1`,
`IF({stock} < {reorder_level}, "Low", "")`.

- **Language:** `{column name}`, numbers, `"text"`, `+ - * /`, comparisons
  (`= != < <= > >=`), `and`/`or`/`not`, and `ROUND(x, places)`, `MIN`,
  `MAX`, `ABS`, `IF(cond, a, b)`, `DAYS(to, from)`, `ADD_DAYS(date, n)`,
  `CONCAT(...)`, `BLANK(x)`. There's no `TODAY()`: stored values would go
  stale.
- **How:** `src/schema/formula.ts` parses the expression (never `eval`),
  type-checks it against the columns, and **compiles it to SQL** over the
  record's JSON. One `UPDATE … SET data = data || jsonb_build_object(…)`
  computes it after every create and update, after each import batch, and for
  the whole table when columns change. It's one implementation and needs no
  background job.
- **Result type** (number / text / date / yes-no) is worked out from the
  expression and stored as `column.formula.type`. Sorting, filters and
  display follow it (`valueType()`).
- **Empty values:** empty number *fields* count as 0 in arithmetic, so
  `{basic} + {bonus}` works without a bonus. Anything else that's empty
  stays empty (DAYS between missing dates, a division by zero). A formula
  never makes a save fail.
- **Checks when saving columns** (`checkFormulas()` in `changeColumns`):
  unknown columns (with "Did you mean {basic}?"), wrong kinds ("Use
  CONCAT(…) to join text"), and formulas depending on each other in a
  circle. Deleting a column a formula uses is refused, and so is a type
  change that breaks one. References use the column **name**, so renaming a
  label is harmless.
- **Live in forms:** while a form is filled in, it sends its values (and
  lines) to the normal create/update endpoint with `?preview=1`
  (`features/records/usePreview.ts`, debounced). The server does the whole
  save in a transaction, reads back the formulas, totals and line amounts,
  and **rolls it all back**: no record, no history entry, no auto-number used
  up. Required fields aren't insisted on in a preview; permissions are.
- **Values sent for formula columns are ignored** (API, CSV). The column
  settings check the formula live as you type
  (`POST /api/schema/:t/formula/check`), with its value on the latest record.

### Line items (edited inside the parent record)

A *Link to table* column can be marked **"Edit these inside the … form"**
(`column.inline`). The linked records then become **lines** of their parent:
an invoice's lines, a quote's items.

- **Form:** the parent's form shows a grid with one row per line, compact
  inputs, and worked-out values (Amount) read-only. `features/records/lineItems.ts`
  loads existing lines with `?raw=1` (stored ids, not names) and works out
  what changed.
- **API:** the parent's create/update carries
  `_children: { "<table>": { create: [...], update: [{ _id, ... }], delete: [ids] } }`
  (`controllers/lineItems.ts`). Everything is saved in the parent's
  transaction: the server sets the link, checks each line (permissions on
  the lines table, required fields, choices, links), and errors come back per
  line as `"<table>.create.<i>.<column>"`. Then the parent's totals (roll-ups)
  are worked out.
- **Deleting the parent deletes its lines.** A line can only be changed or
  removed through its own parent.
- **Order:** records saved together keep their order (`created_at` is
  `clock_timestamp()`). Lines are listed oldest first on the parent's page.
- Apps hide lines tables from the sidebar (`showInMenu: false`).

### Total (roll-up) columns

A **Total** column adds up the records in another table that link to this
one: "Hours logged" on a project = the sum of its tasks' hours; "Open tasks"
= how many of its tasks aren't Done.

- **Settings** (`column.rollup`): `from` (the other table), `via` (its link
  column pointing here), `fn` = count / sum / avg / min / max, `field` (what
  to add up), and optionally `where` (a choice column *is any of* / *is none
  of* some options). The result type (number or date) is worked out by
  `checkRollups()` (`src/schema/rollups.ts`).
- **SQL:** compiled with the formulas (`compileRollup()` in `formula.ts`) to
  `(SELECT sum(...) FROM <other table> c WHERE c.data -> 'via' @> to_jsonb(t._id) …)`,
  which uses the link column's GIN index. Formulas can use totals
  (`{total} - {paid}`).
- **Kept current** by `refreshParents()` after every create, edit (before
  and after: a record that moved updates both parents), delete, bulk delete
  and import batch, all in the same transaction. It cascades upward
  (time log → task hours → project hours), at most 5 levels. A column change
  on a table recomputes every total over it (`refreshAllParents()`).
- **Totals count every linked record**, including ones the viewer can't
  see. The related-records panel stays scoped.
- **Guards:** deleting a table, or a column a total uses (its link, field or
  condition), is refused with the total's name. Removing an app checks the
  same.

### Auto-number columns

An **Auto-number** column gives each new record a reference: the column's
prefix plus a number padded to 4 digits (`INV-0001`, …, `INV-10000`). The
only setting is the prefix (`column.autonumber.prefix`). `{YYYY}` in the
prefix becomes the year, and numbering then restarts every year.

- **Counter:** the `counters` table (migration `004_counters.sql`), keyed by
  table, column and period (the year, or `''`). It's incremented inside the
  insert's transaction (`assignAutonumbers()` in `src/schema/autonumber.ts`),
  so concurrent inserts get unique numbers. A rolled-back insert can leave a
  gap.
- **Read-only:** the form shows "Given automatically when saved". Updates
  ignore the field, and a duplicated record gets a new number.
- **Imports and the API** may bring their own numbers. They're kept, and the
  counter moves past the highest one that uses the column's prefix.
- **Adding the column to a table with records** numbers them oldest first
  (per year with `{YYYY}`) in one `UPDATE`, then sets the counter to follow
  on.
- **A new prefix** applies to new records only. Deleting the column deletes
  its counter. The type is fixed: no change to or from Auto-number.
- **Never required** (always filled in); sortable and indexable like text.

### Default values

A column can have a **default** (`column.default`) that new records start
with:

| Type | Default |
|---|---|
| text, long text, number, yes/no, choice | a fixed value |
| date | `"today"` only (a fixed date is rarely useful) |
| user | `"$me"`: whoever creates the record |
| department | `"$mine"`: the creator's department, only if they have exactly one |

- **Where:** the new-record form starts with these values, and the server
  fills them in on create (`withDefaults()` in `src/schema/defaults.ts`) for
  fields **missing** from the payload. This covers the API and CSV imports
  (columns missing from the file). A field sent empty on purpose, or an empty
  CSV cell, stays empty.
- **"today"** is the browser's date in the form, and the server's (`TZ`) for
  the API and imports.
- **Changes:** a choice default follows its option when it's renamed, and is
  dropped when its option is removed or the column's type changes.
- **Pre-filling from the address:** `/table/<t>/new?<column>=<value>` starts
  the form with that value (several values comma-separated), after the
  defaults. Related-record "Add" buttons use it (`newRecordValues()` in the
  web app).

### Choice columns

A **Choice** column has a fixed list of options. Each option has a label, a
colour and a stable `id` (`column.options`). Records store the **label**, so
search, CSV and the API all see plain words.

- **Order matters.** Sorting follows the options' order (To do, Doing, Done),
  not the alphabet, via `array_position` in `sortExpression()`. That's why
  choice columns aren't "Indexed"; single choices are still sortable.
- **Renaming an option** (same `id`, new label) rewrites the stored values in
  the same transaction as the column change (`src/schema/choiceValues.ts`).
  Renames are applied in one statement, so swapping two names works. The
  response's `rewritten` count is shown in the UI ("Updated the value on 22
  records"). Neither the records' history nor their "updated at" changes.
- **Removing an option** keeps the value on old records, shown as a grey badge
  ("This option was removed"). Such a record can still be saved; only a *new*
  pick must be a current option (`checkChoices`, which works like
  `checkRelations`).
- **Text ↔ Choice.** A Text or Long text column can become a Choice; the
  options are built from its existing values, at most 50 different ones, and
  values that differ only in case or spaces are merged ("done " → "Done"). A
  Choice can go back to Text; several picks become "A, B". No other type
  changes are allowed, and *multiple* is fixed once the column exists.
- **Filters:** "is any of", "is none of" (which includes empty values),
  "is empty" and "is not empty".
- **CSV:** the label; several values are separated by `;`. Import matches
  labels ignoring case and reports unknown ones per row.

### Approval steps

A choice option can be limited to some roles (`option.roles`, role ids): only
they may **choose** it, e.g. *Approved* and *Rejected* on leave requests for
the Manager role. Admins always may. `checkChoices()` enforces it on every
save (form, board, API, import, lines). A value the record already has never
blocks other edits. In the form the option shows as disabled ("needs
approval"); on the board, *Move to* is disabled for it. In the column
settings each option has a **lock** button: "Who can choose this". Apps mark
these with `onlyManagers: [...]`, and the installer links them to the
Manager role.

### Notifications and automations

**Live updates** (`src/live/events.ts`, `features/live/` in the web app):
- **How they travel:** saves call `emitChange()` and `emitNotification()`
  inside their transaction; `pg_notify` delivers them only when it commits.
  Each API process LISTENs once and passes them on to the browser tabs
  connected to `GET /api/events` (Server-Sent Events). No Redis needed.
  - A **change** only reaches people who can open that table.
  - A **notification** only reaches its recipients.
- **The bell** updates at once and shows a pop-up you can click to open the
  record.
- **Open lists and records don't redraw by themselves** (rows moving under
  the mouse is worse than a moment's delay). They show "Hana changed this ·
  Refresh". Dashboard counts update quietly.
- **Coming back to the browser window** refreshes the data.
- **Action sounds** (`lib/alerts.ts`, My profile → Sounds and alerts →
  "Sounds for my actions", on by default):
  - **Sounds:** a soft rising pop for saved or added, a falling tone for
    deleted, and a low double tone for failed.
  - **How:** `main.tsx` listens to Mantine's notification store, so every
    green/teal ("Saved", "Deleted") or red ("Couldn't …") message the app
    shows makes its sound. Nothing else needs to call it. Blue pop-ups (other
    people's activity) use the alert chime instead.
- **Alerts** (`lib/alerts.ts`; My profile → Sounds and alerts, saved per device):
  - **When:** a soft chime (made with Web Audio, no file) for what lands in the
    bell, and for new direct- or group-chat messages unless that
    conversation is open in front of you. Never for your own actions, never
    for busy channels (mentions there come through the bell). One chime per
    1.5 s at most.
  - **Desktop notifications:** the browser's `Notification`. Off by default;
    switching on asks permission. Shown only when Zenin isn't in front;
    clicking opens the record or chat. Browsers allow them only on https or
    localhost; the settings say so on a plain http address.
- **Edit protection:** the edit form sends the version it opened
  (`_expectedUpdatedAt`). If someone else saved in between, the server answers
  409, "Hana changed this record while you were editing it", and the form
  offers **Save mine anyway** or **See their version**. While editing, a bar
  already warns when someone else saves the record.
- **When something holds the stream back,** the app notices and checks
  instead:
  - **Who holds it back:** a Cloudflare **Quick Tunnel** (free trycloudflare
    addresses don't support Server-Sent Events, per Cloudflare's docs), and
    some office proxies or antivirus.
  - **How it notices:** the server sends `hello` at once and `ping` every
    25 s. No hello within 8 s, or no ping for 70 s, counted from the start
    rather than each reconnect, means held back.
  - **What it does then:** checks the bell and chat every 5 s (15 s in the
    background), with the same pop-ups, chime and desktop notifications.
  - **Back to instant:** as soon as the stream delivers again.
  - **Truly instant:** a named tunnel (`./deploy.sh public <token>`), your
    own domain, or the office network.
- **Behind nginx and the tunnel:** the stream is unbuffered
  (`X-Accel-Buffering: no`), with a heartbeat every 25 s. Each stream ends
  after 30 minutes and the browser reconnects, so sign-in is checked again.

**Email** (`src/mail/`, set up in Administration → Email, stored in
`app_state` under `mail`; the password never goes back to the browser):
- **Every bell notification can also be an email.** `notify()` writes it to
  `email_outbox` in the same transaction, so a failed save sends nothing.
  The worker sends the outbox every 5 s, retrying after 1, 5 and 30 minutes.
- **Each person's choice** (`users.email_pref`):
  - *now*: an email right away;
  - *daily*: the notification waits (`notifications.digest_pending`) for
    the morning summary;
  - *never*: no email.

  People without an email address, and anything you did yourself, get none.
- **The morning summary** (`mail/summary.ts`): once a day at the set hour,
  in the set time zone (`app_state.mail_summary` remembers the day). One
  email per person, made of:
  - the apps' `reminders` (filters with `$today+N` tokens, sent to a User
    column, a link's User column, or `$managers`, meaning the app's
    managers);
  - the waiting notifications of "once a day" people.
- **Password links** (`auth/passwordLinks.ts`, `password_tokens`, only a
  hash kept):
  - **welcome** (Add person → "email them a link", or Import people for
    rows with an email), valid 3 days;
  - **reset** ("Forgot your password?"), valid 1 hour;
  - single use, at most 3 an hour per person;
  - a sent one's text is blanked in the outbox.
- **Tests** use `MAIL_TRANSPORT=memory` (an in-memory mailbox).

- **The bell** (`notifications` table, `GET /api/notifications`, polled every
  minute): people newly picked in a **User** column are told automatically
  ("Asha put you as Assignee"). Nobody is told about their own changes.
- **Automations** (Table settings → Automations, `automations` table): a
  sentence built from lists. *When a record is added*, or *when <field>
  changes* (optionally *to* an option), then **tell** someone (with an
  optional message) and/or **set a field** (today, the person who made the
  change, an option, a value). Who can be told:
  - whoever created the record (`$creator`);
  - **its managers** (`$managers`): people who can edit every record of the
    table, or the admins when there are none;
  - the person in a User column;
  - **the person in a linked record**, e.g. `employee.account`: the
    Employee's login.
- **They run in the save's transaction** (`afterSave()` in
  `src/schema/automations.ts`), after formulas and totals. Their own
  changes don't trigger automations again (no loops). Previews and CSV
  imports don't run them. Their notices are emailed like any other
  (each person's email choice).
- Apps ship some:
  - a new leave request or expense claim → tell its managers;
  - leave approved/rejected → tell the employee;
  - ticket resolved → set *Resolved on* and tell the requester;
  - …and more.

  When an app's blueprint gets a newer `version`, installed copies get its
  new automations once at start-up (`upgradeInstalledApps()`). One you
  changed (a different trigger) is left alone.

### Branding and profile pictures

- **Name and logo** (Administration → Branding; `src/branding.ts`,
  `app_state` under `branding`):
  - `GET /api/branding` and `GET /api/branding/logo?v=<version>` need no
    sign-in, because the sign-in page shows them.
  - The logo is served with long caching; its URL changes when it changes.
  - The name is used in the sidebar, the browser tab, the favicon (the logo),
    emails and Ask Zenin's instructions.
  - Without a logo: the name's first letter. A wide logo (a wordmark) is shown
    without the name beside it.
- **Profile pictures** (My profile; `users.avatar_url`, migration 016) show in
  the top bar.
- **Uploads:** both are uploaded like any file, after being made small in the
  browser (`lib/images.ts`: pictures a 256 px square, logos at most 512 px).
  Only `/uploads/…` images are accepted.
- **Old files are kept, never deleted from here.** The address sent could be
  any upload, such as a record's attachment.

### Comments and team chat

Set up in **Administration → Chat**, three switches stored in `app_state`
under `chat`: comments on records (on), team chat (off at first), direct
messages and groups (on). Tables are in migration `014_chat.sql`; the code is in
`src/controllers/comments.ts`, `src/controllers/chat.ts` and `src/chat/`, and
in the web app `features/chat/`, `pages/ChatPage.tsx` and
`features/records/CommentsSection.tsx`.

- **Comments** sit under every record's details. Anyone who can see the
  record can comment.
  - **Typing `@`** suggests people. A mentioned person who can see the record
    is told (bell, plus email by their choice). One who can't isn't told, and
    the author gets a warning ("Kiran can't see this record, so wasn't told").
  - **Replies** tell everyone already in the conversation.
  - Authors edit their own; the author or an admin deletes.
- **Team chat** (`/chat`, the speech-bubble icon in the top bar):
  - **Channels are made for you:** #everyone, plus one per department, with
    members following the departments (`ensureChannels()`).
  - **Direct messages** (one per pair) and **groups** (a name plus people,
    which members can leave).
  - **Messages:** @mentions, reactions (👍 ❤️ 😂 🎉 👀 ✅), files and images,
    edit and delete your own. A link to a record shows as a card with its
    name (only when the reader can open it).
  - **Unread counts** per conversation, with mentions counted separately;
    the top-bar icon shows the total. Opening a conversation reads it and
    its "mentioned you" notices. Search only finds messages you can read.
  - **Calls:** the camera button posts a Jitsi Meet link
    (`meet.jit.si/Zenin-<random>`) as a "started a call · Join" card.
- **Privacy:**
  - direct messages and groups are readable only by their members, admins
    included (an outsider gets 404);
  - admins can read department channels.
- **Chat isn't emailed.** A mention rings the bell (linked to the
  conversation: `table_name = '__chat'`).
- **Live:** `emitChat()` and `emitComment()` travel over the same stream as
  the bell. A chat event goes only to the conversation's members (`hears()`);
  a comment event only to people who can open the table.

### Department of a record

- **Stored as** `department_id` (the first one, with a foreign key) plus
  `shared_department_ids TEXT[]` (the others, GIN-indexed). The access check is
  `department_id = ANY(mine) OR shared_department_ids && mine`.
- **API:** send `_departmentIds: [...]` (the first becomes `department_id`);
  `_departmentId` (one id) still works. Records come back with `_departmentId`
  (the first), `_departmentIds` (all) and `_departmentName`
  ("Engineering, Design"). Re-sending the same list, in any order, changes
  nothing, so someone in only one of the departments can still save the record.
- **New record:** if the user can use exactly one of the table's departments,
  the record goes there automatically. Otherwise they must pick in the form.
- **Admins** may send `_departmentIds: []` (or `_departmentId: null`): an
  admins-only record. The web app always asks when there's a choice.
- **CSV:** the "Visible to" column holds department names separated by `;`
  (`Engineering; Design`).

### Files

1. The form uploads to `POST /api/upload` (multipart, field `files`). The file
   is **streamed** straight into the bucket, never held in memory. The limit is
   50 MB (`UPLOAD_MAX_MB`).
2. The API returns `{ url: "/uploads/<key>", name }`, and the form saves that
   URL in the record.
3. `GET /uploads/<key>` streams the file back to **logged-in users**. Files are
   served with `Content-Security-Policy: sandbox`, so an uploaded HTML or SVG
   file can't run scripts.
4. Replacing or removing a file in a record, deleting the record, or deleting
   the table deletes the stored file.

### Lists, search and sorting

- **Search** matches every field ("contains", case-insensitive) using a
  trigram index.
- **Sorting** works on a column's typed value: numbers sort numerically, and
  choices sort in their options' order. It's fast for columns marked
  **Indexed**.
- **Views:** a list can also be shown as a **Board** (lanes by a single
  Choice column; drag a card, or use its *Move to* menu, to change it) or a
  **Calendar** (by a Date column; click a day to add a record on it; phones
  get a list of days). The view is kept in the address (`?view=board&by=status`,
  `?view=calendar&on=due`) and uses the same search and filters. Each lane is
  a list request with an extra filter (accurate counts, 50 cards each); the
  calendar loads the visible month (up to 500).
- **Record names:** the first visible **text** column names a record (in
  links, titles, cards); a reference number (auto-number) only when there's
  no text column. Cards and calendar entries add the first link: "10:30 ·
  Anu Thomas".
- **Totals:** above `EXACT_COUNT_LIMIT` rows (default 50,000) the total is an
  estimate; the UI shows "~".

### The Spreadsheet view

A table's records as a grid, like Excel (`features/records/SpreadsheetView.tsx`,
react-data-grid 7). It's **on for every table** (migration 019 turned it on
and made it the default); an admin can switch it off per table: Tables → the
table → Access → **Spreadsheet view** (`table_schemas.spreadsheet`;
`PUT /schema/:table { spreadsheet }`), e.g. for Payslips. There's no separate "who may use
it": people see and change what their level allows, and hidden fields never
appear. Phones don't get it (`?view=sheet` falls back to the list).
- **Rows:** `GET /table/:t?withRaw=1` gives the usual names to show and, in
  `_raw`, the stored values (ids) to edit and compare, hidden fields left out.
  100 rows a page, with the list's search, filters and sort.
- **Editing:** click a cell and type (typing replaces the value, as in Excel;
  Enter or a double click edits it). The editor is the form's own
  `FieldInput`, so every type works as in the form; pickers (choice, person,
  link, department, yes/no, date) save as soon as something is picked.
  Formulas, totals, auto-numbers, files, pictures, rich text and line items
  are read-only; the first column opens the record.
- **Each cell saves on its own** with `PUT /table/:t/:id { field: value,
  _expected: { field: <the value it started from> } }`. If the stored value
  differs, the server refuses (409, `errors._cellConflict`, `_by`) and
  nothing is overwritten. The sheet shows "Asha changed In stock on Air filter
  a moment ago" with **Keep theirs** / **Use mine** (Use mine saves again from
  the value now stored). Empty values count as the same (`null`, `""`, `[]`).
  `_expected` on a hidden field is refused (403): comparing would reveal it.
- **Problems** turn the cell red, with the reason on hover. A tick-green
  outline means saved.
- **New rows:** **Add row** adds a draft at the bottom. It's saved (`POST`)
  once its required fields are filled. On a table split by department, a
  person in several departments gets new rows in their first; the sheet says
  so.
- **Paste** (`pasteValues.ts`): text copied from Excel or Google Sheets (tabs
  and new lines, quoted cells) fills from the active cell rightwards and
  down, up to 200 rows. Each value becomes what the field stores (numbers
  like "1,250", dates as 2026-11-25 or 25/11/2026, yes/no, choice labels,
  people, links and departments by name). Each row is one normal save, with
  `_expected` for the cells it changes; rows past the end become new records.
  A notification sums it up; problem cells turn red.
- **Undo** (Ctrl+Z / Cmd+Z on a cell, or **Undo** in the message after a
  paste, fill or Delete on a block): the last 20 steps, in this tab only.
  - A step is one typed cell, one fill, one paste or one Delete. It keeps,
    per cell, the value before and the value **as stored** after (every
    `PUT /table/:t/:id` answers `saved: { field: stored value }`; "8" typed
    in a number is 8), plus the records a paste or a new row made.
  - Undo sends the old values with `_expected` = the stored ones, one
    request per record; on a clash it goes cell by cell. A cell someone
    changed since is left alone ("1 cell changed by Asha since: left as they
    are"). Records the step made are deleted again, if you may delete.
  - No Redo. "Change a field" and "Delete rows" aren't in Undo (they ask
    first; the audit log has the old values).
- **Selecting like Excel** (the grid itself selects one cell; the rest is
  ours): drag across cells (the cell under the pointer is found with
  `elementFromPoint`, since the grid holds on to the mouse), Shift+click, or
  Shift+arrows select a block (highlighted); Ctrl+A selects the page.
  **Ctrl+C** copies the block as tab-separated text; **Ctrl+V** onto a block
  fills all of it with one copied value; **Delete** empties the block's
  changeable cells (asks above 20), one save per row with `_expected`. The
  grid's **fill handle** (a cell's corner square) copies a value down through
  `onFill`, as normal cell saves. **Row tick boxes** (the grid's
  `SelectColumn`) give **Change a field** (the Bulk update dialog) and
  **Delete rows** (only with delete rights). No Ctrl+click of scattered cells.
- **Live:** others' changes (`useLiveChanges`) refresh the sheet at once; the
  cell being edited keeps its editor (`closeOnExternalRowChange: false`).
  While the live stream is held back (`useLiveHeldBack`, e.g. the Quick
  Tunnel), the sheet checks every 5 s.

### Changing many records at once (bulk update)

- **On a list:** select rows → **Update** → choose a field → give the value
  (the same input as the edit form), or tick **Clear … instead**.
- **On the server:** `POST /api/table/:t/bulk-update { ids, field, value }`
  (max 500).
- **Which fields:** text, number, date, yes/no, choice, person, link,
  department and long text. Not formulas, totals, auto-numbers, files, rich
  text, or a line item's link to its parent.
- **The same rules as editing one record:**
  - edit permission and own-records-only;
  - approvals and locked options;
  - required fields (a required field can't be cleared) and valid choices;
  - links you can see.

  Then formulas, totals, automations ("assigned you"), the audit log
  (marked `_bulk`) and live updates.
- **Each record is saved on its own:** one that can't be changed is skipped,
  and the answer lists them with the reason, while the rest are saved.
- **Who sees the row checkboxes:** people who can delete or edit.

### Deleting things

- **Table:** refused while another table has a relation column pointing at it;
  the error names those columns. Deleting removes its records, files,
  department links and role permissions.
- **Column:** removes the definition; old values stay inside existing records,
  unused.
- **Department:** its records become "admins only" (they're *not* moved
  into another department automatically, which could expose them).

---

## 5. Apps (Administration → Manage apps)

An **app** (Projects, HR & leave, CRM, …) is a blueprint of tables, columns,
links and roles in `src/apps/`. Installing it creates **ordinary tables**
that can then be changed like any other.

**The Manage apps page** (`AppsPage.tsx`), top to bottom:
- **New here?** (only while no ready-made app is added): "Add these 3"
  installs HR & leave, Expense claims and Projects in one preview.
- **Your apps:** one list of everything added (ready-made, your own, and My
  tables once it has a table). A ⋯ menu per row: Rename (your own apps),
  Remove N sample records, Remove app.
- **Add an app:** one short row per app, most needed first; Clinic and
  School last. People, Customers and
  Products (`part: true` in their blueprint) aren't offered on their own:
  the apps that need them add them.
- **Draft with AI** and **New app** are buttons in the header; Draft with
  AI opens a small dialog (or says how to set up AI).

**Every table is in an app** (`src/apps/ownApps.ts`), and every app has a
**Manager** and a **Staff** role, so access is always given the same way: App
access on the person.
- **My tables** (key `my-tables`): tables you built yourself. A table with
  no `app_key` is in it. It's made at start-up (`ensureMyTables()`), can be
  renamed, and can't be removed. Its Manager always has everything on its
  tables.
- **Apps you make** (Manage apps → **New app**: a name and one of 16 icons,
  key `custom-…`). They're kept in `installed_apps` like AI-drafted apps
  (`options.own`; a rename goes in `options.name/icon` and renames the two
  roles too). Shown under **Your apps**, with Rename and Remove.
- **New table** (`POST /schema { app, staff }`) asks for the app, and what
  its Staff may do: `none` (the API's default), `view`, or `work` (view, add
  and edit; the screen's default). Its Manager gets everything. A wrong app
  is refused before anything is made. The apps offered (`GET /apps/homes`)
  are My tables, your own apps, and installed apps that show as themselves
  (not Company's parts).
- **Moving a table** (`PUT /schema/:table/app`, the App choice in its Access
  card): only tables you made (no `blueprint_key`); a table that came with an
  app stays in it (409). It takes its Staff rights along, the new app's
  Manager gets everything, and the old app's roles lose it. Roles you made
  yourself keep their rights. No confirm: moving back undoes it.
- **Removing an app you made** deletes nothing it didn't create: its tables
  move to My tables with their records (`uninstall()` clears `app_key`, then
  `ensureMyTables()`), and its two roles go. Typing the name is only asked
  when tables would be deleted (AI-drafted apps).
- **"Admins only"** is shown only for a table split by department that has
  no department; a table for everyone with access never shows it.

- **Preview first:** `POST /api/apps/plan` works out what an install would do
  (`plan()` in `src/apps/installer.ts`). The drawer shows exactly that: tables
  (optional ones can be unticked; links to them are then dropped, with
  formulas that use them), apps pulled in by `needs`, roles, "Visible to" and
  sample data.
- **Connections:** every table an app creates is tagged with its blueprint
  key (`table_schemas.blueprint_key`, e.g. `projects.tasks`) and app
  (`app_key`, which decides the app it shows under in the launcher). A later app linking to
  `people.employees` **reuses** that table (found by key, even after a rename
  or column edits) instead of creating another.
- **Name clashes:** if one of your own tables already has the name, the app
  creates `tasks_2` by default, or **uses yours** when chosen. Using yours adds
  the columns it lacks and changes nothing else.
- **One transaction:** `install()` writes all the new tables at once, so
  links between them (and to themselves: sub-tasks) resolve. It shares them
  with the chosen departments, extends the roles, adds samples and records
  the app in `installed_apps`. Indexes are built after commit.
- **Roles:** every app brings its own, "Projects · Manager" (everything in
  its tables, approvals included) and "Projects · Staff" (everyday work, *Own
  only* for personal tables such as time logs, leave and deals). People get
  them through **App access** on their page; Company (People, Customers,
  Products) is one row there. Removing an app removes its roles.
- **Records** of app tables are seen by everyone whose role can use them
  (`by_department = false`).
- **Sample data** goes only into tables made by that install, and can be
  removed later in one click (`sample_ids`). Named samples (`sample_refs`)
  let a later app's samples link to an earlier app's.
- **Extending other apps:** an app can add columns to another app's table
  (`extend`, e.g. Inventory adds *In stock* and *Low stock* to Products).
  They're recorded in `installed_apps.options.extended` and removed with the
  app.
- **Catalog** (kept small on purpose: what most businesses need; more only
  when customers ask): 7 general apps (HR & leave, Expense claims, Projects,
  CRM, Billing, Inventory & purchasing, Payroll: simple payslips, no
  PF/ESI/TDS), 2 trade apps (Clinic, School), and the 3 shared parts
  (People directory, Customers, Products). Helpdesk, Assets, Donors &
  programmes and the "organization types" were removed on 2026-11-26 (in
  git history if a customer needs them).
- **Launcher and sidebar.** Every table in `GET /api/schema` carries
  `app: { key, name, icon, description }` (`launcherApp()` in
  `src/apps/index.ts`): its app, or the group its app is in (People,
  Customers and Products are one **Company** app). Your own tables have
  `app: null` and show as **My tables**.
  - **With 3 or more apps** (`APP_MODE_FROM` in
    `src/features/apps/appMenu.ts`), Home is a launcher of app tiles and the
    sidebar shows **one app at a time**: a switcher with the app's name, its
    tables, and **Also used** (other apps' tables its tables link to, e.g.
    Employees in HR). Each app has a page, `/apps/<key>`, with its dashboard
    and tables.
  - **The current app follows the page:** an app page, or the app of the
    table being viewed. Opening an "Also used" table keeps you in the app
    you came from (remembered for the browser tab). Table pages start their
    breadcrumbs with the app ("HR & leave › Employees").
  - **With fewer apps** (or for someone who can use only one or two), the
    sidebar lists every table grouped by app, and Home shows the dashboards
    and table cards, as before.
  - Ctrl K also lists the apps.
- **Dashboards:** an app can declare a few counts ("Open tasks",
  "Overdue invoices") and one breakdown ("Tasks by status") in `dashboard`.
  `GET /api/apps/dashboards` returns those whose tables the person can see
  (each with `launcher`, the app page it shows on; Home shows them all when
  there's no launcher);
  each number is a list request with the tile's filters, so it follows
  departments and "Own only". Clicking a tile or bar opens that filtered
  list. Date filters accept `$today` ("Due is before today") so these stay
  current.
- **Drafted with AI** (optional, Beta; set up in **Administration → AI**):
  Manage apps → *Describe your organization*. `POST /api/apps/draft` asks
  the chosen AI for a **draft** (`src/ai/`):
  - **Settings** (`ai/settings.ts`, `app_state` under `ai`): the provider
    (Claude, Gemini or ChatGPT), an optional model (empty: our pick in
    `DEFAULT_MODELS`), and one key per provider. Keys are never sent back to
    the browser or written to the audit log. An `ANTHROPIC_API_KEY` in `.env`
    is copied in once at start-up.
  - **One call for all three** (`ai/generate.ts`, `generateJson()`): the same
    instructions and the same JSON Schema (made from the Zod schema) go to
    Claude (SDK structured output, server-side refusal fallback), Gemini
    (`generateContent` with `responseJsonSchema`) or ChatGPT (Chat Completions
    with a strict `json_schema`). The answer is checked against the Zod
    schema again, and provider errors become plain messages (key refused,
    unknown model, out of credit).
  - **Test** (`POST /api/ai/test`) sends one tiny request.
  - **Features** (`settings.features`, one switch per built feature; now
    only `draftApps`): with no key every feature is off. A switched-off
    feature answers 403 and disappears from the screens.
  - **Usage** (`ai/usage.ts`, table `ai_usage`, migration 015): every
    request, worked or not, adds a row: feature, person, provider, model,
    input and output tokens (thinking counts as output) and an estimated cost
    from `ai/prices.ts`. A model missing from the table gets no cost
    (`unpriced`). What was asked is never stored. `GET /api/ai/usage` gives
    this month, last month, by feature and by person.
  - **Ask Zenin** (`ai/assistant.ts`, `GET /api/ai/assistant`,
    `POST /api/ai/ask { turns }`): the assistant in the top bar, for the
    roles in `settings.askRoles` (empty = everyone; admins always). The browser
    sends the last turns (text only; nothing is kept on the server). A tool
    loop (at most 6 rounds) per provider: Claude through the SDK (prompt
    cache on the instructions, effort low, server-side fallback), Gemini
    `generateContent` with `functionDeclarations` (the model's parts go back
    unchanged, thought signatures included), ChatGPT Chat Completions with
    `tools`. The tools run as the asking person: `search_records` calls
    `listForUser()` (the list endpoint's own code, permissions and all) and
    `find_people`. Tool errors (unknown table, a filter that doesn't fit)
    go back to the AI so it can retry.
  - **Limits** (`settings.limits`, checked before each request by
    `checkLimits()`): a monthly estimated spend at which every AI feature
    answers 429, with a bell to the admins at 80% and at 100%
    (`app_state.ai_limit_warned`, once per month and level), and requests per
    person per day (admins aren't limited; Test isn't counted).

  The draft is tables, columns and links. `fromDraft()` in
  `src/apps/draft.ts` turns it into a normal blueprint and leaves out
  anything that doesn't check out (links to missing tables, broken
  formulas). Plan and install take `{ draft }` instead of app keys, so the
  admin sees the usual preview first. The draft is kept with the install
  (`installed_apps.options.draft`), so the app can be listed and removed
  later. Without a key the box is replaced by a one-line hint, and no
  request is ever made.
- **Removing an app** deletes the tables it created, with their records and
  files. It's refused while another app needs it, or while one of your
  tables links to its tables. Its roles stay.

## 6. Background jobs: CSV import and export

```
UI button ─▶ API: create job (queued) ─▶ NOTIFY erp_jobs ─▶ worker claims it
            (import: file streamed to   (FOR UPDATE SKIP LOCKED)
             imports/<job>.csv)                       │
                                                      ▼
            Imports & exports page ◀── job: running → done / failed
            (polls every 3 s)            result, progress, file
```

- **Export** (needs *view*): writes every record the user can see to
  `exports/<job>.csv`, then **Download**. The last column is the record's
  **ID**.
- **Import** (needs *create* or *edit*). The Import window offers **Download
  template** (the column headings) and a column guide (required columns,
  options, date and number formats).
  - **Each row** is validated exactly like the form, including the "own only"
    rules and "nobody approves their own".
  - **Rows without an ID are added** (needs *create*). **Rows with an ID
    update that record** (needs *edit*). Only the columns in the file change,
    and each change goes in the record's history (`_via: "import"`). Export →
    edit → import is the bulk update.
  - **A required column missing from the header** (with no ID column) stops
    the import at once, with a message pointing to the template.
  - **Rows with problems are skipped** and listed with how to fix them, e.g.
    `Due must be a date, written like 2026-12-31 (the file has "31/12/26")`.
    **Download the rows to fix** gives just those rows plus a `Problem`
    column; fix them there and import the file again (`Problem` is skipped).
  - **When it finishes,** the importer gets a bell notification (no email).
    Imports don't run automations.
  - **The audit log** gets one `import` entry for the whole import, and an
    update entry per changed record.
- **Permissions are re-checked when the job runs,** with the permissions of
  the user who started it.

**CSV format** (export and import use the same format, so files round-trip):
- **Header:** column labels; import also accepts column names, case-insensitive.
  An optional `Visible to` column takes department names. `ID` is the record's
  id (exports); `Created by` and `Problem` are skipped on import.
- **Relations:** the linked record's display name. Import also accepts ids, and
  reports names that match more than one record.
- **Multiple values** (multi-relations, images, files): separated by `;`.
- **Booleans:** `true`/`false` on export; import also accepts
  `yes/no/1/0/y/n`.
- **Rich text** exports as plain text.
- **Formula safety:** cells starting with `= + - @` (other than numbers) get a
  leading `'`, so spreadsheet apps don't run them as formulas.
- **Unknown columns** are ignored and reported on row 1.

**Housekeeping**, done by the worker every 10 minutes:
- jobs stuck in *running* for 30 minutes after a worker crash are retried once,
  then marked failed;
- expired sessions and old login attempts are removed;
- job files older than `JOB_FILE_RETENTION_DAYS` (default 14) are deleted.

---

## 7. Audit log

Every change writes a row to `audit_log`:

| Entity | Actions |
|---|---|
| record | create, update (field-level `from`→`to`, `_department` for moves), delete, import |
| session | login, login_failed, logout |
| user / role / department | create, update, delete; user: password_change (passwords are never logged, only `passwordReset: true`) |
| table / column | create, update, delete; table: settings, assign_unassigned |

- **Record changes** are written in the same transaction as the change itself,
  so a record can't change without an audit entry.
- **Admins** see everything in Settings → Audit log, with filters for table,
  user, entity, action and date range.
- **Everyone else** only sees the **History** of records they can open (the
  button on the record page).

---

## 8. Development workflow

### Branches and CI

Both repos run CI on every push and pull request
(`.github/workflows/ci.yml`):

- **API:** install → `pnpm typecheck` → `pnpm test` (against a Postgres
  service) → `pnpm build` → `docker build`
- **Web:** install → `pnpm lint` → `pnpm build`

Suggested flow:
1. Branch from `main`.
2. Make small commits.
3. Open a PR into `development` (or `main`).
4. Merge only when CI is green.

### The inner loop

```bash
docker compose up -d db storage                         # once
cd apps/api && pnpm dev                       # API restarts on save
cd apps/web   && pnpm dev                       # browser updates on save
```

Before pushing:

```bash
# API
pnpm typecheck && pnpm test
# Web
pnpm lint && pnpm build
```

### Database changes: migrations

- System tables live in `apps/api/migrations/NNN_description.sql`.
  They're applied in order, each in its own transaction, at start-up, and
  recorded in `schema_migrations`.
- **Never edit a migration that has run anywhere real.** Add a new one,
  e.g. `003_add_xyz.sql`.
- Write migrations to be safe to re-run where you can (`IF NOT EXISTS`,
  `CREATE OR REPLACE`).
- Watch out for exception blocks in functions: a PL/pgSQL `EXCEPTION` block is
  a subtransaction, which fails inside parallel queries. That bug was hit once
  already (`erp_try_numeric`).
- **ERP data tables** (`erp_data.*`) are *not* migrations. They are created and
  indexed at runtime by `src/db/dataTables.ts`.

### UI changes

Every UI change follows
[apps/web/UI_GUIDELINES.md](../apps/web/UI_GUIDELINES.md):
the design tokens, `Page`/`PageHeader`, `DataTable` for every list, `FieldValue`
for values, the form rules, accessibility and responsiveness. Its §14 is the
review checklist for pull requests.

### Testing

- Tests live in `apps/api/tests/` (vitest + supertest). They run
  against a **real Postgres** database whose name must end in `_test`; it is
  wiped first. Storage is in memory.
- Helpers in `tests/helpers.ts`:
  - `login()` returns a client that keeps its cookie and sends the CSRF header;
  - `setupWorld()` creates a department, table, role and user in one call;
  - `unique()` gives unique names, so test files can share the database.
- For a background-job test, queue the job through the API, then call
  `drainJobs()` (from `src/jobs/worker.ts`) to run it straight away.

---

## 9. Recipes

### Add an API endpoint

1. **SQL** goes in `src/repo/*.ts`. Take an optional `db` parameter so it can
   run inside `withTransaction`.
2. **Handler** goes in `src/controllers/*.ts`:
   - get the user with `currentUser(req)`;
   - for record-level access, use `loadTable(req, "view" | "create" | "edit" | "delete")`
     and `departmentFilter(user, schema)`;
   - throw `new HttpError(status, message, fieldErrors?)` on errors; never call
     `res.status(500)` yourself;
   - call `audit(req, {...})` for anything that changes data.
3. **Route** goes in `src/routes.ts`: wrap the handler in `handle(...)` and add
   `requireAuth`, or `adminOnly` for admin endpoints.
4. **Test** goes in `tests/`.
5. **Frontend:** add a function in `src/api/api.ts` and a React Query hook in
   `src/api/reactQueryHooks/`.

### Add a column type

1. Add it to `COLUMN_TYPES` in `src/types.ts`.
2. Handle it in `coerce()` in `src/schema/validateRecord.ts`, and in
   `formatCell()` / `parseCell()` in `src/jobs/csv.ts`.
3. If it should be sortable or indexable, add it to `INDEXABLE_TYPES` in
   `src/schema/columns.ts`.
4. Frontend: add it to `src/pages/settings/columnTypes.ts`, and add a field
   component plus a case in `FieldRenderer.tsx`.

### Add an app

Apps live in `src/apps/catalog/` (one file per app). Register a new one in
`APPS` in `src/apps/index.ts`. On the web, add its key to `ORDER` in
`AppsPage.tsx` (the order of the "Add an app" list). Add one only when a customer
needs it.

1. Describe its tables with the helpers in `src/apps/dsl.ts` (`text`,
   `choice`, `link`, `user`, `formula`, `autonum`, …). A `link`'s target is a
   table key: `"tasks"` (same app) or `"people.employees"` (another app, which
   must be listed in `needs`).
2. Mark tables that can be left out as optional (the default); the app's
   main table gets `optional: false`.
3. Roles: `managerRole()` plus `staffRole({...})` with everyday rights, and
   `OWN(...)` for personal records.
4. Sample records: give a row `$id: "x"` to link to it with `"@table:x"`.
5. `tests/apps.test.ts` checks the whole catalog (links, needs, formulas).
   Bump `version` when a blueprint changes.

### Add a background job type

1. Write `runSomething(job)` in `src/jobs/`, returning
   `{ result, progress?, fileKey?, fileName? }`.
2. Register it in `HANDLERS` in `src/jobs/worker.ts`, and extend `JobType` in
   `src/repo/jobRepo.ts`.
3. Queue it from a controller with `createJob({...})`.

### Add a setting

1. Add it to `src/config/env.ts`, with a default.
2. Document it in `apps/api/.env.example`.
3. If Docker needs it, add it to the `x-api-env` block in `docker-compose.yml`
   and to the root `.env.example`.

---

## 10. Conventions

- **TypeScript is strict** on the backend. The frontend uses `any` in places;
  lint warns about it but doesn't fail.
- **Errors:**
  - API errors are `{ message, errors? }`;
  - hidden resources return **404**;
  - resources the user can see but lacks permission for return **403**.
- **Never trust the UI for access:** every permission is enforced in the API.
- **SQL:**
  - parameters always go through `$1, $2…`;
  - identifiers (table names) only through `quoteIdent` / `dataTable`;
  - literals in DDL only through `quoteLiteral`.
- **Logging:** use `logger` or `req.log` (pino), never `console.log` in server
  code. Passwords, cookies and authorization headers are redacted
  automatically.
- **No secrets in git:** `.env` files are ignored; only `.env.example` files
  are committed.

# Apps & organization templates: implementation plan

The working plan for **"Add app"** (Projects, HR, CRM…) and **"Pick your
organization"** (Clinic, School, IT…). It also covers the engine features
those apps need.

This is the reference to follow while building. Tick items as they're done,
and add any decision made along the way to the **Decision log** at the
bottom.

**Status key:** `[ ]` todo · `[~]` in progress · `[x]` done

---

## 0. Goal and rules

**Goal.** An admin clicks **Add app → Projects** and gets connected tables:
- Projects, Tasks and Time logs
- choices, totals and roles
- sensible permissions

They can then change any of it like a table they built themselves. Picking
an organization type (Clinic, School…) installs a bundle of apps.

**Rules that apply to every item:**

1. **Minimal, useful, not confusing.** Remove a step rather than add a
   choice. Every new setting needs a good default and must be optional.
   **The test:** can someone who has never used an ERP understand the
   screen without help? If a setting is rarely needed, either decide it
   automatically or leave it out. Cut or simplify any feature that causes
   confusion, even if it's in this plan. I make these calls myself and
   record them in the decision log (the user handed this to me on
   2026-11-11).
2. **Apps create ordinary tables.** Nothing is locked or "system". An
   installed table can be renamed and edited, and its columns removed, like
   any other.
3. **The engine comes before the apps.** An app is only as good as the
   column types behind it (Phase 1). Each engine feature must be useful on
   its own, even with no apps installed.
4. **Existing access rules stay as they are.** These are departments,
   "Visible to", roles and **Own only**. Read
   [WORKFLOW.md](WORKFLOW.md) and `src/auth/access.ts` before changing any
   query.
5. **Same quality bar as before:**
   - backend tests (vitest, `TEST_DATABASE_URL`)
   - `task check` (typecheck + lint, no new warnings)
   - a Playwright walkthrough on a scratch DB, which is deleted afterwards
   - updated docs
   - **No commits unless the user asks.**

**Steps for each item:**
1. Migration, if one is needed (next number: `004_…`).
2. Backend types → validation → repo → controller → route.
3. Tests.
4. Frontend: API → hooks → field input and value → pages.
5. CSV import and export, filters and sorting, audit log formatting. Every
   column type must work in all of these.
6. Update the demo seed if it benefits.
7. Docs: [WORKFLOW.md](WORKFLOW.md) (how it works), and this file's status.

**Where a column type has to be wired in.** Use this checklist for every new
type.

*Backend (`apps/api/src/`):*

| File | What to add |
|---|---|
| `types.ts` | `COLUMN_TYPES`; new `Column` fields |
| `schema/columns.ts` | `normalizeColumn`, `applyColumnUpdate` (allowed type changes) |
| `schema/validateRecord.ts` | coerce and validate |
| `schema/filters.ts` | `kindOf`, `OPS_BY_KIND`, SQL |
| `db/dataTables.ts` | indexes, if needed |
| `jobs/csv.ts`, `exportJob.ts`, `importJob.ts` | format and parse |
| `controllers/records.ts` | list output, e.g. names for ids |

*Frontend (`apps/web/src/`):*

| File | What to add |
|---|---|
| `pages/settings/columnTypes.ts` | label, icon, help |
| `pages/settings/ColumnModal.tsx` | the type's settings |
| `features/records/fields/FieldInput.tsx` | editing |
| `components/ui/FieldValue.tsx` | display |
| `components/FilterBar` | filter operators |
| `utils/auditFormat.ts` | history |

---

## Phase 1: Engine basics (useful without apps)

### 1.1 Choice column `[x]`
Status, priority and type fields appear in almost every table. Today they
are free text, or a link to a separate "statuses" table as a workaround.

**Model.** The new type is `"choice"`. The column gets
`options: { label: string; color: string }[]`, with colours from a fixed
palette. `multiple` is allowed (tags).

**Storage.** The **label** is stored as a string, or an array of strings
when `multiple` is on.

**Validation.** On create, the value must be one of the options.

On update, it is validated only when the value changed. A record that still
holds a removed option keeps it until someone edits that field.

**Editing options** in the column settings: add, rename, recolour, reorder,
remove.
- **Rename** rewrites stored values in the same transaction (an `UPDATE …`
  on JSONB, handling single and array values). The UI shows the count:
  "Renames it on 120 records".
- **Remove** keeps the old values. They show as a grey badge marked
  "(removed)".

**Type changes:**
- **text → choice** builds the options from the existing distinct values.
  This is capped at 50; above that the change is refused with "too many
  different values".
- **choice → text** is always allowed.

This lets existing "Status" text columns be converted in place.

**Filters.** The kind `choice` supports `in`, `notIn`, `isEmpty` and
`isNotEmpty`. The picker shows coloured options.

**Sort.** By **option order** (To do < Doing < Done) using
`array_position(ARRAY[...], data->>col)`. The normal index isn't used; that's
fine for choices.

**CSV.**
- *Export:* the label; several values joined with `;` (the CSV list separator).
- *Import:* matches labels case-insensitively. An unknown value is a row
  error ("'Urgnt' is not an option for Priority").

**UI.**
- *Lists and the detail page:* a coloured badge.
- *Form:* a Select, or a SegmentedControl when there are ≤4 options and it
  fits.
- *Column modal:* an option list editor with drag to reorder.

**Seed.** Convert the status, stage, category, condition, leave type and
priority columns to choice. Drop `task_statuses`, or keep it only if the
board needs it (it won't: the board uses choice).

**Tests:**
- validation, rename rewrite (single and multi), removed option
- text→choice conversion
- filters and sort order
- CSV round trip

### 1.2 Default values `[x]`
These save clicks on every new record.

**Model.** The column gets `default?: unknown`:

| Column type | Allowed default |
|---|---|
| text, number, boolean, choice | a fixed value |
| date | `"today"` or a fixed date |
| user | `"$me"` |
| department | `"$mine"` (only when the viewer has exactly one department; otherwise empty) |

**Where defaults apply:**
- **Form:** the new-record form is pre-filled.
- **Server:** on create, when the key is **absent**. This covers the API and
  CSV import. An explicit empty value is kept as empty.

**Link prefill from the URL.** `RecordFormPage` reads `?<column>=<value>`.
For example, `?project=<id>` pre-fills the Project link. This is needed by
the "+ Add" buttons in the related records panel (1.4) and also lets apps
deep-link.

**UI.** One "Default" field in the column modal, using the type's own input.
For date it adds a "Today" option; for user, "The person creating it".

**Tests:** server applies defaults on create and import; `$me` and `today`
resolve; an explicit empty value is not overridden.

### 1.3 Auto-number column `[x]`
Business documents need references such as `INV-0001`, `PAT-0042` or
`PO-2026-0003`.

**Model.** The new type is `"autonumber"`, with
`autonumber: { prefix: string }`. That's the only setting. Numbers are
zero-padded to 4 digits and simply grow past 9999. The `{YYYY}` token in the
prefix is allowed for blueprints; the UI shows one Prefix box with the
hint "e.g. INV-".

**Storage.** Text. A new table `counters(table_name, column_name, next
BIGINT)` holds the next number. It is incremented with `UPDATE … RETURNING`
inside the insert transaction; the row lock gives a gap-tolerant, unique,
ordered sequence.

**Rules:**
- **Read-only:** not in the form. On the detail page it is shown as "(set
  when saved)".
- **CSV import:** keeps a provided value. If none is given, a number is
  assigned.
- **Adding the column to a table that has records:** existing records are
  backfilled in `created_at` order, as a job for big tables.
- **Search and filter** work as text.
- **The prefix can be changed later.** This affects new records only, and
  the modal says so.

**Tests:**
- 50 concurrent inserts give unique numbers
- backfill order
- import keeps a provided value
- prefix with `{YYYY}`

### 1.4 Related records on the record page `[x]`
This is what makes links feel like an ERP: a Project page lists its Tasks.

**API.** `GET /api/table/:t/:id/related` returns one group for each
`(table, column)` that links to `t`, limited to tables the viewer can
**view**:

```
{ table, tableLabel, column, columnLabel, count, rows }
```
- `rows` holds the first 5, in the child table's display columns.
- Each child table's `recordScope(user, childSchema)` applies (departments
  and Own only), so counts only include what the viewer can see.
- Reverse links come from the schema. `schemaRepo.ts` already finds tables
  linking to a table, for its delete check; reuse that.

**Performance.** Add an expression index for every relation column:
- single value: `(data->>'col')`
- multiple values: GIN on `(data->'col')`

This is done in `db/dataTables.ts → syncColumnIndexes`. It also speeds up
link filters.

**UI** (`RecordDetailPage`):
- One section per group, titled "Tasks · 12", with a compact table of 5
  rows.
- **View all** opens the list with a filter on the link column.
- **+ Add** opens the new-record form with the link pre-filled (1.2), shown
  only with Create permission.
- Groups with no rows are collapsed into a single line: "No time logs yet ·
  Add".

**Tests:** grouping; scope (Own only, departments, tables the user has no
access to are hidden); multiple-value links.

### 1.5 Formula column `[x]`
For example Net pay = basic + allowances − deductions, Days = To − From, and
Amount = qty × rate.

**Model.** The new type is `"formula"`, with
`formula: { expression: string }`. The result type (number, text or date)
is **worked out from the expression**, not chosen by the user.

**Expression language.** A small parser and evaluator,
`src/schema/formula.ts`. It **never uses `eval`**.

| Part | What's supported |
|---|---|
| Column references | `{basic}`, by name |
| Literals | numbers, `"text"` |
| Operators | `+ - * /`, comparisons, `and` / `or` |
| Functions | `ROUND(x, n)`, `MIN`, `MAX`, `ABS`, `IF(cond, a, b)`, `DAYS(to, from)`, `ADD_DAYS(date, n)`, `CONCAT(...)`, `BLANK(x)` |

- `TODAY()` is **not supported**: stored values would go stale.
- Errors such as dividing by zero or a missing value give an empty result,
  never a failed save.

**Computed on save**, on the server, during insert, update and import. The
result is stored in `data`, so it can be sorted, filtered and exported like
any column. Formulas may reference other formulas; cycles are refused when
the formula is saved, and formulas are evaluated in dependency order.

**Changing the expression** recomputes every record. Small tables are done
inline; above about 5,000 records, a background job (a new job kind
`recompute`).

**Safety.**
- **Deleting a column a formula uses is refused:** "Used by formula Net
  pay".
- **Renaming a column's label** is fine, because references use `name`.

**UI.**
- *Column modal:* an expression box with clickable column chips and a "Try
  it" preview against the first record (via
  `POST /api/schema/:t/formula/check`).
- *Form:* shows "Calculated when saved".
- Live preview in the form is a follow-up (3.7).

**Tests:** parser (precedence, functions, errors); cycles; recompute on
expression change; the delete guard; CSV export.

### Phase 1 done when `[x]`
- The demo seed uses all of these:
  - choices for statuses
  - a payroll net-pay formula and a leave days formula
  - auto-numbers for orders, POs and tickets
  - related records on Company, Project and Task pages
- The docs are updated, and the tests and walkthroughs pass.

---

## Phase 2: Apps v1 (blueprints + installer)

### 2.1 Blueprint format `[x]`
Blueprints are **TypeScript files in the repo**, typed and reviewed like
code, under `apps/api/src/apps/`:

```
src/apps/
  types.ts         AppBlueprint, TableBlueprint, BundleBlueprint
  dsl.ts           text(), num(), date(), bool(), choice(), link(), user(), dept(),
                   formula(), rollup(), autonumber(), file(), image(), richtext()
                   (moved out of scripts/seed.ts, which then imports them)
  catalog/
    core.ts        people, customers, products
    projects.ts    hr.ts  payroll.ts  crm.ts  helpdesk.ts
    billing.ts     inventory.ts  expenses.ts  assets.ts
    clinic.ts      school.ts  ngo.ts
  bundles.ts       organization types → app lists
  installer.ts     plan() and install()
  index.ts         registry: all apps and bundles by key
```

```ts
interface AppBlueprint {
  key: string;                 // "projects", stable forever
  version: number;             // bump when the blueprint changes
  name: string; description: string; icon: string;  // Tabler icon name
  needs?: string[];            // app keys installed first, e.g. ["core.people"]
  tables: TableBlueprint[];
  roles?: { name: string; description: string; perms: Record<string /*table key or "*"*/, Permissions> }[];
  sample?: (ctx: SampleCtx) => Record<string /*table key*/, Record<string, unknown>[]>;
}
interface TableBlueprint {
  key: string;                 // "tasks" → full key "projects.tasks"
  name: string;                // preferred table name, e.g. "tasks"
  label: string; description: string;
  optional?: boolean;          // shown unticked-able in the preview (default: true)
  columns: ColumnBlueprint[];  // like Column, but link refs use table keys:
                               // link("project", "Project", "projects.projects")
}
interface BundleBlueprint { key: string; name: string; description: string; icon: string; apps: string[]; }
```

**Static checks** in a test, run over the whole catalog:
- keys are unique
- every link and rollup points to a table in the same app or in an app
  listed in `needs`
- formulas parse
- `needs` has no cycles

### 2.2 Data model `[x]`
**Migration `004_apps.sql`:**

- **`table_schemas` gets two columns:**
  - `blueprint_key TEXT UNIQUE` (nullable), e.g. `"projects.tasks"`
  - `app_key TEXT` (nullable), used to group the sidebar
- **New table `installed_apps`:**

  | Column | Type |
  |---|---|
  | `key` | `TEXT PK` |
  | `version` | `INT` |
  | `installed_at` | `TIMESTAMPTZ` |
  | `installed_by` | `TEXT` |
  | `options` | `JSONB` |
  | `sample_ids` | `JSONB` (table name → record ids) |

`blueprint_key` survives a table rename and column edits. It is how later
apps find and connect to earlier ones. Admins never see it.

### 2.3 Installer `[x]`
`installer.ts` has two functions:

```ts
plan(appKeys: string[], options: InstallOptions): InstallPlan
install(appKeys: string[], options: InstallOptions, user): InstallResult
```

```ts
interface InstallOptions {
  tables?: Record<string /*full key*/, boolean>;   // unticked = false
  departmentIds: string[];                          // share new tables with these
  sampleData?: boolean;
  conflicts?: Record<string /*full key*/, { use: string /*existing table*/ } | "new">;
}
```

**Plan algorithm.** `plan()` is pure apart from reads; the preview shows
exactly this.

1. **Resolve apps.** Expand `needs` recursively and order them
   topologically. Apps that are already installed are marked `installed` and
   skipped.
2. **Work out each table key:**
   - **Reuse** if a table with that `blueprint_key` exists. Its columns are
     never modified.
   - **Skip** if it's unticked. Columns in other new tables that link to it
     are dropped, along with rollups or formulas that depend on them; the
     plan lists what gets dropped.
   - **Otherwise create it.** If the preferred name is taken by a table
     *without* that key, that's a **conflict**. The default is `"new"`
     (name `tasks_2`, label "Tasks (Projects)"), or the admin picks
     **Use my table**. In that case the table is tagged with the key, and
     missing blueprint columns are **added**, never removed or changed.
3. **Map links.** Every link and rollup ref (a table key) becomes the actual
   table name.
4. **Roles.** If a role with the same name exists, permissions for the new
   tables are **added** to it and nothing is removed. Otherwise the role is
   created.

**Install** runs in **one transaction**:
1. Create all new tables with their non-dependent columns.
2. Add link columns.
3. Add rollup and formula columns.
4. Share tables with `departmentIds`.
5. Set `blueprint_key` and `app_key`.
6. Create or extend roles.
7. Insert sample data, if asked, and record its ids.
8. Write an `installed_apps` row and an audit entry: "Installed app
   Projects".

Doing links in a second pass makes self-links (a parent task) and links
between tables in the same app just work. `addColumn`'s check that "linked
table must exist" then passes, because the tables were created in the same
transaction.

**Prerequisite refactor.** `createTable`, `addColumn` and
`updateTableSettings` in `schema/schemaRepo.ts` take an optional `client`,
which has to be threaded through. They must defer `invalidateSchemas()` and
`syncColumnIndexes()` until after commit, because they currently run them
right away. Indexes are created after commit; that's fine.

**Uninstall:** `DELETE /api/apps/:key`.
- **Removed:** only tables the app **created** that no other table links to.
- **Blocked otherwise**, with the reason ("Payroll links to Employees").
- **Kept:** its roles.
- **Confirmation:** the UI asks the admin to type the app name.

**Remove sample data:** `DELETE /api/apps/:key/sample` deletes the recorded
sample ids that still exist.

### 2.4 API `[x]`
All of these are admin only:

| Route | Purpose |
|---|---|
| `GET /api/apps` | catalog: apps and bundles, each with `installed` and version |
| `POST /api/apps/plan` | `{ apps: string[], options }` → InstallPlan, for the preview |
| `POST /api/apps/install` | `{ apps: string[], options }` → InstallResult (created tables, roles, sample counts) |
| `DELETE /api/apps/:key` | uninstall (rules in 2.3) |
| `DELETE /api/apps/:key/sample` | remove sample data |

A bundle is installed by sending its app list.

### 2.5 UI `[x]`
**`pages/settings/AppsPage.tsx`** (Administration → Manage apps) has three sections:
1. **Start from your organization:** bundle cards. This is shown first while
   no apps are installed.
2. **Apps:** cards with an icon, a one-line description and an "Installed"
   badge.
3. **Installed:** version, install date, "Remove sample data" and "Remove
   app".

**Preview drawer.** This is the single install screen.
- **Tables:** a list of checkboxes. Each row shows the label, a one-line
  description and its links ("→ Projects"). Required core tables are shown
  ticked and disabled, with "needed by Tasks".
- **Already have it:** reused tables are shown with "Uses your Employees
  table".
- **Conflicts:** one radio per conflict: "Use my Tasks table" or "Create
  new".
- **Roles to be created**, each with a one-line summary.
- **Visible to:** a department multi-select, defaulting to all departments.
- **Add sample data:** a checkbox, unticked by default.
- **Install**, then a success screen with links to the new tables.

**Sidebar.** Tables are grouped by `app_key` under the app's name. The
shared core tables (People, Companies, Contacts, Products) are grouped under
**"Company"**. Tables from no app stay in "Tables". A group only appears once
there are 2+ groups; with one group the sidebar stays flat. Groups are
collapsible and their state is remembered locally.

**Home page.** An admin with no tables sees an empty-state card: "Set up
your organization → Pick a type". This replaces the plain "Create table"
call to action.

### 2.6 First apps `[x]`
Build **core**, **projects**, **hr**, **crm** and **helpdesk** (outlines in
§5) with realistic sample data of 10–30 rows per table.

### 2.7 Seed on top of apps `[dropped]`
`scripts/seed.ts` installs the apps that cover today's demo tables, then
fills them with its large data generator. The demo then exercises the same
code path as real installs.

Tables that aren't in any app yet stay defined in the seed, until Phase 3
brings in billing, inventory and assets.

### Phase 2 tests
- **Plan:** dependencies; reuse by `blueprint_key`; unticking drops
  dependent columns; conflict naming.
- **Install:** atomic (a failure part-way leaves nothing behind); links
  resolve; roles get created and merged.
- Installing HR after Projects reuses People.
- Uninstall guard and sample removal.
- The catalog static check (2.1).

---

## Phase 3: Connected apps

### 3.1 Roll-up column `[x]`
For example project hours, invoice total, stock on hand, or the number of
open tickets.

**Model.** The new type is `"rollup"`, with:

```
rollup: { from: <child table>, via: <child's link column to this table>,
          fn: "count" | "sum" | "min" | "max" | "avg",
          field?: <child number/date column>,
          where?: { column: <child choice column>, in: string[] } }
```

`where` is optional, e.g. count only tasks whose Status is not Done.

**Stored and recalculated** on every child insert, update and delete, in the
same transaction (`recordRepo` write paths):
- When a child's `via` link changes, both the old and the new parent are
  recalculated.
- Import recalculates once per affected parent after each batch.
- **Chains:** a time log updates a task's hours, which updates a project's
  hours. Changes cascade up through rollups and formulas, to a maximum depth
  of 5; cycles are refused when the column is defined.

**Totals count all child records**, including ones the viewer can't see.
That's documented. It's acceptable for totals, and the related records panel
(1.4) stays scoped.

**Adding or changing a roll-up** recomputes every parent, as a job when the
table is large.

**Tests:** each fn; `where`; a link change moves the total; delete; the
cascade; import; the cycle guard.

### 3.2 Line items (child records inside the parent form) `[x]`
For example invoice lines, PO lines, prescription items and payslip
components.

**Model.** No new column type. A relation column gets a flag,
`inline: true`, meaning "edit these children inside the parent's form". It
goes on the *child's* link column, e.g. `invoice_lines.invoice`.

**API.** On create and update, the parent accepts:

```
_children: { "<child table>": { create: [...], update: [{_id, ...}], delete: [ids] } }
```

This is applied in one transaction, and the server sets the link to the
parent. Validation errors come back per line.

**UI.** In the parent form, an editable grid with one row per child
(add/remove rows). Formulas on the child, such as amount = qty × rate, show
after save in v1, or live once 3.7 lands. Parent roll-ups, such as total =
sum(lines.amount), update on save.

### 3.3 Board view `[x]`
- The list page gets a **Table | Board** toggle. Board is only offered when
  the table has a choice column; its default is the first choice column.
  The view is remembered per table (localStorage).
- **One column per option.** Cards show the primary field plus 2–3 visible
  fields and avatars for User columns.
- **Dragging a card** updates the choice. This is allowed only with Edit
  permission, and optimistic with rollback.
- Filters and search apply to the board too.
- Library: `@dnd-kit` (pin an exact version).

### 3.4 Calendar view `[x]`
- A **Calendar** toggle, offered when the table has a date column.
- **Month and week views.** Each record appears on its date; tables with a
  start and an end date (two date columns) show it as a span.
- Clicking a record opens it. Clicking an empty day opens a new record with
  that date pre-filled (1.2).

### 3.5 More apps `[x]`
**billing**, **inventory**, **payroll**, **expenses** and **assets** (§5).
These use rollups and line items.

### 3.6 Organization bundles `[x]`
**clinic**, **school**, **it**, **retail**, **agency** and **ngo** (§5).
Each comes with sample data that tells a story.

### 3.7 Live formula preview in forms `[x]`
Move `formula.ts` into a tiny shared file copied to the frontend
(`src/lib/formula.ts`). A backend test asserts that the two copies are
identical, when the frontend folder exists. The form then shows formula
values as you type, including inline lines.

---

## Phase 4: Features that set it apart

| # | Feature | Sketch |
|---|---|---|
| 4.1 | **Approvals** `[x]` | A choice option can be marked "only these roles can set it" (e.g. Approved and Rejected → Manager). Others see it disabled. The audit log shows who approved. |
| 4.2 | **Simple automations** `[x]` | "When **Status** becomes **Approved** → set **Approved on** = today / notify **Employee**". A trigger and an action, both picked from lists, with no code. They run in the job worker and are recorded in history. |
| 4.3 | **Notifications** `[x]` | A bell in the header for "assigned to you", "approved" and automation messages. Email is optional, through SMTP settings. |
| 4.4 | **App dashboards** `[x]` | A blueprint can declare a few number tiles and charts, e.g. Projects: open tasks, hours this week, overdue. Shown on the Home page. (Load the `dataviz` skill before building.) |
| 4.5 | **AI blueprint drafts** `[x]` | "We're a 12-person dental clinic with 2 branches" → Claude drafts an `AppBlueprint` as JSON. It's validated by the same static checks and shown in the **same preview**. Because it's only a blueprint, never code, it's safe. Use the latest Claude model, and load the `claude-api` skill before building. |
| 4.6 | **Blueprint export / import** `[ ]` | Export the tables you built as a blueprint JSON, and import one on another install. Lets consultants share setups. Lowest priority; build only if asked. |

---

## Phase 5: People and access made simple

**Why.** Setting up one HR user takes five steps on four pages
(department, app install, role, user, People entry). A user has **one
role**, and every app adds to the same Manager and Staff roles, so nobody
can be a manager in HR and staff in Projects. And because records are
visible per department, a template with departments would hide the front
desk's patients from the doctors.

**The model after this phase, in plain words:**

| Concept | What it decides | Where it's set |
|---|---|---|
| **App access** | What you can do in each app: No access / Staff / Manager | The person's page |
| **Department** | Which team you're in (and, only on tables set that way, which team's records you see) | The person's page |
| **Who sees the records** | Per table: everyone who can use it (default), or each department only its own | Table settings → Access |
| **Visible to** | Which departments see one record (only on "each department" tables) | The record form |

### 5.1 "Who sees the records", per table `[x]`
- `table_schemas.by_department` (migration). **Existing tables: true**, so
  nothing becomes visible that wasn't. **App installs and new tables made
  in the app: false** (not asked when creating; changeable in Access). The
  API keeps `true` when the setting isn't sent.
- **false ("everyone who can use it"):** the role decides; departments
  aren't needed to open the table and don't limit records ("Own only"
  still applies). New records still note the creator's department.
- **true:** exactly today's behaviour.
- The UI hides "Visible to" (form, list, record page) on shared tables.
- Table settings → Access: two radio options with one-line explanations.

### 5.2 Several roles per person, and per-app roles `[x]`
- `user_roles (user_id, role_id)` for extra roles; `users.role_id` stays the
  main role (Admin, a custom role, or **Member**: no rights of its own).
- Rights add up. **Safe merge:** an action counts as "own only" unless a
  role grants it without "own only"; if any granted action is own-only, the
  whole table is own-only for that person (never more than any role gave).
- **Each app gets its own roles** on install: "Projects · Manager",
  "Projects · Staff" (`roles.app_key`, `roles.app_level`). New installs no
  longer extend the shared Manager/Staff roles; those keep working for the
  people who have them.
- **Already installed apps** get their roles once, at start-up (idempotent),
  with the same rights; approval options also accept the app's Manager role.
- Approvals check all of a person's roles.
- Removing an app removes its roles.

### 5.3 App access on the person `[x]`
- Users page → person: **App access**, one row per app in the launcher
  (Company is one row): No access / Staff / Manager.
- Roles page: app roles listed under "From apps" (editable, not deletable);
  custom roles stay for special cases.

### 5.4 Organization types bring departments `[x]`
- Each organization type lists starter departments (Clinic: Front desk,
  Doctors, Nursing, Pharmacy, Accounts). The install drawer shows them,
  ticked and renamable; existing departments with the same name are reused.

### 5.5 One "Add person" form `[x]`
- Name, login (optional), department, app access. With the People
  directory installed, it also creates their Employees entry, linked to
  the login.
- Employees' **Team** becomes **Department**, filled in from the login's
  department when a login is picked.

### Phase 5 done when `[x]`
- A new admin picks "Clinic", gets departments, apps and roles, and adds a
  receptionist and a doctor from one form each; both see the same patients.
- Existing installs behave exactly as before until someone changes a setting.

---

## 5. App catalog (outlines)

Notation:
- `name: type`, with `[req]` for required and `→ table` for a link
- `= formula`, and `Σ` for a roll-up
- `#` for an auto-number, `◇` for a choice (options listed)

The outlines are starting points, so refine them while building. Every app
is **Visible to** the departments chosen at install.

### core (installed automatically when needed)
- **core.people** (Employees)

  | Columns |
  |---|
  | name [req] |
  | account: user (the login account; links HR data to Own only) |
  | photo: image |
  | email, phone |
  | team: department |
  | job_title |
  | joined_on: date |
  | status ◇ Active / On leave / Left |

- **core.customers.companies:** name [req], industry ◇, city, website,
  phone, email, owner: user, notes.
- **core.customers.contacts:** name [req], company → companies, email,
  phone, job_title.
- **core.products** (Products & services):

  | Columns |
  |---|
  | name [req], sku |
  | type ◇ Product / Service |
  | category ◇ |
  | price, cost |
  | unit ◇ pcs / hour / kg / box |
  | active: bool |
  | photo: image |

**People rule** (from earlier decisions):
- "Who" columns in apps (Assignee, Owner, Logged by, Requester) are **User**
  columns. They work with Own only and "Me" filters without HR.
- HR, Payroll and Leave link to **core.people**, which connects to logins
  through `account`.

### projects  *(needs: —)*

**Projects**

| Columns |
|---|
| code # PRJ-0001 |
| name [req] |
| customer → companies (optional table) |
| owner: user |
| status ◇ Planned / Active / On hold / Done |
| start, due: date |
| budget: number |
| hours Σ sum(tasks.hours) |
| open_tasks Σ count(tasks where status ≠ Done) |
| description: richtext |

**Tasks**

| Columns |
|---|
| title [req] |
| project → projects |
| status ◇ To do / Doing / Review / Done (default To do) |
| priority ◇ Urgent / High / Normal / Low (default Normal) |
| assignee: user (default me) |
| start, due: date |
| estimate_h: number |
| hours Σ sum(time_logs.hours) |
| parent → tasks |
| description: richtext |

**Time logs**

| Columns |
|---|
| task → tasks [req] |
| person: user (default me) |
| date (default today) |
| hours [req] |
| note |

**Roles:**
- **Project lead:** all rights on all three tables.
- **Project member:** tasks view/create/edit with own; time logs
  view/create/edit with own; projects view.

### hr  *(needs: core.people)*
- **Leave requests:**

  | Columns |
  |---|
  | ref # LV-0001 |
  | employee → people [req] |
  | type ◇ Casual / Sick / Earned / Unpaid |
  | from, to: date [req] |
  | days = DAYS({to}, {from}) + 1 |
  | status ◇ Pending / Approved / Rejected (4.1: approval by Manager) |
  | reason |

- **Attendance:** employee → people, date (default today), status ◇
  Present / Absent / Half day / Leave / WFH, check_in, check_out (text),
  note.
- **Holidays:** name, date, optional: bool.

**Roles:**
- **HR manager:** all.
- **Employee:** leave (create, view own) and attendance (view own). Own
  works through the Employee link (see the Own only rule in §7).

### payroll  *(needs: hr)*
- **Salary structures:** employee → people, basic, allowances, deductions,
  effective_from: date.
- **Payslips:**

  | Columns |
  |---|
  | ref # PAY-{YYYY}-0001 |
  | employee → people [req] |
  | month: date |
  | basic, allowances, deductions, bonus |
  | gross = {basic}+{allowances}+{bonus} |
  | net = {gross}-{deductions} |
  | status ◇ Draft / Paid |
  | paid_on: date |

  Country tax and statutory deductions are **out of scope**; companies add
  their own formula columns.
- **Roles:** Payroll officer; Employee (payslips: view own).

### crm  *(needs: core.customers)*
- **Deals:**

  | Columns |
  |---|
  | title [req] |
  | company → companies |
  | contact → contacts |
  | stage ◇ Lead / Qualified / Proposal / Won / Lost (board) |
  | value |
  | probability % |
  | weighted = {value}*{probability}/100 |
  | expected_close: date |
  | owner: user (default me) |

- **Activities:** type ◇ Call / Email / Meeting / Note, about_company →
  companies, deal → deals, date (default today), by: user (default me),
  notes.
- **Roles:** Sales manager (all); Sales rep (deals own, companies and
  contacts view/create/edit).

### helpdesk  *(needs: core.customers optional)*
- **Tickets:**

  | Columns |
  |---|
  | number # TCK-0001 |
  | subject [req] |
  | customer → companies |
  | requester: user |
  | assignee: user |
  | priority ◇ |
  | status ◇ New / Open / Waiting / Resolved / Closed (board) |
  | category ◇ |
  | opened (default today) |
  | resolved_on |
  | details: textarea |
  | attachments: files |

- **Roles:** Support lead (all); Agent (tickets view/create/edit; delete
  off).

### billing  *(needs: core.customers, core.products)*
- **Invoices:**

  | Columns |
  |---|
  | number # INV-{YYYY}-0001 |
  | customer → companies [req] |
  | date (default today) |
  | due: date |
  | subtotal Σ sum(lines.amount) |
  | tax_pct (default 0) |
  | tax = ROUND({subtotal}*{tax_pct}/100, 2) |
  | total = {subtotal}+{tax} |
  | paid Σ sum(payments.amount) |
  | balance = {total}-{paid} |
  | status ◇ Draft / Sent / Paid / Overdue |

- **Invoice lines** (inline): invoice → invoices, product → products,
  description, qty (default 1), rate, amount = {qty}*{rate}.
- **Payments:** invoice → invoices, date, amount, method ◇ Cash / Bank / Card
  / UPI / Other, ref.
- **Quotes + quote lines:** same shape as invoices; status ◇ Draft / Sent /
  Accepted / Declined.
- **Roles:** Accountant (all); Sales (quotes create, invoices view).

### inventory  *(needs: core.products)*
- **Suppliers:** name, contact, email, phone, city, rating ◇ 1–5.
- **Purchase orders:** number # PO-0001, supplier → suppliers, date,
  expected, total Σ sum(lines.amount), status ◇ Draft / Ordered / Received /
  Cancelled.
- **PO lines** (inline): po → purchase_orders, product → products, qty,
  rate, amount = {qty}*{rate}.
- **Stock moves:** product → products, date, type ◇ In / Out, qty (always
  positive), reference. There is no "Adjust" type: a correction is an In or
  an Out with a note. Received PO lines can add In moves later (Phase 4
  automation).
- **Products** get added: hidden `stock_in` Σ sum(moves.qty where type = In)
  and `stock_out` Σ sum(moves.qty where type = Out), then the visible
  `stock = {stock_in}-{stock_out}`. Also `reorder_level` and
  `low = IF({stock} < {reorder_level}, "Low", "")`.

### expenses  *(needs: —)*
- **Claims:**

  | Columns |
  |---|
  | ref # EXP-0001 |
  | claimant: user (default me) |
  | date |
  | category ◇ Travel / Food / Supplies / Other |
  | amount |
  | receipt: file |
  | status ◇ Submitted / Approved / Rejected / Reimbursed (approval 4.1) |

- **Roles:** Staff (own only, create); Manager / Finance (all).

### assets  *(needs: —)*
- **Assets:**

  | Columns |
  |---|
  | tag # AST-0001 |
  | name |
  | category ◇ |
  | assigned_to: user |
  | purchased_on |
  | warranty_until |
  | value |
  | condition ◇ |
  | serial |

- **Maintenance:** asset → assets, date, type ◇, cost, notes.

### Organization bundles
| Bundle | Apps | Extra tables (own app file) |
|---|---|---|
| **Clinic** | core, hr, billing, inventory (as pharmacy) | **clinic** app (below) |
| **School / coaching** | core.people, hr | **school** app (below, has its own Fees) |
| **IT / Software** | projects, helpdesk, crm, hr, assets | — |
| **Retail / Trading** | crm, billing, inventory, hr | — |
| **Agency / Services** | crm, projects, billing, expenses | — |
| **NGO** | projects (as programs), expenses, hr | **ngo** app (below) |

**clinic:**
- **Patients:**

  | Columns |
  |---|
  | mrn # PAT-0001 |
  | name [req] |
  | dob: date |
  | gender ◇ |
  | phone |
  | blood_group ◇ |
  | allergies: textarea |
  | address |

- **Appointments** (calendar): patient → patients, doctor: user, date,
  time, reason, status ◇ Booked / Arrived / Done / Cancelled / No-show.
- **Consultations:** appointment → appointments, patient → patients,
  doctor: user, notes: richtext, diagnosis, follow_up: date.
- **Prescription items** (inline): consultation → consultations, medicine
  → products, dose, frequency ◇, days.
- **Invoice link:** invoices get an optional patient → patients.
- **Roles:**
  - Doctor: consultations own (via doctor), patients view.
  - Receptionist: patients and appointments all, invoices create.

**school:**
- **Students:** admission # STU-0001, name, dob, class → classes, guardian
  name, phone, photo.
- **Classes:** name, teacher: user, room.
- **Subjects:** name, class → classes, teacher: user.
- **Attendance:** student → students, date, status ◇.
- **Exams:** name, class → classes, date.
- **Marks** (inline under exam): exam → exams, student → students, subject
  → subjects, marks, max (default 100), pct = {marks}/{max}*100.
- **Fees:** fee # FEE-0001, student → students [req], term ◇ (e.g. Term 1 /
  Term 2 / Term 3), amount, due: date, paid_amount, balance =
  {amount}-{paid_amount}, status ◇ Due / Partly paid / Paid. This is its own
  table, not billing invoices: schools don't think in "customers" and
  "companies".

**ngo:** Donors, Donations (donor → donors, amount, date, program →
projects), Volunteers, Volunteer hours (Σ on volunteers).

---

## 6. Order of work (quick view)

1. Phase 1 (engine basics):
   - 1.1 Choice
   - 1.2 Defaults + URL prefill
   - 1.3 Auto-number
   - 1.4 Related records + relation indexes
   - 1.5 Formula
   - then convert the seed to use them
2. Phase 2 (apps v1):
   - 2.3 prerequisite: transaction-aware `schemaRepo`
   - 2.1 Blueprint format
   - 2.2 Data model
   - 2.3 Installer
   - 2.4 API
   - 2.5 UI
   - 2.6 First apps
   - 2.7 Seed on apps
3. Phase 3 (connected apps):
   - 3.1 Roll-up
   - 3.2 Line items
   - 3.3 Board
   - 3.4 Calendar
   - 3.5 More apps
   - 3.6 Bundles
   - 3.7 Live formula preview
4. Phase 4, in any order, based on user feedback.
5. Phase 5 (people and access): 5.1 → 5.5 in order.

---

## 7. Decided rules (were open questions)

- **"Own only" follows one link.** A record is yours if:
  - you created it, or
  - you're picked in one of its User columns, or
  - **it links to a record where you're picked in a User column.**

  For example, a leave request whose Employee is the People row with
  Account = you; or a task in a project whose Owner is you. Only **one hop**,
  and only through User columns. "Created by" doesn't carry across a link,
  so an HR clerk who created everyone's People rows doesn't see everyone's
  payslips.

  This needs no extra column and no new setting. Users read it as "records
  about me". It's implemented in `scopeCondition` as an `EXISTS` on the
  linked table, using the relation indexes from 1.4. It's built at 2.6 with
  tests for the HR clerk case.
- **Stock on hand:** In and Out moves with a positive qty and two hidden
  roll-ups (see inventory). There's no negative numbers for users to get
  wrong.
- **School fees:** a dedicated Fees table in the school app (see school).
- **Blueprint upgrades:** none. The installed version is recorded, and that's
  it. There's no "upgrade app" button: once a company edits its tables, those
  tables are theirs. New tables from a newer blueprint can be added by
  installing again later, which reuses existing tables by key.
- **Sidebar grouping:** shared core tables go under **"Company"**. Groups
  only show with 2+ groups.

---

## 8. Out of scope (say so in docs, don't half-build)

- Double-entry accounting (ledger, trial balance, tax filings)
- Country-specific statutory payroll (PF/ESI/PAYE/withholding tables)
- Manufacturing (BOM, MRP, work orders)
- Auto-upgrading customized apps

---

## Decision log

Add one line per decision: date, item, what was decided, why.

- 2026-11-11: **Plan created.** Apps create ordinary editable tables;
  connections use a hidden `blueprint_key`; "who" columns are User columns;
  formulas and roll-ups are stored and computed on save; blueprints are
  TypeScript files in the repo.
- 2026-11-11: **The user handed design calls to me.** The rule: nobody using
  the app should be confused by too many options. I decide open questions
  myself and cut or simplify features that cause confusion, and log each
  decision here.
- 2026-11-11: **Open questions decided** (§7). Own only follows one link
  through User columns; stock uses In/Out with two hidden roll-ups; school
  has its own Fees table; no blueprint upgrades; core tables are grouped as
  "Company".
- 2026-11-11: **Fewer settings.** Auto-number has only a prefix (4 digits,
  growing). A formula's result type is inferred. Stock moves have no
  "Adjust" type. Blueprint export/import is lowest priority.
- 2026-11-11: **1.1 Choice column done.**
  - Options are reordered with up/down arrows, not drag: no new library, and
    it works with the keyboard and on phones.
  - Text → Choice needs no option editing: the options are built from the
    column's values, and the editor is hidden during the switch.
  - Choice ↔ Text only. *Allow several choices* is fixed after creation, like
    the other "several" switches.
  - The "Indexed" switch is now hidden for types that can't be indexed,
    instead of showing a disabled switch with a badge: one fewer thing to
    read.
  - "is none of" includes empty values, so "Status is none of Done,
    Cancelled" means "open work".
  - CSV keeps the existing `;` list separator.
  - Demo: status, stage, category, priority, condition and channel columns
    are choices. Priority 1–4 became Urgent/High/Normal/Low. The
    `task_statuses` table is gone, so the demo has 17 tables.
    TASK_MANAGEMENT_GUIDE.md was rewritten to match: no lookup table, no "All
    staff" department needed.
- 2026-11-11: **1.2 Default values done.**
  - A date default is **"today" only**, not a fixed date: a fixed date is
    almost never wanted, and it would be one more input to explain.
  - Date, User and Department defaults are a single switch each ("New
    records start with today's date / the person creating them / the
    creator's department"). Other types get one "Default value" box.
  - An empty CSV cell stays empty; only columns missing from the file get
    the default. This matches the API rule: sent empty = empty.
  - Choice options get an id as soon as they're typed, so the default
    follows a rename made in the same dialog.
  - Demo: statuses start at their first step, priority at Normal, "Opened",
    "Order date", "Spent on" and time-log dates at today, and support
    tickets are "Assigned to" whoever creates them.
- 2026-11-11: **1.3 Auto-number done.**
  - `{YYYY}` restarts numbering every year: the counter is keyed by period,
    which is what people expect from INV-2026-0001.
  - Backfill runs as **one SQL `UPDATE`** instead of a background job. It's
    fast enough even for very large tables, and there's no job to explain.
  - Imported numbers are kept and the counter skips past them, so later
    numbers never collide.
  - The type is fixed (like links): no conversion to or from Auto-number.
  - When an auto-number is the first column it becomes the record's title
    (e.g. "SO-24600").
  - Demo: Order #, PO #, leave Reference and Asset tag are auto-numbers.
  - Also: choice columns get wider list cells so their badges aren't cut
    off.
- 2026-11-11: **1.4 Related records done.**
  - **No new endpoint.** The app already gets every table the user can see,
    with its columns, so reverse links are worked out in the browser. Each
    group then uses the existing list endpoint with a link filter, which
    reuses departments, Own only, labels and names instead of duplicating
    them.
  - Link and User columns always get a GIN index on `data -> col`. Link
    filters became `?|`, which matches single and multiple links and uses
    that index.
  - Phones show the name plus one column, with no sideways scrolling.
  - A table linking to itself is shown as "Tasks (Parent task)".
- 2026-11-11: **1.5 Formula done, and Phase 1 complete.**
  - **Formulas compile to SQL** instead of using a JavaScript evaluator. One
    implementation computes values on save, on import and for whole tables,
    in one `UPDATE`. That's fast enough for any table size, so there's **no
    `recompute` job**.
  - Empty number *fields* count as 0 in arithmetic (spreadsheet-like); empty
    results of functions stay empty, so `DAYS(empty dates) + 1` is empty,
    not 1.
  - References use the column **name**. A label typed by mistake gets "Did
    you mean {basic}?".
  - Formula and auto-number columns have fixed types, and are never
    required.
  - The column settings check the formula **live as you type** (no "Try it"
    button to press), with "Insert a field" buttons.
  - Also: a refused confirm action (e.g. deleting a column a formula uses)
    no longer leaves an unhandled error in the page. The "Column name" label
    is no longer monospace.
  - Demo: Net pay and leave Days are formulas; IT and support tickets got
    "Ticket #" auto-numbers.
- 2026-11-11: **Phase 2 done (apps v1).**
  - **Shared roles.** A user has exactly one role, so apps don't bring their
    own ("Project member", "Employee"): they'd clash for someone in two apps.
    Every app adds to **Manager** and **Staff**, which grow as apps are
    added.
  - **No schemaRepo refactor.** The installer writes all of an app's table
    definitions in one transaction itself (`ensureDataTable(name, client)`),
    so links between new tables resolve and a failure leaves nothing behind.
    Record writes now ensure their table inside the caller's transaction:
    this fixed a self-deadlock.
  - **Core apps are ordinary apps**: People directory, Customers, Products.
    Their tables are grouped as "Company" in the sidebar. Groups only show
    when there are 2+; there are no collapse toggles.
  - **Own only follows one link** through User columns (the §7 rule); HR's
    Staff role relies on it.
  - **Sample records** go only into tables made by that install. Named
    samples are stored (`sample_refs`, migration 007) so a later app's
    samples can link to them.
  - In the preview, always-included tables show a check mark, not a
    disabled checkbox; checkboxes respond at once; tables keep catalog order.
  - Migrations are 006/007, not "004" (004/005 were used in Phase 1).
  - **2.7 dropped.** The demo seed keeps its own 17 richer tables at large
    volumes, because it shows a whole trading company. Apps are covered by
    `tests/apps.test.ts` (catalog checks, plan, install, conflicts, Own-only
    link, uninstall, samples) and by the browser walkthrough on an empty
    database.
- 2026-11-11: **3.1 Roll-ups done** (shown to users as **"Total"**).
  - They compile to a SQL subquery in the same statement as formulas.
    Formulas can use totals, and there's **no background job** (one UPDATE
    for a whole table).
  - The condition supports **is any of** and **is none of** ("open tasks" =
    status is none of Done), behind an "Only some of them…" link so the
    simple case stays simple.
  - Totals over a table survive column changes there; deleting what a total
    needs is refused.
  - Projects app v2: "Hours logged" on tasks and projects, and "Open tasks"
    on projects.
  - Also: the column-name input lost its monospace font, which clipped
    underscores.
- 2026-11-11: **3.2 Line items done**, with the **Billing** app (part of 3.5).
  - The relation flag is `inline`. In the UI it's a switch on link columns:
    "Edit these inside the Invoices form".
  - Error keys are `<table>.create|update.<i>.<column>`, so a new line and a
    changed line never share a key.
  - `?raw=1` on the list endpoint returns stored ids for editing.
  - Deleting a parent deletes its lines. Records saved together keep their
    order (`clock_timestamp()`): line order on an invoice matters.
  - Lines tables are hidden from the sidebar; they live inside their parent.
  - All field inputs got a compact, label-less mode (React context) for grid
    rows.
  - Totals over formulas of another table (Subtotal = sum of lines' Amount)
    now resolve, even when both tables are created together.
- 2026-11-11: **3.3–3.6 done.**
  - **Board:** no drag library. The browser's own drag and drop works on
    desktop, and a *Move to* menu on each card covers keyboards and phones.
    Lanes come from the choice options; the "No value" lane only shows when
    it has cards. 50 cards per lane, with accurate counts.
  - **Calendar:** single dates only (no start–end spans): simpler, and it
    covers appointments, due dates and leave. Phones get a day list instead
    of a cramped grid.
  - View, group-by and date column live in the address, so they can be
    shared and bookmarked.
  - **Record names:** a text column names a record before an auto-number
    ("Anu Thomas", not "PAT-0001"). Cards show title · first link ("10:30 ·
    Anu Thomas").
  - **Apps:** Payroll, Inventory & purchasing, Expense claims and Assets.
    Inventory adds stock on hand to Products through the new `extend`, which
    is removed with the app. Clinic and School have their own Bills and Fees,
    because patients and students aren't "companies". Plus Donors &
    programmes (NGO).
  - **Organization types:** Clinic, School, NGO and Retail were added, and
    the existing ones gained the new apps. Bundle keys are prefixed `org-`
    after a clash ("clinic" was both an app and a bundle).
- 2026-11-11: **3.7 Live preview done, and Phase 3 complete.**
  - Formulas are SQL, so there's no JavaScript copy to keep in sync (the
    plan's idea). Instead, a **preview save** runs the real save with
    `?preview=1` and rolls it back. Line amounts, totals and formulas update
    as you type, from exactly the code a real save uses.
  - A preview skips required-field checks (the form is half filled), but
    keeps permission, choice and link checks.
- 2026-11-11: **4.1–4.3 done.**
  - **Approvals** are per option (`roles`), enforced by the server for every
    way of saving. Admins are always allowed, and an unchanged value never
    blocks an edit.
  - **Automations run in the save's transaction**, not the job worker (the
    plan's idea): immediate, all-or-nothing, nothing to monitor. They don't
    trigger each other.
  - **The "you were assigned" notification is built in** (User columns), so
    there's nothing to set up for the most common case.
  - **Email is left out:** in-app only for now, which means no SMTP settings
    to explain and no new dependency.
  - Apps ship approval steps (leave, expense claims, payslips) and
    automations (leave approved/rejected, claim approved/paid, ticket
    resolved, payslip paid).
- 2026-11-11: **4.4 Dashboards done.**
  - A **KPI row of counts** per app, plus at most **one breakdown** drawn as
    single-hue horizontal bars with counts and a share tooltip (one series,
    so no legend), following the dataviz method. There are no deltas or
    trends, because there's no earlier period to compare against.
  - Counts come from the normal list endpoint, so every person sees their
    own numbers. Tiles whose columns a company removed are left out.
  - Filters gained `$today` for relative dates. Saved "Overdue" links stay
    right.
- 2026-11-11: **4.5 AI drafts done; Phase 4 complete except 4.6** (blueprint
  export/import: build only if asked, per the plan).
  - Claude (`claude-opus-5-5`, effort medium) returns a **simplified draft**
    through structured output (Zod schema), not a full blueprint. The server
    builds the blueprint itself, so the AI can't produce anything the
    installer doesn't already validate.
  - Server-side refusal fallback (`fallbacks: "default"`) is on, as the
    Claude API guidance recommends.
  - Imperfect drafts degrade gracefully: links to missing tables and broken
    formulas are dropped one by one. The admin always sees the normal
    preview.
  - **Optional and off by default.** Without `ANTHROPIC_API_KEY` there's a
    one-line hint and no network call. Each draft is one billed request.
  - New dependencies: `@anthropic-ai/sdk` and `zod` (API only).
- 2026-11-13: **"Visible to" several departments** (asked for: a project
  for two departments). Not in the original plan.
  - One picker, not two: the existing "Visible to" became a multi-select. A
    separate "Shared with" field next to it would have been confusing.
  - Stored as `department_id` (first, keeps its foreign key) plus
    `shared_department_ids TEXT[]` (migration 009, GIN index). Existing
    records keep their single department.
  - Any of the table's departments may be picked, but one must be the
    user's own; re-sending an unchanged list is always allowed.
  - "Visible to" now shows on every table with several departments, also for
    people in just one of them (they can share a record with the other).
  - Records added from a related list, and an app's sample records, start
    visible to all the relevant departments.
  - CSV: names separated by `;`, like other multi-values.
  - Deleting a department removes it from shared lists too; when it was a
    record's first department, the next one takes its place.
- 2026-11-13: **App launcher** (asked for: one app at a time in the sidebar).
  Not in the original plan.
  - Only from **3 apps** on. With fewer, a launcher is an extra click for
    nothing, so the sidebar lists every table as before. It's decided per
    person, by the apps they can see.
  - **The current app follows the page,** not a mode you switch into, so a
    link into another app's record never leaves you in the wrong menu.
    Opening an "Also used" table (Employees from HR) keeps the app you came
    from.
  - **Company is one app:** People, Customers and Products are shared by
    most apps, so they're one tile instead of three.
  - **Your own tables are "My tables",** the last tile.
  - **Dashboards moved to each app's page** in launcher mode (Home would
    otherwise be a long scroll of every app's counts). The heading is
    dropped when an app page has one dashboard.
  - The admin item "Apps" became **Manage apps**, so it isn't confused
    with the new Apps list in the sidebar.
- 2026-11-13: **Phase 5 (people and access) done** (asked for: less setup,
  per-app access, departments from templates).
  - **"Who sees the records", per table.** Everyone who can use it is the
    default for apps and new tables; every existing table keeps "each
    department only its own", so nothing became visible that wasn't.
    Without this, a clinic's doctors couldn't see the front desk's patients.
  - **Several roles per person:** a main role (Admin, the new **Member**, or
    a custom role) plus app roles. Merge rule: where any role shows the
    whole table, own-only extras from others are dropped, never widened.
  - **Each app has its own Manager/Staff roles.** New installs no longer
    extend the shared Manager/Staff roles; people who have those keep them.
    Apps installed earlier got their roles once, at start-up, and their
    approval steps also accept the app's Manager.
  - **App access** on the person: one row per launcher app (Company is one
    row), No access / Staff / Manager. The install drawer no longer lists
    roles or asks "Visible to"; it says to give people access afterwards.
  - **Organization types bring starter departments,** editable as tags in
    the preview; existing names are reused.
  - **Add person** also makes the People directory entry (opt-out tick).
    The directory's "Team" is now **Department** (existing installs too, if
    the label was still "Team") and is filled in from the login's
    department when a login is picked; never overwritten.

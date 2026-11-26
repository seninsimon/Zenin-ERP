// The text behind every "?" (HelpTip), in one place so every screen explains
// things the same way. Keep each one short: a title, 1–3 plain sentences,
// and one example. UI_GUIDELINES.md §9 "Help (?)" says where they belong.

export type Help = { title: string; text: string[]; example?: string };

export const HELP = {
  users: {
    title: "How access works",
    text: [
      "Each person gets a level in each app: No access, Staff or Manager (or a level you added). Staff do the everyday work; Managers see everything in the app and approve.",
      "Administrators can do everything, including these settings.",
    ],
    example: "A nurse is Staff in Clinic. The head nurse is Manager.",
  },
  administrator: {
    title: "Administrator",
    text: [
      "Can do everything: every app, every record, and all of Administration.",
      "Keep it to one or two people. Everyone else gets what they need through App access.",
    ],
  },
  levels: {
    title: "Access levels",
    text: [
      "Every app has levels: Staff and Manager, and any you add. A level says what its people can do in each of the app's tables.",
      "You give someone a level in each app with App access on the Users page.",
    ],
    example: "Add an Accountant level to Billing that can view and edit invoices, but not delete them.",
  },
  appAccess: {
    title: "App access",
    text: [
      "Staff do the everyday work. In personal tables, such as leave requests or expense claims, they see only their own records.",
      "Managers see and change everything in the app, and approve requests.",
    ],
    example: "Staff in HR can ask for leave. A Manager in HR approves it and sees everyone's.",
  },
  departments: {
    title: "Departments",
    text: [
      "The teams people work in. On most tables they change nothing: app access decides.",
      "They only hide records on a table that is split by department (Tables → the table → Access). There, each department sees only its own records.",
    ],
    example: "Two branches share one Sales table, and each branch sees only its own sales.",
  },
  roles: {
    title: "Roles",
    text: [
      "A role is a list of what people may do in each table: view, add, edit or delete.",
      "Each app brings its own Staff and Manager roles. You give them to people with App access on the Users page, so most companies never need to make a role here.",
    ],
  },
  accessAi: {
    title: "Change access with AI",
    text: [
      "Say what you want in plain words: \"Let Senin edit leave requests\", or ask \"Who can see Payroll?\".",
      "The AI suggests the smallest change and shows exactly what it does for each person. Nothing changes until you press Apply. It can't make anyone an Administrator.",
    ],
    example: "\"Give Asha the same as Ravi in Sales, but she can't delete orders.\"",
  },
  fieldLevels: {
    title: "Who sees this field",
    text: [
      "Limit a field to some levels of this app, such as Managers. Others don't see it anywhere: not in lists, records, search, exports, history or emails.",
      "Formulas and totals worked out from it are hidden from them too. The field that names each record can't be limited.",
    ],
    example: "Salary, for Managers only. Staff still see the rest of the employee record.",
  },
  spreadsheet: {
    title: "Spreadsheet view",
    text: [
      "On for every table: click a cell and type, Enter saves; paste rows from Excel or Google Sheets; Ctrl+Z undoes. Several people can work at once.",
      "Every value is checked like a normal save, and people change only what their level allows. If two people change the same cell, nothing is overwritten: the second is asked.",
      "Turn it off for tables where nobody should change many records at once.",
    ],
    example: "Off for Payslips; on for a price list or stock count people update all day.",
  },
  sameAccess: {
    title: "Same access as…",
    text: ["Copies another person's departments and app levels into this form. Nothing is saved until you press Save.", "It never copies Administrator."],
  },
  ownOnly: {
    title: "Own records only",
    text: [
      "They see only their own records in this table: ones they added, or where they're picked in a person field such as Employee or Assigned to.",
      "Use it for personal records. Leave it off for people who look after everyone's.",
    ],
    example: "Staff see only their own leave requests. HR, without this tick, sees everyone's.",
  },
  whoSeesRecords: {
    title: "Who sees the records",
    text: [
      "Everyone with access: everyone who can use this table sees all its records. This is right for most tables.",
      "Split by department: each record is visible only to the departments it's shared with, so teams keep their records apart.",
    ],
    example: "Kochi and Thrissur branches share one Sales table, and each sees only its own sales.",
  },
  visibleTo: {
    title: "Visible to",
    text: [
      "The departments that can see this record. Pick more than one to share it.",
      "One of them must be yours, so you don't lose the record yourself.",
    ],
    example: "A project for both Engineering and Design is visible to both.",
  },
  apps: {
    title: "Apps",
    text: [
      "An app is a set of connected tables for one kind of work, such as HR or Billing, with its own Staff and Manager access.",
      "Everything an app adds is yours to change: rename fields, add columns, remove what you don't need.",
    ],
  },
  tableApp: {
    title: "App",
    text: [
      "Every table belongs to an app. People get into an app with App access on the Users page: Staff or Manager.",
      "Managers of the app can do everything in its tables. You choose what Staff can do.",
    ],
    example: "Put Purchase orders in a Purchasing app, and give your buyers Staff in Purchasing.",
  },
  ownApps: {
    title: "Your own apps",
    text: [
      "Make an app for each kind of work you track yourself, such as Purchasing or Deliveries. Then add tables to it from Tables & columns.",
      "Each app has its own Staff and Manager, so you give access in one place: App access on the Users page.",
    ],
  },
  relation: {
    title: "Links to another table",
    text: [
      "Each record here points to a record in the other table, and that record shows a list of everything that links to it.",
      "Turn on \"Allow several records\" when one record can point to many.",
    ],
    example: "A task links to its project. The project's page then lists all its tasks.",
  },
  formula: {
    title: "Formula",
    text: [
      "Works out a value from other fields of the same record, and updates by itself. Nobody types in it.",
      "Write field names in {curly brackets}. IF(condition, then, else) picks between two values; DAYS(end, start) counts days between dates.",
    ],
    example: "{quantity} * {price} gives the line amount.",
  },
  rollup: {
    title: "Total",
    text: [
      "Adds up, counts or averages the records in another table that link to this one. It updates by itself when they change.",
      "\"Only where\" counts just some of them.",
    ],
    example: "An invoice's total is the sum of Amount on its invoice lines.",
  },
  whoCanChoose: {
    title: "Who can choose this",
    text: [
      "Makes this option an approval step: only people with the chosen levels can set it. Leave it empty to let anyone who can edit.",
      "Admins can always choose it. Nobody else can approve a record that is their own.",
    ],
    example: "Only HR Managers can set a leave request's Status to Approved.",
  },
  lockRecord: {
    title: "Lock the record",
    text: [
      "When a record reaches this status, nobody can change or delete it: not in the form, the spreadsheet, an import or a bulk change. Its line items are locked too.",
      "Managers of the app (and admins) see Reopen on it: they give a reason, choose the status it goes back to, and then it can be changed. The reason is kept in the audit log.",
    ],
    example: "Lock a leave request at Approved, so its dates can't change after approval.",
  },
  automations: {
    title: "Automations",
    text: [
      "Simple rules that run by themselves when a record is added or a field changes: tell someone, or set a field.",
      "They run for every change, from any screen, import or bulk update.",
    ],
    example: "When Status becomes Approved, tell the person who asked.",
  },
} satisfies Record<string, Help>;

export type HelpTopic = keyof typeof HELP;

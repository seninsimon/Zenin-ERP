// The text behind every "?" (HelpTip), in one place so every screen explains
// things the same way. Keep each one short: a title, 1–3 plain sentences,
// and one example. UI_GUIDELINES.md §9 "Help (?)" says where they belong.

export type Help = { title: string; text: string[]; example?: string };

export const HELP = {
  users: {
    title: "How access works",
    text: [
      "Each person gets an access level per app: No access, Staff or Manager. Staff do the everyday work; Managers see everything in the app and approve.",
      "Admins can do everything, including these settings.",
    ],
    example: "A nurse is Staff in Clinic. The head nurse is Manager.",
  },
  appAccess: {
    title: "App access",
    text: [
      "Staff do the everyday work. In personal tables, such as leave requests or expense claims, they see only their own records.",
      "Managers see and change everything in the app, and approve requests.",
    ],
    example: "Staff in HR can ask for leave. A Manager in HR approves it and sees everyone's.",
  },
  mainRole: {
    title: "Role",
    text: [
      "Admin: can do everything, including Administration. Keep this to one or two people.",
      "Member: what they can do comes only from App access below. Choose this for almost everyone.",
      "A role you made on the Roles page adds the rights you gave it there.",
    ],
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
      "Makes this option an approval step: only people with the chosen roles can set it. Leave it empty to let anyone who can edit.",
      "Admins can always choose it. Nobody else can approve a record that is their own.",
    ],
    example: "Only HR Managers can set a leave request's Status to Approved.",
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

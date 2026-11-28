import {
  IconActivity,
  IconApps,
  IconBuilding,
  IconDatabaseCog,
  IconDatabaseImport,
  IconHistory,
  IconHome,
  IconMail,
  IconMessages,
  IconPalette,
  IconSparkles,
  IconSettings,
  IconShieldLock,
  IconTransfer,
  IconUsers,
  type Icon,
} from "@tabler/icons-react";

// Navigation used by the sidebar, the command palette and breadcrumbs.

export type NavItem = { label: string; to: string; icon: Icon; description?: string };

export const MAIN_NAV: NavItem[] = [
  { label: "Home", to: "/", icon: IconHome, description: "Overview of your tables and activity" },
  { label: "Imports & exports", to: "/jobs", icon: IconTransfer, description: "CSV jobs and downloads" },
];

// Settings (admins): one page, grouped by what you're trying to do. The same
// list feeds the Settings page, the command palette and each page's breadcrumb.
export type SettingsGroup = { title: string; description: string; items: NavItem[] };
export const SETTINGS_PATH = "/settings";
export const SYSTEM_STATUS = "#system-status"; // opens a window, not a page
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: "People & access",
    description: "Who can sign in, and what they can see and do",
    items: [
      { label: "Users", to: "/settings/users", icon: IconUsers, description: "Add people, reset passwords, give app access" },
      { label: "Access levels", to: "/settings/roles", icon: IconShieldLock, description: "What Staff, Managers and other levels can do in each app" },
      { label: "Departments", to: "/settings/departments", icon: IconBuilding, description: "Teams, and which records each team sees" },
    ],
  },
  {
    title: "Apps & data",
    description: "What you keep in Zenin",
    items: [
      { label: "Manage apps", to: "/settings/apps", icon: IconApps, description: "Add ready-made apps: HR, Billing, CRM and more" },
      { label: "Tables & columns", to: "/settings/tables", icon: IconDatabaseCog, description: "Your own tables and their fields" },
      { label: "Bring your data", to: "/settings/migration", icon: IconDatabaseImport, description: "Move data in from Excel, CSV or another system" },
    ],
  },
  {
    title: "Your organization",
    description: "How Zenin looks and talks to people",
    items: [
      { label: "Branding", to: "/settings/branding", icon: IconPalette, description: "Your organization's name and logo" },
      { label: "Email", to: "/settings/email", icon: IconMail, description: "Notifications and password links by email" },
      { label: "Chat", to: "/settings/chat", icon: IconMessages, description: "Team chat and comments on records" },
      { label: "AI", to: "/settings/ai", icon: IconSparkles, description: "Draft apps, Ask Zenin and more, with Claude, Gemini or ChatGPT" },
    ],
  },
  {
    title: "Safety",
    description: "Keeping an eye on things",
    items: [
      { label: "Audit log", to: "/settings/audit", icon: IconHistory, description: "Who changed what, and when" },
      { label: "System status", to: SYSTEM_STATUS, icon: IconActivity, description: "How busy the server is: processor, memory, disk" },
    ],
  },
];

// every settings page, for the command palette (System status is a window, not a page)
export const ADMIN_NAV: NavItem[] = [
  { label: "Settings", to: SETTINGS_PATH, icon: IconSettings, description: "Everything an administrator sets up" },
  ...SETTINGS_GROUPS.flatMap((g) => g.items).filter((i) => i.to !== SYSTEM_STATUS),
];

// the breadcrumb at the top of every settings page: "Settings › Users"
export const settingsCrumb = { label: "Settings", to: SETTINGS_PATH };

// URL of a table's record list / a record
export const tablePath = (table: string) => `/table/${encodeURIComponent(table)}`;
export const recordPath = (table: string, id: string) => `${tablePath(table)}/${encodeURIComponent(id)}`;
// Where a notification leads: a record, or a chat conversation.
export const noticePath = (table: string, id: string) => (table === "__chat" ? `/chat?c=${encodeURIComponent(id)}` : recordPath(table, id));
export const newRecordPath = (table: string) => `${tablePath(table)}/new`;
export const editRecordPath = (table: string, id: string) => `${recordPath(table, id)}/edit`;

// Readable name for a table identifier ("purchase_orders" -> "Purchase orders")
export const tableTitle = (name: string) => {
  const spaced = name.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

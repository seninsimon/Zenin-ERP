import { billing } from "./catalog/billing.js";
import { clinic } from "./catalog/clinic.js";
import { customers, people, products } from "./catalog/core.js";
import { crm } from "./catalog/crm.js";
import { expenses } from "./catalog/expenses.js";
import { hr } from "./catalog/hr.js";
import { inventory } from "./catalog/inventory.js";
import { payroll } from "./catalog/payroll.js";
import { projects } from "./catalog/projects.js";
import { school } from "./catalog/school.js";
import type { AppBlueprint } from "./types.js";

// Every app the installer knows. Kept to what most businesses need; apps for
// one trade (Clinic, School) are the first ones customers asked for. More
// come when customers ask (or they draft their own with AI).
export const APPS: AppBlueprint[] = [
  people,
  customers,
  products,
  projects,
  hr,
  payroll,
  crm,
  billing,
  inventory,
  expenses,
  clinic,
  school,
];
export const APP_BY_KEY = new Map(APPS.map((a) => [a.key, a]));

// Apps that share a sidebar group show as one app in the launcher.
const GROUPS: Record<string, { icon: string; description: string }> = {
  Company: { icon: "IconBuildingSkyscraper", description: "People, customers and products that your other apps share" },
};

// "My tables": the app of tables with no app_key (see ownApps.ts)
export const MY_TABLES = "my-tables";

// The launcher entry ("app") a table belongs to: its app, or the group its
// app is in ("Company"). No app_key = My tables. null for unknown apps.
export function launcherApp(appKey: string | null): { key: string; name: string; icon: string; description: string } | null {
  const app = APP_BY_KEY.get(appKey ?? MY_TABLES);
  if (!app && !appKey) return { key: MY_TABLES, name: "My tables", icon: "IconTable", description: "Tables you built yourself" };
  if (!app) return null;
  if (app.group && app.group !== app.name) {
    const group = GROUPS[app.group];
    return {
      key: app.group.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: app.group,
      icon: group?.icon ?? app.icon,
      description: group?.description ?? app.description,
    };
  }
  return { key: app.key, name: app.name, icon: app.icon, description: app.description };
}

// "projects" + "tasks" -> "projects.tasks"; refs inside an app may leave out the app
export const fullKey = (app: AppBlueprint, key: string) => (key.includes(".") ? key : `${app.key}.${key}`);

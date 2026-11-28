import { useState } from "react";
import { Box, Group, SimpleGrid, Stack, Text, TextInput, ThemeIcon, Title, UnstyledButton } from "@mantine/core";
import { IconChevronRight, IconSearch } from "@tabler/icons-react";
import { Link } from "react-router-dom";

import { Page, PageHeader } from "../../components/ui/Page";
import { SystemStatus } from "../../features/SystemStatus";
import { SETTINGS_GROUPS, SYSTEM_STATUS, type NavItem } from "../../layout/nav";
import classes from "./settings.module.css";

// Settings (admins): everything an administrator sets up, on one page,
// grouped by what you're trying to do, with a box to find one by name.
// Each settings page leads back here ("Settings › Users").

function SettingCard({ item, onOpenStatus }: { item: NavItem; onOpenStatus: () => void }) {
  const body = (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <ThemeIcon variant="light" size={36} radius="md" aria-hidden>
        <item.icon size={20} stroke={1.75} />
      </ThemeIcon>
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Text fw={600} size="sm">
          {item.label}
        </Text>
        <Text size="xs" c="dimmed">
          {item.description}
        </Text>
      </Box>
      <IconChevronRight size={16} color="var(--mantine-color-dimmed)" aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
    </Group>
  );
  return item.to === SYSTEM_STATUS ? (
    <UnstyledButton className={classes.settingCard} onClick={onOpenStatus}>
      {body}
    </UnstyledButton>
  ) : (
    <UnstyledButton component={Link} to={item.to} className={classes.settingCard}>
      {body}
    </UnstyledButton>
  );
}

export default function SettingsPage() {
  const [search, setSearch] = useState("");
  const [statusOpen, setStatusOpen] = useState(false);
  const words = search.trim().toLowerCase();
  const groups = SETTINGS_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !words || `${i.label} ${i.description} ${g.title}`.toLowerCase().includes(words)),
  })).filter((g) => g.items.length);

  return (
    <Page title="Settings" breadcrumbs={[{ label: "Settings" }]} width="wide">
      <PageHeader title="Settings" description="Set up Zenin for your organization. Only administrators see this." />
      <Stack gap="xl">
        <TextInput
          placeholder="Find a setting… (e.g. password, logo, email)"
          aria-label="Find a setting"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          maw={420}
          data-autofocus
        />
        {groups.length ? (
          groups.map((g) => (
            <section key={g.title} aria-labelledby={`settings-${g.title}`}>
              <Title order={4} id={`settings-${g.title}`}>
                {g.title}
              </Title>
              <Text size="sm" c="dimmed" mb="sm">
                {g.description}
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
                {g.items.map((item) => (
                  <SettingCard key={item.to} item={item} onOpenStatus={() => setStatusOpen(true)} />
                ))}
              </SimpleGrid>
            </section>
          ))
        ) : (
          <Text size="sm" c="dimmed">
            No setting matches “{search.trim()}”. Try another word, or press Ctrl+K to search everything.
          </Text>
        )}
      </Stack>
      <SystemStatus opened={statusOpen} onClose={() => setStatusOpen(false)} />
    </Page>
  );
}

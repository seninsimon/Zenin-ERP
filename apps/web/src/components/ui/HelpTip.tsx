import { useState, type ReactNode } from "react";
import { ActionIcon, Group, Popover, Stack, Text } from "@mantine/core";
import { IconHelpCircle } from "@tabler/icons-react";
import { HELP, type HelpTopic } from "../../lib/help";

// A small "?" that opens a short explanation (lib/help.ts). It opens on
// click, not hover, so it works on phones; Esc or a click outside closes it.
// Use it only where a setting isn't obvious (UI_GUIDELINES.md §9).
// withinPortal={false} when it sits inside another pop-up, so a click on the
// note doesn't count as a click outside that pop-up and close it.
export function HelpTip({ topic, size = 16, withinPortal = true }: { topic: HelpTopic; size?: number; withinPortal?: boolean }) {
  const help = HELP[topic];
  const [opened, setOpened] = useState(false);
  return (
    <Popover opened={opened} onChange={setOpened} width={300} position="bottom-start" withArrow shadow="md" radius="md" withinPortal={withinPortal} trapFocus returnFocus>
      <Popover.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={size + 6}
          radius="xl"
          aria-label={`Help: ${help.title}`}
          // Esc pressed before focus has moved into the note: close the note,
          // not the dialog around it
          data-mantine-stop-propagation={opened || undefined}
          onKeyDown={(e) => {
            if (e.key === "Escape" && opened) {
              e.stopPropagation();
              setOpened(false);
            }
          }}
          onClick={(e) => {
            // inside a label or a clickable header: don't toggle that too
            e.preventDefault();
            e.stopPropagation();
            setOpened((o) => !o);
          }}
        >
          <IconHelpCircle size={size} stroke={1.7} />
        </ActionIcon>
      </Popover.Target>
      {/* Esc closes the note only, not a dialog it sits in */}
      <Popover.Dropdown
        data-mantine-stop-propagation
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
      >
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            {help.title}
          </Text>
          {help.text.map((line) => (
            <Text key={line} size="sm">
              {line}
            </Text>
          ))}
          {"example" in help && help.example && (
            <Text size="sm" c="dimmed">
              <Text span fw={600} inherit>
                For example:
              </Text>{" "}
              {help.example}
            </Text>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

// A field label with a "?" after it: label={<WithHelp topic="formula">Formula</WithHelp>}
export function WithHelp({ topic, children, withinPortal }: { topic: HelpTopic; children: ReactNode; withinPortal?: boolean }) {
  return (
    <Group component="span" gap={2} wrap="nowrap" display="inline-flex" align="center" style={{ verticalAlign: "middle" }}>
      {children}
      <HelpTip topic={topic} size={14} withinPortal={withinPortal} />
    </Group>
  );
}
